// The relay's offline-root / online-key split (spec/relay.md § "Relay identity:
// an offline root and an online signing key").
//
// The claims here are the ones the design exists to make: the pinned anchor's
// private half is never on the server (and there is nowhere it could be put), a
// delegation only counts if the root signed it, a superseded delegation can
// never come back, and a relay with no installed identity refuses to serve
// rather than minting one for itself.

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDb, type DB } from '../src/db.js';
import { fingerprintB64url } from '../src/relayAuth.js';
import {
  BUNDLE_FILENAME,
  delegationPayload,
  DELEGATION_CONTEXT,
  generateEd25519,
  identityBundlePath,
  ingestIdentityBundle,
  installIdentityBundle,
  isExpired,
  loadRelayIdentity,
  parseIdentityBundle,
  parseRootPrivateKey,
  RelayIdentityError,
  signDelegation,
  verifyDelegation,
  type Delegation,
  type IdentityBundle,
} from '../src/relayIdentity.js';
import { identitySummary, initIdentity, rotateOnlineKey } from '../src/relayIdentityAdmin.js';
import { keysFromDelegations, verifyRootChain } from '../src/ktAudit.js';
import { makeRelayApp, type TestApp } from '../../test/helpers/server.js';

// The CLI and the entrypoint are exercised as real processes — the claims about
// what they touch ("no database", "no DATA_DIR", "the root key is never
// written") are only worth anything if the actual command is what is measured.
// Run from source via tsx: the unit CI job does not build server/dist.
//
// A spawned process gets none of Vitest's config, so the `@notes/shared` alias
// to source (vitest.config.ts) does not apply here — inside the child, the
// package resolves the ordinary way, via the workspace symlink to
// `shared/dist/index.js`. That build is therefore a real prerequisite of this
// file, which is why the root `pretest`/`precoverage` scripts build `shared`.
// Without them this suite passes on a machine that happens to have built
// `shared` earlier and fails on a clean checkout — which is exactly how it
// first broke in CI.
const REPO = join(import.meta.dirname, '..', '..');
const TSX = join(REPO, 'node_modules/.bin/tsx');
const CLI = join(REPO, 'server/src/relay-cli.ts');
const RELAY_ENTRY = join(REPO, 'server/src/relay-index.ts');

/** Run the operator CLI in `cwd`, with DATA_DIR deliberately unset — an
 *  operator's laptop has never heard of it. */
function runCli(
  cwd: string,
  args: string[],
  opts: { input?: string } = {},
): string {
  const env = { ...process.env, INIT_CWD: cwd };
  delete env.DATA_DIR;
  return execFileSync(TSX, [CLI, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    stdio: opts.input === undefined ? ['ignore', 'pipe', 'pipe'] : 'pipe',
    input: opts.input,
    timeout: 60_000,
  });
}

/** The root private key out of the banner `init-identity` prints — identified by
 *  actually parsing it and checking it is the bundle's root, not by scraping. */
function printedRootKey(out: string, rootPubKey: string): string {
  const line = out
    .split('\n')
    .map((l) => l.trim())
    .find((l) => {
      if (!/^[A-Za-z0-9+/=]{40,}$/.test(l)) return false;
      try {
        return parseRootPrivateKey(l).pubKey === rootPubKey;
      } catch {
        return false;
      }
    });
  expect(line, 'init-identity must print the root private key').toBeTruthy();
  return line!;
}

const dirs: string[] = [];
let ctx: TestApp | undefined;

afterEach(async () => {
  if (ctx) await ctx.cleanup();
  ctx = undefined;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'notes-identity-'));
  dirs.push(dir);
  return dir;
}

/** A relay database with NO identity — what a fresh install looks like. */
function bareDb(): { db: DB; dir: string } {
  const dir = tempDir();
  return { db: openDb(dir), dir };
}

/** Every byte the relay has written under DATA_DIR (database, WAL, everything). */
function allBytes(dir: string): Buffer {
  const parts: Buffer[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else parts.push(readFileSync(p));
    }
  };
  walk(dir);
  return Buffer.concat(parts);
}

/** Put a bundle where the relay will look for it. */
function placeBundle(dir: string, bundle: IdentityBundle): string {
  const path = join(dir, BUNDLE_FILENAME);
  writeFileSync(path, JSON.stringify(bundle, null, 2));
  return path;
}

