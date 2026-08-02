// The relay's identity: an OFFLINE root key that delegates to an ONLINE signing
// key (spec/relay.md § "Relay identity: an offline root and an online signing
// key"). This module is the shared core — the format, the signing bytes, the
// verification, the identity *bundle* the operator installs, and the boot-time
// load. The operator commands that *create* an identity live in
// relayIdentityAdmin.ts and never run on the relay at all.
//
// Why the split exists: the relay must sign a key-transparency (KT) root every
// time the directory changes, so *some* private key has to sit on the server.
// When that same key is also the one clients pin, a server breach is terminal —
// the attacker signs forged KT roots, and the operator cannot revoke the anchor
// using the anchor. So the pinned anchor (the ROOT) signs exactly one kind of
// statement, a DELEGATION naming the current online key, and its private half
// never touches the server: it is generated on the operator's own machine and
// only its public half is ever shipped here. A breach then costs the online
// key, which a new root-signed delegation revokes.
//
// ---------------------------------------------------------------------------
// The signed bytes (mirror this exactly in any other implementation)
//
//   accord-relay-delegation|v1|{rootFingerprint}|{onlineKey}|{version}|{issuedAt}|{notAfter}
//
//   rootFingerprint  base64url(sha256(raw 32-byte root public key))
//   onlineKey        raw 32-byte Ed25519 public key, STANDARD base64
//   version          decimal integer, strictly increasing per relay (anti-rollback)
//   issuedAt         decimal integer, milliseconds since the epoch
//   notAfter         decimal integer, milliseconds since the epoch
//
// UTF-8, no trailing newline, signed with Ed25519 (pure, no prehash) by the
// root key. The `accord-relay-delegation|v1` prefix is the domain separator: it
// is distinct from every other signature this relay makes or checks — KT roots
// sign `kt-root|{root}|{prev}` and device auth signs `{nonce}|{fingerprint}` —
// so no signature can be lifted from one context into another. The root
// fingerprint is inside the signed bytes, so a delegation is bound to the root
// that issued it and cannot be replayed onto a different relay.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from 'node:crypto';
import type { DB } from './db.js';
import { ed25519PublicKey, fingerprintB64url } from './relayAuth.js';

export const DELEGATION_CONTEXT = 'accord-relay-delegation|v1';

/** Filename the relay looks for inside DATA_DIR at boot. */
export const BUNDLE_FILENAME = 'relay-identity.json';
/** `format` marker inside the bundle, so a wrong file fails with a sentence. */
export const BUNDLE_FORMAT = 'accord-relay-identity';
export const BUNDLE_FORMAT_VERSION = 1;

/** A root-signed statement naming the relay's current online signing key. */
export interface Delegation {
  /** Monotonic anti-rollback counter: only ever increases. */
  version: number;
  /** Raw 32-byte Ed25519 public key, standard base64. */
  onlineKey: string;
  issuedAt: number;
  notAfter: number;
  /** Ed25519 signature by the ROOT key over `delegationPayload`, base64. */
  signature: string;
}

/**
 * The file an operator installs on the relay — everything the relay may hold,
 * and nothing else. There is deliberately no root private key field: the whole
 * design is that the relay cannot mint a delegation, and a bundle that could
 * carry the root key would put it back on the server via the front door.
 * `parseIdentityBundle` rejects a bundle that carries one anyway.
 */
export interface IdentityBundle {
  format: typeof BUNDLE_FORMAT;
  formatVersion: number;
  /** Raw 32-byte root public key, standard base64 — the pinned anchor. */
  rootPubKey: string;
  /** base64url(sha256(rootPubKey)); redundant, and verified on parse. */
  rootFingerprint: string;
  /** The delegated signing key, both halves (pkcs8 DER base64 for the private). */
  onlineKey: { pubkey: string; privkey: string };
  delegation: Delegation;
}

