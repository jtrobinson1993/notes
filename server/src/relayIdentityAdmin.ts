// The two operator commands that CREATE a relay identity — and the one thing
// that makes this design work: **they never run on the relay.**
//
// `init-identity` and `rotate-online-key` are pure functions of their arguments.
// They open no database, read no DATA_DIR, and talk to no server. An operator
// runs them on their own laptop (from a checkout, or straight out of the Docker
// image), and what comes back is a *bundle* — the root PUBLIC key, the online
// keypair and the root-signed delegation — plus, once, the root PRIVATE key,
// which is printed to the terminal and then dropped.
//
// That is why the module is separate from relayIdentity.ts: nothing on the
// serving path can even import a function that mints a delegation, because the
// only way to mint one is to hold the root private key, and the root private
// key never reaches a relay process. A full compromise of the server therefore
// yields no way to forge a rotation — which is checkable by looking at the
// database: there is no column that could hold the key (see relay_root in
// db.ts, and the schema assertion in server/test/relayIdentity.test.ts).

import type { DB } from './db.js';
import { fingerprintB64url } from './relayAuth.js';
import {
  BUNDLE_FORMAT,
  BUNDLE_FORMAT_VERSION,
  generateEd25519,
  parseRootPrivateKey,
  RelayIdentityError,
  signDelegation,
  type Delegation,
  type IdentityBundle,
} from './relayIdentity.js';

/** Default delegation lifetime. Long enough that a self-hosted relay is not a
 *  maintenance treadmill, short enough that a delegation an operator has lost
 *  control of (root key lost, operator gone) stops being honored. Clients refuse
 *  an expired delegation, so this is a real deadline — see spec/relay.md. */
export const DELEGATION_DEFAULT_DAYS = 365;
/** Warn from here on, at boot and in `status`. */
export const DELEGATION_WARN_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;

function days(value: number | undefined): number {
  const n = value ?? DELEGATION_DEFAULT_DAYS;
  if (!Number.isFinite(n) || n <= 0) throw new RelayIdentityError('--days must be a positive number');
  return n;
}

function assembleBundle(rootPubKey: string, online: { pubkey: string; privkey: string }, delegation: Delegation): IdentityBundle {
  return {
    format: BUNDLE_FORMAT,
    formatVersion: BUNDLE_FORMAT_VERSION,
    rootPubKey,
    rootFingerprint: fingerprintB64url(Buffer.from(rootPubKey, 'base64')),
    onlineKey: online,
    delegation,
  };
}

export interface MintedIdentity {
  bundle: IdentityBundle;
  /** pkcs8 DER, base64. Printed once by the CLI, never written to disk by us. */
  rootPrivKey: string;
}

export interface InitOptions {
  days?: number;
  now?: number;
}

/**
 * One command, one machine, no state: mint the ROOT and the first ONLINE
 * keypair, sign delegation v1 with the root, and hand back the bundle plus the
 * root private key.
 *
 * The root private key exists only in this process's memory and in whatever the
 * caller does with it (the CLI prints it to the terminal). It is not in the
 * bundle, so copying the bundle to the server does not copy the key — that is
 * the property the whole hierarchy is built on.
 */
export function initIdentity(opts: InitOptions = {}): MintedIdentity {
  const now = opts.now ?? Date.now();
  const lifetime = days(opts.days);
  const root = generateEd25519();
  const online = generateEd25519();
  const { key: rootKey } = parseRootPrivateKey(root.privkey);
  const delegation = signDelegation(rootKey, {
    onlineKey: online.pubkey,
    version: 1,
    issuedAt: now,
    notAfter: now + lifetime * DAY_MS,
  });
  return { bundle: assembleBundle(root.pubkey, online, delegation), rootPrivKey: root.privkey };
}

export interface RotateOptions {
  /** The root private key, read by the CLI from stdin or an env var. Used to
   *  sign one delegation and then dropped; nothing writes it anywhere. */
  rootPrivKey: string;
  /** The bundle being replaced, when the operator still has it. Supplies both
   *  the current version and — the useful part — the root public key to check
   *  the supplied private key against, so a wrong key fails here rather than
   *  silently producing a bundle the relay will reject. */
  previous?: IdentityBundle;
  /** The relay's current delegation version, for an operator who no longer has
   *  the old bundle (`GET /api/relay/info` and `relay -- status` both show it). */
  currentVersion?: number;
  days?: number;
  now?: number;
}