describe('the delegation itself', () => {
  it('verifies against the root that signed it, and against nothing else', () => {
    const root = generateEd25519();
    const other = generateEd25519();
    const online = generateEd25519();
    const { key } = parseRootPrivateKey(root.privkey);
    const d = signDelegation(key, {
      onlineKey: online.pubkey,
      version: 1,
      issuedAt: 1_000,
      notAfter: 2_000,
    });

    expect(verifyDelegation(root.pubkey, d)).toBe(true);
    // A different root — the substitution the whole design is about.
    expect(verifyDelegation(other.pubkey, d)).toBe(false);
  });

  it('is bound to its root fingerprint, so it cannot be replayed onto another relay', () => {
    const root = generateEd25519();
    const impostor = generateEd25519();
    const online = generateEd25519();
    const fields = { onlineKey: online.pubkey, version: 1, issuedAt: 1_000, notAfter: 2_000 };
    const rootFp = fingerprintB64url(Buffer.from(root.pubkey, 'base64'));
    const impostorFp = fingerprintB64url(Buffer.from(impostor.pubkey, 'base64'));

    expect(delegationPayload(rootFp, fields).toString()).toBe(
      `${DELEGATION_CONTEXT}|${rootFp}|${online.pubkey}|1|1000|2000`,
    );
    // The fingerprint is inside the signed bytes, so the same signature cannot
    // stand as a statement by a different root.
    expect(delegationPayload(rootFp, fields).equals(delegationPayload(impostorFp, fields))).toBe(false);
  });

  it('uses a domain separator no other relay signature shares', () => {
    // KT roots sign `kt-root|…`; device auth signs `{nonce}|{fingerprint}`.
    expect(DELEGATION_CONTEXT).toBe('accord-relay-delegation|v1');
    expect(DELEGATION_CONTEXT.startsWith('kt-root')).toBe(false);
    const payload = delegationPayload('fp', {
      onlineKey: 'k',
      version: 1,
      issuedAt: 1,
      notAfter: 2,
    }).toString();
    expect(payload.startsWith(`${DELEGATION_CONTEXT}|`)).toBe(true);
  });

  it('fails on a single tampered byte, in any field', () => {
    const root = generateEd25519();
    const { key } = parseRootPrivateKey(root.privkey);
    const evil = generateEd25519();
    const d = signDelegation(key, {
      onlineKey: generateEd25519().pubkey,
      version: 3,
      issuedAt: 1_000,
      notAfter: 9_000,
    });
    expect(verifyDelegation(root.pubkey, d)).toBe(true);

    // Swapping in the attacker's online key is the interesting tamper.
    expect(verifyDelegation(root.pubkey, { ...d, onlineKey: evil.pubkey })).toBe(false);
    expect(verifyDelegation(root.pubkey, { ...d, version: 4 })).toBe(false);
    expect(verifyDelegation(root.pubkey, { ...d, notAfter: d.notAfter + 1 })).toBe(false);
    expect(verifyDelegation(root.pubkey, { ...d, issuedAt: d.issuedAt - 1 })).toBe(false);
    expect(verifyDelegation(root.pubkey, { ...d, signature: randomBytes(64).toString('base64') })).toBe(false);
  });

  it('refuses a malformed record before it reaches the verifier', () => {
    const root = generateEd25519();
    const good = signDelegation(parseRootPrivateKey(root.privkey).key, {
      onlineKey: generateEd25519().pubkey,
      version: 1,
      issuedAt: 1_000,
      notAfter: 2_000,
    });
    for (const bad of [
      null,
      {},
      { ...good, version: '1' },
      { ...good, version: 0 },
      { ...good, onlineKey: randomBytes(16).toString('base64') },
      { ...good, signature: 'nope' },
      { ...good, notAfter: good.issuedAt }, // zero-length window
    ]) {
      expect(verifyDelegation(root.pubkey, bad)).toBe(false);
    }
  });

  it('knows when it has expired', () => {
    const d: Delegation = { version: 1, onlineKey: '', issuedAt: 0, notAfter: 5_000, signature: '' };
    expect(isExpired(d, 4_999)).toBe(false);
    expect(isExpired(d, 5_000)).toBe(true);
  });
});