/** The relay identity as the server uses it at runtime. */
export interface RelayIdentity {
  /** Raw root public key, standard base64 — what `identityPubKey` serves. */
  rootPubKey: string;
  /** base64url(sha256(root pubkey)) — what clients pin (`identityFingerprint`). */
  rootFingerprint: string;
  /** The current delegation (highest version). */
  delegation: Delegation;
  /** Every delegation this root has issued, ascending — needed to verify KT
   *  roots published before a rotation. */
  delegations: Delegation[];
  /** Version of the current online key; stamped onto each KT root it signs. */
  onlineKeyVersion: number;
  /** The online private key, for signing KT roots. */
  onlineSigningKey: KeyObject;
}

export class RelayIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayIdentityError';
  }
}

/** Where the relay looks for its identity bundle: `RELAY_IDENTITY_FILE` if set,
 *  otherwise the conventional path inside DATA_DIR. */
export function identityBundlePath(dataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.RELAY_IDENTITY_FILE?.trim();
  return override ? override : join(dataDir, BUNDLE_FILENAME);
}

/** What an operator sees when the relay has no identity and no bundle to
 *  ingest. Actionable on purpose: the old code silently minted a key here,
 *  which is exactly the behavior this design removes. */
export function relayIdentityMissing(bundleFile: string): string {
  return [
    'This relay has no identity installed, so it will not start.',
    '',
    `It looked for an identity bundle at:  ${bundleFile}`,
    '',
    'Create one ON YOUR OWN MACHINE (it needs no database and no DATA_DIR):',
    '',
    '  npm run relay -- init-identity',
    '  (no checkout? run it straight from the image, writing to a directory you mount:',
    '   docker run --rm -v "$PWD:/out" <image> npm run relay -- init-identity --out /out/relay-identity.json)',
    '',
    'It prints the ROOT PRIVATE KEY once — store it in a password manager, it is',
    'never written to disk. Then copy the relay-identity.json it wrote to the path',
    'above and start the relay again. The bundle holds the root PUBLIC key only, so',
    'a break-in on this server cannot forge a new delegation.',
  ].join('\n');
}

/** Raw 32-byte public key (standard base64) from a private key. */
export function rawPublicKeyOf(privateKey: KeyObject): string {
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer;
  return spki.subarray(spki.length - 32).toString('base64');
}

/** Parse an operator-supplied root private key: base64 pkcs8 DER (what
 *  `init-identity` prints, whitespace tolerated) or the same thing as PEM.
 *  Throws `RelayIdentityError` on anything else — never a raw crypto error,
 *  which tends to leak nothing useful to an operator. */
export function parseRootPrivateKey(text: string): { key: KeyObject; pubKey: string } {
  const trimmed = text.trim();
  if (!trimmed) throw new RelayIdentityError('no root private key supplied');
  let key: KeyObject;
  try {
    key = trimmed.includes('-----BEGIN')
      ? createPrivateKey({ key: trimmed, format: 'pem' })
      : createPrivateKey({
          key: Buffer.from(trimmed.replace(/\s+/g, ''), 'base64'),
          format: 'der',
          type: 'pkcs8',
        });
  } catch {
    throw new RelayIdentityError('root private key is not a base64 pkcs8 (or PEM) Ed25519 key');
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new RelayIdentityError(
      `root private key must be Ed25519, got ${key.asymmetricKeyType ?? 'unknown'}`,
    );
  }
  return { key, pubKey: rawPublicKeyOf(key) };
}

