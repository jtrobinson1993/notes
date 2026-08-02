import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { openDb, type DB } from '../../server/src/db.js';
import { buildRelayApp } from '../../server/src/relay-app.js';
import { fingerprintB64url } from '../../server/src/relayAuth.js';
import { installIdentityBundle } from '../../server/src/relayIdentity.js';
import { initIdentity } from '../../server/src/relayIdentityAdmin.js';
import type { Config } from '../../server/src/config.js';

export const TEST_ORIGIN = 'http://localhost:3000';

export function makeConfig(dataDir: string, overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    dataDir,
    appOrigin: TEST_ORIGIN,
    originHost: new URL(TEST_ORIGIN).hostname,
    klipyApiKey: null,
    // Effectively unlimited so the rate limiter never interferes with a suite
    // that fires many requests; rate-limit behavior is covered explicitly.
    rateLimitMax: 1_000_000,
    voice: { announcedIp: '127.0.0.1', listenIp: '127.0.0.1', rtcMinPort: 40000, rtcMaxPort: 40100 },
    akdSidecarUrl: null,
    akdSidecarToken: null,
    registrationMode: 'invite', // secure default; a test opts into 'public'
    ...overrides,
  };
}

export interface TestDb {
  db: DB;
  dir: string;
  cleanup: () => void;
}

/** A fresh, isolated file DB in a temp dir (better-sqlite3 has no `:memory:`
 * via openDb, but a per-test temp dir is just as isolated and disposable). */
export function makeDb(): TestDb {
  const dir = mkdtempSync(join(tmpdir(), 'notes-test-'));
  const db = openDb(dir);
  // Every real relay has an operator-installed identity before it serves a byte
  // (there is no first-boot auto-mint), so give the test one the same way a real
  // one gets it: mint a bundle offline, install the bundle. The root private key
  // `initIdentity` returns is discarded here, exactly as on a real relay. A
  // suite that wants a relay *without* an identity uses openDb directly — see
  // server/test/relayIdentity.test.ts.
  installIdentityBundle(db, initIdentity().bundle);
  return {
    db,
    dir,
    cleanup: () => {
      try {
        db.raw.close();
      } catch {
        /* already closed */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface TestApp extends TestDb {
  app: FastifyInstance;
  config: Config;
  cleanup: () => Promise<void>;
}

/** Build the standalone v8 relay (buildRelayApp) over a fresh temp DB. This is
 * the only app harness — the legacy all-in-one `buildApp` is gone, so device
 * enrollment goes through `enrollDevice()` below rather than a session cookie. */
export async function makeRelayApp(configOverrides: Partial<Config> = {}): Promise<TestApp> {
  const { db, dir, cleanup: cleanupDb } = makeDb();
  const config = makeConfig(dir, configOverrides);
  const app = await buildRelayApp(db, config);
  app.log.level = 'silent';
  await app.ready();
  return {
    db,
    dir,
    config,
    app,
    cleanup: async () => {
      await app.close();
      await new Promise((r) => setTimeout(r, 30));
      cleanupDb();
    },
  };
}

/** Enroll a fresh device key for a (new or given) account directly in the DB,
 * then run the real challenge → signed-nonce → token flow so the caller gets a
 * genuine device bearer. Bypasses no auth logic on the token path; it only
 * skips the enrollment transport (register / QR pairing), which is what makes
 * it usable regardless of the relay's registration mode. */
export async function enrollDevice(
  app: FastifyInstance,
  db: DB,
  opts: { userId?: string; handle?: string } = {},
): Promise<{ bearer: string; token: string; userId: string; deviceId: string }> {
  const userId = opts.userId ?? seedUser(db, { handle: opts.handle });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const raw = spki.subarray(spki.length - 32);
  const pubKey = raw.toString('base64');
  const deviceId = fingerprintB64url(raw);
  if (!db.enrollRelayDevice(userId, deviceId, pubKey, 'test-device')) {
    throw new Error('device enrollment failed');
  }

  const info = await app.inject({ method: 'GET', url: '/api/relay/info' });
  const nonce = (await app.inject({ method: 'POST', url: '/api/relay/auth/challenge' })).json()
    .nonce as string;
  const signature = edSign(
    null,
    Buffer.from(`${nonce}|${info.json().identityFingerprint as string}`),
    privateKey,
  ).toString('base64');
  const res = await app.inject({
    method: 'POST',
    url: '/api/relay/auth/token',
    payload: { pubKey, nonce, signature },
  });
  const token = res.json().token as string;
  return { bearer: `Bearer ${token}`, token, userId, deviceId };
}

export interface SeedUserOpts {
  id?: string;
  role?: 'admin' | 'member';
  displayName?: string;
  handle?: string;
  publicKey?: string;
}

/** Insert a user (and optional display name / handle / public key) directly. */
export function seedUser(db: DB, opts: SeedUserOpts = {}): string {
  const id = opts.id ?? randomBytes(8).toString('hex');
  db.createUser({ id, role: opts.role ?? 'member' }); // auto-assigns a handle
  if (opts.handle) db.setUserHandle(id, opts.handle);
  if (opts.displayName) db.setDisplayName(id, opts.displayName);
  if (opts.publicKey) {
    db.raw.prepare('UPDATE users SET public_key = ? WHERE id = ?').run(opts.publicKey, id);
  }
  return id;
}

/** Make A and B friends directly (skips the invite/redeem/accept dance). */
export function makeFriends(db: DB, a: string, b: string): void {
  db.addFriendPair(a, b);
}