describe('init-identity (runs on the operator machine)', () => {
  it('mints a self-consistent bundle with a delegation the root signed', () => {
    const { bundle, rootPrivKey } = initIdentity();
    expect(bundle.delegation.version).toBe(1);
    expect(verifyDelegation(bundle.rootPubKey, bundle.delegation)).toBe(true);
    expect(bundle.rootFingerprint).toBe(fingerprintB64url(Buffer.from(bundle.rootPubKey, 'base64')));
    // The printed key really is this bundle's root — an operator who stores it
    // can rotate later.
    expect(parseRootPrivateKey(rootPrivKey).pubKey).toBe(bundle.rootPubKey);
    // The online key is a *different* key from the anchor; if they were the same
    // the split would buy nothing.
    expect(bundle.delegation.onlineKey).not.toBe(bundle.rootPubKey);
    expect(bundle.onlineKey.pubkey).toBe(bundle.delegation.onlineKey);
    // It survives a JSON round trip through the strict parser.
    expect(parseIdentityBundle(JSON.stringify(bundle))).toEqual(bundle);
  });

  it('puts no root private key in the bundle, in any encoding', () => {
    const { bundle, rootPrivKey } = initIdentity();
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain(rootPrivKey);
    // …nor the raw seed inside it, which is what a naive "just the key bytes"
    // leak would look like.
    const raw = Buffer.from(rootPrivKey, 'base64');
    expect(Buffer.from(serialized).includes(raw)).toBe(false);
    expect(Buffer.from(serialized).includes(raw.subarray(raw.length - 32))).toBe(false);
    // Only these fields exist. A future field would have to be added here
    // deliberately, which is the point.
    expect(Object.keys(bundle).sort()).toEqual([
      'delegation',
      'format',
      'formatVersion',
      'onlineKey',
      'rootFingerprint',
      'rootPubKey',
    ]);
  });

  it('needs no database and no DATA_DIR: the CLI writes only the bundle', () => {
    // The real command, in a directory that has never seen a relay, with
    // DATA_DIR unset entirely. If it opened a database this would create one.
    const dir = tempDir();
    const out = runCli(dir, ['init-identity']);

    expect(readdirSync(dir)).toEqual([BUNDLE_FILENAME]); // no data/, no *.db
    const bundle = parseIdentityBundle(readFileSync(join(dir, BUNDLE_FILENAME), 'utf8'));
    expect(verifyDelegation(bundle.rootPubKey, bundle.delegation)).toBe(true);

    // The root private key is printed, and is genuinely this bundle's root…
    const printed = printedRootKey(out, bundle.rootPubKey);
    // …and appears nowhere on disk, as text or as bytes.
    const onDisk = allBytes(dir);
    expect(onDisk.includes(Buffer.from(printed))).toBe(false);
    expect(onDisk.includes(Buffer.from(printed, 'base64'))).toBe(false);
    // Positive control: the root PUBLIC key *is* in the bundle, so the scan works.
    expect(onDisk.includes(Buffer.from(bundle.rootPubKey))).toBe(true);
  });

  it('writes the bundle owner-readable only (it holds the online private key)', () => {
    const dir = tempDir();
    runCli(dir, ['init-identity']);
    expect(statSync(join(dir, BUNDLE_FILENAME)).mode & 0o777).toBe(0o600);
  });

  it('refuses to overwrite an existing bundle, and --if-missing is a quiet no-op', () => {
    const dir = tempDir();
    runCli(dir, ['init-identity']);
    const first = readFileSync(join(dir, BUNDLE_FILENAME), 'utf8');

    // Re-running would mint a NEW root — a fingerprint every client has pinned.
    expect(() => runCli(dir, ['init-identity'])).toThrow();
    expect(readFileSync(join(dir, BUNDLE_FILENAME), 'utf8')).toBe(first);

    // …which is what the harness flag is for: idempotent-safe, changes nothing.
    runCli(dir, ['init-identity', '--if-missing']);
    expect(readFileSync(join(dir, BUNDLE_FILENAME), 'utf8')).toBe(first);

    // --force is the explicit opt-in.
    runCli(dir, ['init-identity', '--force']);
    expect(readFileSync(join(dir, BUNDLE_FILENAME), 'utf8')).not.toBe(first);
  });
});