/**
 * Revoke the current online key by delegating to a fresh one at version+1.
 *
 * Anti-rollback is a two-sided guarantee: this refuses to *mint* a version that
 * does not move forward, and the relay refuses to *install* one (db.ts), so a
 * superseded delegation cannot be replayed to reinstate a stolen online key
 * even if the attacker keeps a copy of the old bundle.
 */
export function rotateOnlineKey(opts: RotateOptions): IdentityBundle {
  const now = opts.now ?? Date.now();
  const lifetime = days(opts.days);
  const { key: rootKey, pubKey } = parseRootPrivateKey(opts.rootPrivKey);

  if (opts.previous && pubKey !== opts.previous.rootPubKey) {
    throw new RelayIdentityError(
      "That is not the root key this identity was created with.\n" +
        `  bundle's root public key:   ${opts.previous.rootPubKey}\n` +
        `  supplied key's public half: ${pubKey}\n\n` +
        'Rotating with the wrong key would produce a delegation the relay refuses (and every\n' +
        'client would too). Check you pasted the right key out of your password manager.',
    );
  }
  if (opts.currentVersion !== undefined) {
    if (!Number.isSafeInteger(opts.currentVersion) || opts.currentVersion < 1) {
      throw new RelayIdentityError('--current-version must be the relay\'s current delegation version (a positive integer)');
    }
    if (opts.previous && opts.currentVersion < opts.previous.delegation.version) {
      throw new RelayIdentityError(
        `--current-version ${opts.currentVersion} is older than the bundle's own delegation ` +
          `(v${opts.previous.delegation.version}). A delegation version only ever increases — ` +
          'refusing to mint one that could roll the relay back to a revoked online key.',
      );
    }
  }
  const current = Math.max(opts.previous?.delegation.version ?? 0, opts.currentVersion ?? 0);
  if (current < 1) {
    throw new RelayIdentityError(
      'Rotation needs to know the delegation version the relay is on, so the new one can\n' +
        'strictly exceed it. Either pass the bundle you are replacing:\n\n' +
        '  npm run relay -- rotate-online-key --in relay-identity.json\n\n' +
        'or, if you no longer have it, read the version off the running relay\n' +
        '(`GET /api/relay/info` → delegation.version, or `relay -- status`) and pass it:\n\n' +
        '  npm run relay -- rotate-online-key --current-version 3\n',
    );
  }

  const online = generateEd25519();
  const delegation = signDelegation(rootKey, {
    onlineKey: online.pubkey,
    version: current + 1,
    issuedAt: now,
    notAfter: now + lifetime * DAY_MS,
  });
  return assembleBundle(pubKey, online, delegation);
}

/** Human-readable identity state for `status` (and the boot-time warning). The
 *  one function here that reads the relay's database — it only reads. */
export function identitySummary(db: DB, now = Date.now()): string {
  const rootPubKey = db.getRelayRootPubkey();
  if (!rootPubKey) {
    return 'Identity:          NOT INSTALLED — install a bundle from `init-identity` (the relay will not start)\n';
  }
  const keys = db.listRelayOnlineKeys();
  const current = keys[keys.length - 1];
  if (!current) return 'Identity:          root installed, NO DELEGATION — reinstall the identity bundle\n';
  const left = Math.floor((current.notAfter - now) / DAY_MS);
  const expiry =
    left < 0
      ? `EXPIRED ${-left}d ago — clients refuse it; rotate now`
      : left <= DELEGATION_WARN_DAYS
        ? `${left}d left — renew with \`rotate-online-key\``
        : `${left}d left`;
  return (
    `Root fingerprint:  ${fingerprintB64url(Buffer.from(rootPubKey, 'base64'))}\n` +
    `Online key:        v${current.version} (${current.pubkey})\n` +
    `Delegation:        ${expiry}\n`
  );
}