/** A fresh Ed25519 keypair as the two encodings this codebase stores. */
export function generateEd25519(): { pubkey: string; privkey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return {
    pubkey: spki.subarray(spki.length - 32).toString('base64'),
    privkey: (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64'),
  };
}

/** The exact bytes a delegation signs. See the header comment. */
export function delegationPayload(
  rootFingerprint: string,
  d: Pick<Delegation, 'onlineKey' | 'version' | 'issuedAt' | 'notAfter'>,
): Buffer {
  return Buffer.from(
    `${DELEGATION_CONTEXT}|${rootFingerprint}|${d.onlineKey}|${d.version}|${d.issuedAt}|${d.notAfter}`,
  );
}

/** True if `d` is shaped like a delegation with sane, in-range fields. Shape
 *  errors are refused before any signature check so a malformed record can
 *  never reach the verifier as, say, `version: "1"` or a 16-byte key. */
export function isWellFormedDelegation(d: unknown): d is Delegation {
  const c = d as Partial<Delegation> | null;
  if (!c || typeof c !== 'object') return false;
  if (!Number.isSafeInteger(c.version) || (c.version as number) < 1) return false;
  if (!Number.isSafeInteger(c.issuedAt) || !Number.isSafeInteger(c.notAfter)) return false;
  if ((c.notAfter as number) <= (c.issuedAt as number)) return false;
  if (typeof c.onlineKey !== 'string' || Buffer.from(c.onlineKey, 'base64').length !== 32) return false;
  if (typeof c.signature !== 'string' || Buffer.from(c.signature, 'base64').length !== 64) return false;
  return true;
}

/** Verify a delegation against the pinned ROOT public key. Fails closed on a
 *  malformed record, a wrong root, or a single tampered byte. */
export function verifyDelegation(rootPubKeyB64: string, d: unknown): d is Delegation {
  if (!isWellFormedDelegation(d)) return false;
  try {
    const raw = Buffer.from(rootPubKeyB64, 'base64');
    return edVerify(
      null,
      delegationPayload(fingerprintB64url(raw), d),
      ed25519PublicKey(raw),
      Buffer.from(d.signature, 'base64'),
    );
  } catch {
    return false;
  }
}

/** Sign a delegation with the root private key. The only thing the root ever
 *  signs. */
export function signDelegation(
  rootPrivateKey: KeyObject,
  fields: Pick<Delegation, 'onlineKey' | 'version' | 'issuedAt' | 'notAfter'>,
): Delegation {
  const rootFp = fingerprintB64url(Buffer.from(rawPublicKeyOf(rootPrivateKey), 'base64'));
  const signature = edSign(null, delegationPayload(rootFp, fields), rootPrivateKey).toString('base64');
  return { ...fields, signature };
}

/** True once `notAfter` has passed. Clients refuse an expired delegation, so the
 *  relay warns about one long before it bites (see relay-index.ts). */
export function isExpired(d: Delegation, now = Date.now()): boolean {
  return d.notAfter <= now;
}

/**
 * Parse + fully verify an identity bundle. Every check that can be made without
 * knowing the relay's history is made here, so `installIdentityBundle` only has
 * to decide *whether this relay accepts it*, not *whether it is coherent*:
 *
 *  • it is the right kind of file, at a format version we understand;
 *  • the delegation is signed by the root the bundle names (so a bundle whose
 *    delegation was swapped in transit is refused, not installed);
 *  • the private half really is the key the delegation delegates to;
 *  • it carries no root private key — the relay must never be handed one.
 */
export function parseIdentityBundle(text: string): IdentityBundle {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new RelayIdentityError('the relay identity bundle is not valid JSON');
  }
  if (!raw || typeof raw !== 'object') throw new RelayIdentityError('the relay identity bundle is not an object');
  const b = raw as Record<string, unknown>;
  if (b.format !== BUNDLE_FORMAT) {
    throw new RelayIdentityError(
      `not a relay identity bundle (expected "format": "${BUNDLE_FORMAT}") — ` +
        'this is the file `npm run relay -- init-identity` writes',
    );
  }
  if (b.formatVersion !== BUNDLE_FORMAT_VERSION) {
    throw new RelayIdentityError(
      `relay identity bundle format version ${String(b.formatVersion)} is not supported ` +
        `(this relay understands ${BUNDLE_FORMAT_VERSION}) — upgrade the relay`,
    );
  }
  // A bundle is not allowed to carry the root private key even by accident: the
  // one property this design rests on is that it does not exist on the server.
  for (const forbidden of ['rootPrivKey', 'rootPrivateKey', 'rootKey']) {
    if (forbidden in b) {
      throw new RelayIdentityError(
        `the identity bundle contains a "${forbidden}" field. A bundle must NEVER carry the root ` +
          'private key — that key belongs in your password manager, not on the relay. Refusing it.',
      );
    }
  }
  if (typeof b.rootPubKey !== 'string' || Buffer.from(b.rootPubKey, 'base64').length !== 32) {
    throw new RelayIdentityError('the identity bundle has no valid 32-byte rootPubKey');
  }
  const rootPubKey = Buffer.from(b.rootPubKey, 'base64').toString('base64');
  const rootFingerprint = fingerprintB64url(Buffer.from(rootPubKey, 'base64'));
  if (b.rootFingerprint !== rootFingerprint) {
    throw new RelayIdentityError(
      'the identity bundle\'s rootFingerprint does not match its rootPubKey — the file has been altered',
    );
  }
  const online = b.onlineKey as { pubkey?: unknown; privkey?: unknown } | undefined;
  if (
    !online ||
    typeof online.pubkey !== 'string' ||
    typeof online.privkey !== 'string' ||
    Buffer.from(online.pubkey, 'base64').length !== 32
  ) {
    throw new RelayIdentityError('the identity bundle has no valid onlineKey keypair');
  }
  if (!verifyDelegation(rootPubKey, b.delegation)) {
    throw new RelayIdentityError(
      "the identity bundle's delegation is not signed by the root key it names — refusing it",
    );
  }
  const delegation = b.delegation;
  if (delegation.onlineKey !== online.pubkey) {
    throw new RelayIdentityError(
      'the identity bundle\'s delegation names a different key than the online keypair it ships',
    );
  }
  let parsedPriv: KeyObject;
  try {
    parsedPriv = createPrivateKey({
      key: Buffer.from(online.privkey, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
  } catch {
    throw new RelayIdentityError('the identity bundle\'s online private key is unreadable');
  }
  if (parsedPriv.asymmetricKeyType !== 'ed25519' || rawPublicKeyOf(parsedPriv) !== online.pubkey) {
    throw new RelayIdentityError(
      'the identity bundle\'s online private key does not match its public half',
    );
  }
  return {
    format: BUNDLE_FORMAT,
    formatVersion: BUNDLE_FORMAT_VERSION,
    rootPubKey,
    rootFingerprint,
    onlineKey: { pubkey: online.pubkey, privkey: online.privkey },
    delegation,
  };
}

/** What ingesting a bundle did. `stale` = the relay is already on a newer
 *  delegation, so the file was ignored (anti-rollback). */
export type IngestOutcome = 'installed' | 'unchanged' | 'stale' | 'absent';

export interface IngestResult {
  outcome: IngestOutcome;
  /** The path examined, for logging. */
  path: string;
  version?: number;
}

/**
 * Install a verified bundle, or explain why this relay won't take it.
 *
 * The two refusals here are the ones a stolen/forged bundle would run into: a
 * bundle rooted at a different key than the one already installed (a relay
 * substitution — the pinned anchor may not silently change), and a delegation
 * that contradicts one already recorded at the same version. Anti-rollback
 * itself lives in `db.installRelayIdentity`, in the same transaction as the
 * write, so it cannot be raced.
 */
export function installIdentityBundle(db: DB, bundle: IdentityBundle): IngestOutcome {
  const existing = db.getRelayRootPubkey();
  if (existing !== undefined && existing !== bundle.rootPubKey) {
    throw new RelayIdentityError(
      'The identity bundle is rooted at a DIFFERENT key than the one this relay already has.\n' +
        `  installed root:  ${existing}\n` +
        `  bundle root:     ${bundle.rootPubKey}\n\n` +
        'Every client has pinned the installed root, so swapping it would look exactly like a\n' +
        'relay substitution attack and would lock out every existing account. Refusing.\n' +
        'To rotate the ONLINE key (which keeps the anchor, and is almost certainly what you\n' +
        'want) run `npm run relay -- rotate-online-key` on the machine holding the root key.\n' +
        'To genuinely start a new relay, point DATA_DIR at a fresh directory.',
    );
  }
  try {
    return db.installRelayIdentity(bundle);
  } catch (e) {
    // The storage layer's refusals (an equivocating version, a root that got
    // past the check above) are operator-facing conditions at boot, not
    // crashes: re-raise them as the type the entrypoint prints cleanly instead
    // of letting a stack trace be the first thing an operator sees.
    if (e instanceof RelayIdentityError) throw e;
    throw new RelayIdentityError(
      `The relay refused this identity bundle: ${(e as Error).message}.\n` +
        'Install the newest bundle you minted, or point DATA_DIR at a fresh directory to start over.',
    );
  }
}

/**
 * Boot step: ingest the identity bundle if one is sitting at the conventional
 * path, then leave it there. Idempotent — a restart re-reads the same file and
 * changes nothing, and dropping in a rotated bundle installs the new delegation
 * on the next restart. Deploying is therefore "copy the file, start the relay";
 * there is no second command.
 *
 * The file is deliberately NOT deleted after ingest. It holds no secret the
 * database does not already hold — the online private key has to live on this
 * server for KT roots to be signed at all, and the root private key was never
 * in it — so deleting it would buy no confidentiality while breaking the two
 * things operators actually do: re-create the container against the same
 * volume, and mount the bundle read-only. An operator who wants it gone can
 * delete it once the relay is up; the database keeps serving.
 */
export function ingestIdentityBundle(
  db: DB,
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): IngestResult {
  const path = identityBundlePath(dataDir, env);
  if (!existsSync(path)) return { outcome: 'absent', path };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new RelayIdentityError(`could not read the relay identity bundle at ${path}: ${(e as Error).message}`);
  }
  const bundle = parseIdentityBundle(text);
  return { outcome: installIdentityBundle(db, bundle), path, version: bundle.delegation.version };
}

/**
 * Load the relay's identity for serving, or throw a `RelayIdentityError`
 * explaining what the operator must run.
 *
 * This is a verification, not a read: the stored delegation chain is checked
 * against the stored root and the private key is checked to match the key the
 * delegation names. So a relay whose database was edited to swap in an attacker
 * key — without the root private key, which is the whole point — refuses to
 * start rather than serving a chain that every client would (correctly) reject.
 */
export function loadRelayIdentity(db: DB, bundleFile = BUNDLE_FILENAME): RelayIdentity {
  const rootPubKey = db.getRelayRootPubkey();
  if (!rootPubKey) throw new RelayIdentityError(relayIdentityMissing(bundleFile));
  if (Buffer.from(rootPubKey, 'base64').length !== 32) {
    throw new RelayIdentityError('stored root public key is not a 32-byte Ed25519 key');
  }
  const rootFingerprint = fingerprintB64url(Buffer.from(rootPubKey, 'base64'));

  const rows = db.listRelayOnlineKeys();
  if (rows.length === 0) {
    throw new RelayIdentityError(
      'This relay has a root key but no delegation, so it will not start.\n' +
        'Install the identity bundle `npm run relay -- init-identity` wrote, or point DATA_DIR\n' +
        'at a fresh directory and start over.',
    );
  }

  const delegations: Delegation[] = [];
  for (const r of rows) {
    const d: Delegation = {
      version: r.version,
      onlineKey: r.pubkey,
      issuedAt: r.issuedAt,
      notAfter: r.notAfter,
      signature: r.signature,
    };
    if (!verifyDelegation(rootPubKey, d)) {
      throw new RelayIdentityError(
        `stored delegation v${r.version} does not verify against this relay's root key — ` +
          'the database has been altered; refusing to start',
      );
    }
    delegations.push(d);
  }

  const current = delegations[delegations.length - 1]!;
  const currentRow = rows[rows.length - 1]!;
  if (!currentRow.privkey) {
    throw new RelayIdentityError(
      `the online private key for delegation v${current.version} is missing; refusing to start`,
    );
  }
  let onlineSigningKey: KeyObject;
  try {
    onlineSigningKey = createPrivateKey({
      key: Buffer.from(currentRow.privkey, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
  } catch {
    throw new RelayIdentityError('the stored online private key is unreadable; refusing to start');
  }
  if (rawPublicKeyOf(onlineSigningKey) !== current.onlineKey) {
    throw new RelayIdentityError(
      'the stored online private key does not match the delegated public key; refusing to start',
    );
  }

  return {
    rootPubKey,
    rootFingerprint,
    delegation: current,
    delegations,
    onlineKeyVersion: current.version,
    onlineSigningKey,
  };
}