describe('the bundle parser', () => {
  it('refuses a bundle that carries a root private key at all', () => {
    const { bundle, rootPrivKey } = initIdentity();
    for (const field of ['rootPrivKey', 'rootPrivateKey', 'rootKey']) {
      const smuggled = JSON.stringify({ ...bundle, [field]: rootPrivKey });
      expect(() => parseIdentityBundle(smuggled)).toThrow(/NEVER carry the root/);
    }
  });

  it('refuses a delegation swapped in by someone without the root key', () => {
    const { bundle } = initIdentity();
    const attacker = generateEd25519();
    const attackerOnline = generateEd25519();
    const forged = signDelegation(parseRootPrivateKey(attacker.privkey).key, {
      onlineKey: attackerOnline.pubkey,
      version: 2,
      issuedAt: Date.now(),
      notAfter: Date.now() + 86_400_000,
    });
    expect(() =>
      parseIdentityBundle(JSON.stringify({ ...bundle, delegation: forged })),
    ).toThrow(/not signed by the root key it names/);
  });

  it('refuses an online private key that is not the delegated one', () => {
    const { bundle } = initIdentity();
    const other = generateEd25519();
    expect(() =>
      parseIdentityBundle(
        JSON.stringify({ ...bundle, onlineKey: { pubkey: bundle.onlineKey.pubkey, privkey: other.privkey } }),
      ),
    ).toThrow(/does not match its public half/);
    // …and a keypair that is internally consistent but not what the delegation names.
    expect(() =>
      parseIdentityBundle(JSON.stringify({ ...bundle, onlineKey: other })),
    ).toThrow(/names a different key/);
  });

  it('refuses a fingerprint that does not commit to the root key', () => {
    const { bundle } = initIdentity();
    const wrong = fingerprintB64url(Buffer.from(generateEd25519().pubkey, 'base64'));
    expect(() => parseIdentityBundle(JSON.stringify({ ...bundle, rootFingerprint: wrong }))).toThrow(
      /does not match its rootPubKey/,
    );
  });

  it('refuses junk, the wrong kind of file, and a future format', () => {
    const { bundle } = initIdentity();
    expect(() => parseIdentityBundle('not json')).toThrow(/not valid JSON/);
    expect(() => parseIdentityBundle('{"hello":1}')).toThrow(/not a relay identity bundle/);
    expect(() => parseIdentityBundle(JSON.stringify({ ...bundle, formatVersion: 99 }))).toThrow(
      /format version 99 is not supported/,
    );
  });
});

describe('boot: ingesting the bundle', () => {
  it('installs it from DATA_DIR and is a no-op on every restart', () => {
    const { db, dir } = bareDb();
    const { bundle } = initIdentity();
    placeBundle(dir, bundle);

    expect(ingestIdentityBundle(db, dir).outcome).toBe('installed');
    const identity = loadRelayIdentity(db);
    expect(identity.rootPubKey).toBe(bundle.rootPubKey);
    expect(identity.delegation).toEqual(bundle.delegation);

    // Restart, restart, restart: same file, nothing changes.
    expect(ingestIdentityBundle(db, dir).outcome).toBe('unchanged');
    expect(ingestIdentityBundle(db, dir).outcome).toBe('unchanged');
    expect(db.listRelayOnlineKeys()).toHaveLength(1);
  });

  it('honors RELAY_IDENTITY_FILE over the DATA_DIR convention', () => {
    const { db, dir } = bareDb();
    const elsewhere = tempDir();
    const path = placeBundle(elsewhere, initIdentity().bundle);
    expect(identityBundlePath(dir, { RELAY_IDENTITY_FILE: path })).toBe(path);
    expect(ingestIdentityBundle(db, dir, { RELAY_IDENTITY_FILE: path }).outcome).toBe('installed');
    expect(loadRelayIdentity(db).delegation.version).toBe(1);
  });

  it('reports "absent" when there is no bundle, without inventing one', () => {
    const { db, dir } = bareDb();
    expect(ingestIdentityBundle(db, dir).outcome).toBe('absent');
    expect(db.getRelayRootPubkey()).toBeUndefined();
    expect(db.listRelayOnlineKeys()).toHaveLength(0);
  });

  it('installs a rotated bundle dropped in later, and wipes the superseded private key', () => {
    const { db, dir } = bareDb();
    const { bundle, rootPrivKey } = initIdentity();
    placeBundle(dir, bundle);
    ingestIdentityBundle(db, dir);

    const rotated = rotateOnlineKey({ rootPrivKey, previous: bundle });
    placeBundle(dir, rotated);
    expect(ingestIdentityBundle(db, dir).outcome).toBe('installed');

    const identity = loadRelayIdentity(db);
    expect(identity.rootFingerprint).toBe(bundle.rootFingerprint); // the anchor does NOT move
    expect(identity.delegation.version).toBe(2);
    expect(identity.delegations.map((d) => d.version)).toEqual([1, 2]);

    const stored = db.listRelayOnlineKeys();
    expect(stored[0]!.privkey).toBeNull(); // the revoked key is gone from the server
    expect(stored[0]!.pubkey).toBe(bundle.delegation.onlineKey); // but stays verifiable
    expect(stored[1]!.privkey).not.toBeNull();
  });

  it('refuses a bundle rooted at a different key than the one clients pinned', () => {
    const { db, dir } = bareDb();
    placeBundle(dir, initIdentity().bundle);
    ingestIdentityBundle(db, dir);
    const before = loadRelayIdentity(db);

    // An attacker who can write into DATA_DIR drops in their own, perfectly
    // self-signed, bundle. Accepting it would silently move the anchor.
    placeBundle(dir, initIdentity().bundle);
    expect(() => ingestIdentityBundle(db, dir)).toThrow(/rooted at a DIFFERENT key/);
    const after = loadRelayIdentity(db);
    expect(after.rootPubKey).toBe(before.rootPubKey);
    expect(after.delegation.signature).toBe(before.delegation.signature);
  });
});

describe('anti-rollback', () => {
  it('ignores an older bundle left on disk after a rotation', () => {
    const { db, dir } = bareDb();
    const { bundle, rootPrivKey } = initIdentity();
    const rotated = rotateOnlineKey({ rootPrivKey, previous: bundle });
    placeBundle(dir, rotated);
    ingestIdentityBundle(db, dir); // relay is on v2

    // Replaying the v1 bundle is exactly the move that would reinstate a stolen
    // online key. The v1 delegation is genuinely root-signed — it is refused
    // purely because the version does not move forward.
    expect(verifyDelegation(bundle.rootPubKey, bundle.delegation)).toBe(true);
    placeBundle(dir, bundle);
    expect(ingestIdentityBundle(db, dir).outcome).toBe('stale');
    expect(loadRelayIdentity(db).delegation.version).toBe(2);
    expect(db.listRelayOnlineKeys().map((k) => k.version)).toEqual([2]);
  });

  it('refuses two different delegations at the same version', () => {
    const { db } = bareDb();
    const { bundle, rootPrivKey } = initIdentity();
    installIdentityBundle(db, bundle);
    // Same version, different online key — a root that signed both would be
    // equivocating; the relay will not pick a winner.
    const online = generateEd25519();
    const conflicting = signDelegation(parseRootPrivateKey(rootPrivKey).key, {
      onlineKey: online.pubkey,
      version: 1,
      issuedAt: Date.now(),
      notAfter: Date.now() + 86_400_000,
    });
    expect(() =>
      installIdentityBundle(db, { ...bundle, onlineKey: online, delegation: conflicting }),
    ).toThrow(/DIFFERENT delegation is already installed at version 1/);
    // …and it surfaces as the type the entrypoint prints cleanly, not a raw
    // crash, because this is reachable at boot from a bad bundle on disk.
    expect(() =>
      installIdentityBundle(db, { ...bundle, onlineKey: online, delegation: conflicting }),
    ).toThrow(RelayIdentityError);
    expect(loadRelayIdentity(db).delegation).toEqual(bundle.delegation);
  });

  it('rotate-online-key refuses to mint a version that does not increase', () => {
    const { bundle, rootPrivKey } = initIdentity();
    const v2 = rotateOnlineKey({ rootPrivKey, previous: bundle });
    expect(v2.delegation.version).toBe(2);
    // Asking for a lower version than the bundle already holds is refused
    // outright rather than quietly bumped.
    expect(() => rotateOnlineKey({ rootPrivKey, previous: v2, currentVersion: 1 })).toThrow(
      /older than the bundle's own delegation/,
    );
    // Chained rotations keep climbing.
    expect(rotateOnlineKey({ rootPrivKey, previous: v2 }).delegation.version).toBe(3);
    // And an explicit current version wins when the relay is ahead of the bundle.
    expect(rotateOnlineKey({ rootPrivKey, previous: bundle, currentVersion: 7 }).delegation.version).toBe(8);
  });
});

describe('rotate-online-key', () => {
  it('keeps the anchor and replaces the online key', () => {
    const { bundle, rootPrivKey } = initIdentity();
    const rotated = rotateOnlineKey({ rootPrivKey, previous: bundle });

    expect(rotated.rootPubKey).toBe(bundle.rootPubKey);
    expect(rotated.rootFingerprint).toBe(bundle.rootFingerprint);
    expect(rotated.delegation.onlineKey).not.toBe(bundle.delegation.onlineKey);
    expect(verifyDelegation(rotated.rootPubKey, rotated.delegation)).toBe(true);
    // Still no root private key anywhere in it.
    expect(JSON.stringify(rotated)).not.toContain(rootPrivKey);
  });

  it('rejects a root key that is not the one the identity was created with', () => {
    const { bundle } = initIdentity();
    const impostor = generateEd25519();
    expect(() => rotateOnlineKey({ rootPrivKey: impostor.privkey, previous: bundle })).toThrow(
      /not the root key this identity was created with/,
    );
  });

  it('rejects input that is not an Ed25519 private key at all', () => {
    const { bundle } = initIdentity();
    expect(() => rotateOnlineKey({ rootPrivKey: 'not-a-key', previous: bundle })).toThrow(RelayIdentityError);
    expect(() => rotateOnlineKey({ rootPrivKey: '', previous: bundle })).toThrow(RelayIdentityError);
  });

  it('refuses to guess the version when it has neither a bundle nor --current-version', () => {
    const { rootPrivKey } = initIdentity();
    expect(() => rotateOnlineKey({ rootPrivKey })).toThrow(/needs to know the delegation version/);
  });

  it('a forged rotation (wrong root) is refused by the relay too, not just the CLI', () => {
    const { db, dir } = bareDb();
    const { bundle } = initIdentity();
    placeBundle(dir, bundle);
    ingestIdentityBundle(db, dir);

    // An attacker who stole the online key mints their own root and "rotates".
    const attacker = initIdentity();
    const forged = rotateOnlineKey({ rootPrivKey: attacker.rootPrivKey, previous: attacker.bundle });
    placeBundle(dir, forged);
    expect(() => ingestIdentityBundle(db, dir)).toThrow(/rooted at a DIFFERENT key/);
    expect(loadRelayIdentity(db).delegation.version).toBe(1);
  });

  it('runs from the CLI with no DATA_DIR, and never writes the root key', () => {
    const dir = tempDir();
    const out = runCli(dir, ['init-identity']);
    const before = parseIdentityBundle(readFileSync(join(dir, BUNDLE_FILENAME), 'utf8'));
    const rootPrivKey = printedRootKey(out, before.rootPubKey);

    // Root key on stdin — never a flag, so it stays out of argv and shell history.
    runCli(dir, ['rotate-online-key'], { input: rootPrivKey });
    const after = parseIdentityBundle(readFileSync(join(dir, BUNDLE_FILENAME), 'utf8'));
    expect(after.delegation.version).toBe(2);
    expect(after.rootPubKey).toBe(before.rootPubKey);
    expect(after.delegation.onlineKey).not.toBe(before.delegation.onlineKey);

    expect(readdirSync(dir)).toEqual([BUNDLE_FILENAME]);
    const onDisk = allBytes(dir);
    expect(onDisk.includes(Buffer.from(rootPrivKey))).toBe(false);
    expect(onDisk.includes(Buffer.from(rootPrivKey, 'base64'))).toBe(false);

    // The wrong key is refused, and leaves the bundle untouched.
    const wrong = initIdentity().rootPrivKey;
    expect(() => runCli(dir, ['rotate-online-key'], { input: wrong })).toThrow();
    expect(parseIdentityBundle(readFileSync(join(dir, BUNDLE_FILENAME), 'utf8'))).toEqual(after);
  });
});

describe('what the relay stores', () => {
  it('has no column anywhere in the schema that could hold a root private key', () => {
    const { db, dir } = bareDb();
    placeBundle(dir, initIdentity().bundle);
    ingestIdentityBundle(db, dir);

    const tables = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    expect(tables.some((t) => t.name === 'relay_root')).toBe(true);
    const cols = (db.raw.prepare('PRAGMA table_info(relay_root)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols.sort()).toEqual(['created_at', 'id', 'pubkey']);
    // And the legacy single-key table — the one that made a breach terminal — is
    // gone for good.
    expect(tables.some((t) => t.name === 'relay_identity')).toBe(false);
  });

  it('never has the root private key in the store, even after a rotation', () => {
    const { db, dir } = bareDb();
    const { bundle, rootPrivKey } = initIdentity();
    placeBundle(dir, bundle);
    ingestIdentityBundle(db, dir);
    placeBundle(dir, rotateOnlineKey({ rootPrivKey, previous: bundle }));
    ingestIdentityBundle(db, dir);
    db.raw.close();

    // Everything under DATA_DIR: the database, its WAL, and the bundle file the
    // relay deliberately leaves in place.
    const onDisk = allBytes(dir);
    expect(onDisk.includes(Buffer.from(rootPrivKey))).toBe(false);
    expect(onDisk.includes(Buffer.from(rootPrivKey, 'base64'))).toBe(false);
    // Positive control: the root PUBLIC key is there, so the scan is real.
    expect(onDisk.includes(Buffer.from(bundle.rootPubKey))).toBe(true);
  });

  it('refuses to start if the database was edited to swap in another online key', () => {
    const { db } = bareDb();
    installIdentityBundle(db, initIdentity().bundle);
    // Exactly what a relay-side attacker without the root key can do: rewrite
    // the row. The signature no longer covers it, so the relay stops.
    const evil = generateEd25519();
    db.raw
      .prepare('UPDATE relay_online_keys SET pubkey = ?, privkey = ? WHERE version = 1')
      .run(evil.pubkey, evil.privkey);
    expect(() => loadRelayIdentity(db)).toThrow(/does not verify against this relay's root key/);
  });

  it('refuses to start if the online private key does not match the delegation', () => {
    const { db } = bareDb();
    installIdentityBundle(db, initIdentity().bundle);
    db.raw
      .prepare('UPDATE relay_online_keys SET privkey = ? WHERE version = 1')
      .run(generateEd25519().privkey);
    expect(() => loadRelayIdentity(db)).toThrow(/does not match the delegated public key/);
  });
});

describe('boot: no identity', () => {
  it('refuses to start, naming the command and the bundle path', () => {
    const { db } = bareDb();
    expect(() => loadRelayIdentity(db)).toThrow(RelayIdentityError);
    try {
      loadRelayIdentity(db, '/srv/accord-data/relay-identity.json');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('will not start');
      expect(msg).toContain('init-identity');
      expect(msg).toContain('/srv/accord-data/relay-identity.json');
    }
    expect.assertions(4);
  });

  it('does not silently mint an identity just because a route was built', async () => {
    const { db, dir } = bareDb();
    const { buildRelayApp } = await import('../src/relay-app.js');
    const { makeConfig } = await import('../../test/helpers/server.js');
    await expect(buildRelayApp(db, makeConfig(dir))).rejects.toThrow(RelayIdentityError);
    expect(db.getRelayRootPubkey()).toBeUndefined();
    expect(db.listRelayOnlineKeys()).toHaveLength(0);
  });

  it('the real entrypoint exits non-zero with an actionable message', () => {
    const dir = tempDir();
    let failed = false;
    try {
      // cwd is the empty temp dir so no developer .env can leak in.
      execFileSync(TSX, [RELAY_ENTRY], {
        cwd: dir,
        env: { ...process.env, DATA_DIR: dir, PORT: '0', APP_ORIGIN: 'http://localhost:3000' },
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 120_000,
      });
    } catch (e) {
      failed = true;
      const err = e as { status: number | null; stderr: string };
      expect(err.status).toBe(1);
      expect(err.stderr).toContain('will not start');
      expect(err.stderr).toContain('init-identity');
      expect(err.stderr).toContain(join(dir, BUNDLE_FILENAME));
      // It did NOT create one for itself.
      expect(readdirSync(dir).includes(BUNDLE_FILENAME)).toBe(false);
    }
    expect(failed, 'the relay must refuse to boot without an identity').toBe(true);
  }, 120_000);

  it('boots when the bundle is there, and leaves the file in place', () => {
    const dir = tempDir();
    runCli(dir, ['init-identity']);
    // A real boot would listen; here the same ingest path is what we assert on,
    // and that the relay does not consume (delete) the operator's file.
    const db = openDb(dir);
    expect(ingestIdentityBundle(db, dir).outcome).toBe('installed');
    expect(readdirSync(dir)).toContain(BUNDLE_FILENAME);
    expect(loadRelayIdentity(db).delegation.version).toBe(1);
    db.raw.close();
  });
});

describe('GET /api/relay/info serves a self-consistent chain', () => {
  it('binds fingerprint → root → delegation → online key', async () => {
    ctx = await makeRelayApp();
    const info = (await ctx.app.inject({ method: 'GET', url: '/api/relay/info' })).json() as {
      identityFingerprint: string;
      identityPubKey: string;
      delegation: Delegation;
      delegations: Delegation[];
      apiVersion: number;
    };

    // 1. the pinned fingerprint commits to the served key (unchanged check,
    //    new meaning: that key is now the ROOT).
    expect(info.identityFingerprint).toBe(
      fingerprintB64url(Buffer.from(info.identityPubKey, 'base64')),
    );
    // 2. the delegation is signed by that root.
    expect(verifyDelegation(info.identityPubKey, info.delegation)).toBe(true);
    // 3. the online key that signs KT roots is the delegated one, and it is NOT
    //    the pinned key.
    expect(info.delegation.onlineKey).not.toBe(info.identityPubKey);
    expect(info.delegations).toHaveLength(1);
    expect(info.delegations[0]).toEqual(info.delegation);
    expect(info.apiVersion).toBe(2);
  });

  it('keeps the pinned fingerprint fixed across an online-key rotation', async () => {
    ctx = await makeRelayApp();
    const before = (await ctx.app.inject({ method: 'GET', url: '/api/relay/info' })).json();

    // Rotate the way an operator does: mint the next bundle offline, install it,
    // restart. A rotation must not look like a relay substitution to a pinned
    // client.
    const { bundle, rootPrivKey } = initIdentity();
    // (Re-key this relay's identity onto a root we hold the private half of, so
    // the test can rotate it — a fresh DATA_DIR, as a real re-root requires.)
    const fresh = openDb(tempDir());
    installIdentityBundle(fresh, bundle);
    installIdentityBundle(fresh, rotateOnlineKey({ rootPrivKey, previous: bundle }));

    const { buildRelayApp } = await import('../src/relay-app.js');
    const { makeConfig } = await import('../../test/helpers/server.js');
    const restarted = await buildRelayApp(fresh, makeConfig(dirs[dirs.length - 1]!));
    restarted.log.level = 'silent';
    const after = (await restarted.inject({ method: 'GET', url: '/api/relay/info' })).json();
    await restarted.close();
    fresh.raw.close();

    expect(after.delegation.version).toBe(2);
    expect(after.identityFingerprint).toBe(bundle.rootFingerprint);
    expect(after.identityFingerprint).toBe(
      fingerprintB64url(Buffer.from(after.identityPubKey as string, 'base64')),
    );
    expect(after.delegations.map((d: Delegation) => d.version)).toEqual([1, 2]);
    expect(before.identityFingerprint).not.toBe(after.identityFingerprint); // different relay
  });

  it('lets an auditor verify roots published before a rotation', async () => {
    // A relay whose identity we hold the root key for, so we can rotate it.
    const dir = tempDir();
    const db = openDb(dir);
    const { bundle, rootPrivKey } = initIdentity();
    installIdentityBundle(db, bundle);

    const { buildRelayApp } = await import('../src/relay-app.js');
    const { makeConfig, enrollDevice, seedUser } = await import('../../test/helpers/server.js');
    const config = makeConfig(dir);
    let app = await buildRelayApp(db, config);
    app.log.level = 'silent';

    const publish = async (handle: string): Promise<void> => {
      const u = seedUser(db, { handle });
      const { bearer } = await enrollDevice(app, db, { userId: u });
      await app.inject({
        method: 'PUT',
        url: '/api/relay/directory',
        headers: { authorization: bearer },
        payload: {
          identityPubKey: randomBytes(32).toString('base64'),
          sealingPubKey: randomBytes(32).toString('base64'),
        },
      });
    };
    await publish('Alice#0001');
    await app.close();

    // Rotate + restart, then publish again under the new online key.
    installIdentityBundle(db, rotateOnlineKey({ rootPrivKey, previous: bundle }));
    app = await buildRelayApp(db, config);
    app.log.level = 'silent';
    await publish('Bravo#0002');

    const info = (await app.inject({ method: 'GET', url: '/api/relay/info' })).json();
    const roots = (await app.inject({ method: 'GET', url: '/api/relay/kt/roots' })).json();
    await app.close();
    db.raw.close();

    expect(roots.roots.map((r: { keyVersion: number }) => r.keyVersion)).toEqual([1, 2]);
    const keys = keysFromDelegations(info.identityPubKey, info.delegations);
    expect(keys).not.toBeNull();
    const chain = verifyRootChain(keys!, roots.roots);
    expect(chain.ok).toBe(true);
    expect(chain.verifiedEpochs).toBe(2);

    // …and the same roots do NOT verify under the current key alone: the
    // delegation history is doing real work.
    expect(verifyRootChain(info.delegation.onlineKey, roots.roots).ok).toBe(false);
  });

  it('rejects a delegation chain the pinned root did not sign', async () => {
    ctx = await makeRelayApp();
    const info = (await ctx.app.inject({ method: 'GET', url: '/api/relay/info' })).json();
    const attacker = generateEd25519();
    expect(keysFromDelegations(attacker.pubkey, info.delegations)).toBeNull();
    expect(keysFromDelegations(info.identityPubKey, [])).toBeNull();
  });
});

describe('status', () => {
  it('reports a missing identity, and the delegation expiry once installed', () => {
    const { db } = bareDb();
    expect(identitySummary(db)).toMatch(/NOT INSTALLED/);
    installIdentityBundle(db, initIdentity({ days: 10 }).bundle);
    const summary = identitySummary(db);
    expect(summary).toMatch(/Root fingerprint/);
    expect(summary).toMatch(/9d left|10d left/);
  });

  it('flags an expired delegation', () => {
    const { db } = bareDb();
    const past = Date.now() - 400 * 24 * 60 * 60_000;
    installIdentityBundle(db, initIdentity({ now: past, days: 30 }).bundle);
    expect(identitySummary(db)).toMatch(/EXPIRED/);
  });
});
