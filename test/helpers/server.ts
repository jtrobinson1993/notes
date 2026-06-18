import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { openDb, type DB } from '../../server/src/db.js';
import { buildApp } from '../../server/src/app.js';
import type { Config } from '../../server/src/config.js';

export const TEST_ORIGIN = 'http://localhost:3000';

// A minimal real index.html so buildApp registers fastify-static instead of
// logging "web dist not found" once per app build.
const FIXTURE_WEBDIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'webdist');

export function makeConfig(dataDir: string, overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    dataDir,
    appOrigin: TEST_ORIGIN,
    rpId: 'localhost',
    appName: 'Notes',
    webDist: FIXTURE_WEBDIST,
    klipyApiKey: null,
    // Effectively unlimited so the rate limiter never interferes with a suite
    // that fires many requests; rate-limit behavior is covered explicitly.
    rateLimitMax: 1_000_000,
    voice: { announcedIp: '127.0.0.1', listenIp: '127.0.0.1', rtcMinPort: 40000, rtcMaxPort: 40100 },
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

/** Build the real Fastify app over a fresh temp DB. Logger is silenced so test
 * output stays readable. */
export async function makeApp(configOverrides: Partial<Config> = {}): Promise<TestApp> {
  const { db, dir, cleanup: cleanupDb } = makeDb();
  const config = makeConfig(dir, configOverrides);
  const app = await buildApp(db, config);
  // buildApp hardcodes logger:true; quiet it for tests.
  app.log.level = 'silent';
  await app.ready();
  return {
    db,
    dir,
    config,
    app,
    cleanup: async () => {
      // Closing the app terminates live sockets; their 'close' handlers in
      // realtime.ts touch the DB, so let those drain before closing it.
      await app.close();
      await new Promise((r) => setTimeout(r, 30));
      cleanupDb();
    },
  };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64');
}

export interface SeedUserOpts {
  id?: string;
  username?: string;
  role?: 'admin' | 'member';
  displayName?: string;
  publicKey?: string;
}

/** Insert a user (and optional display name / public key) directly. */
export function seedUser(db: DB, opts: SeedUserOpts = {}): string {
  const id = opts.id ?? randomBytes(8).toString('hex');
  const username = opts.username ?? `user_${id.slice(0, 6)}`;
  db.createUser({ id, username, role: opts.role ?? 'member' });
  if (opts.displayName) db.setDisplayName(id, opts.displayName);
  if (opts.publicKey) {
    db.raw.prepare('UPDATE users SET public_key = ? WHERE id = ?').run(opts.publicKey, id);
  }
  return id;
}

/** The auth seam: create a real session row and return the matching cookie
 * header value, bypassing the WebAuthn ceremony. */
export function authCookie(db: DB, userId: string, recovery = false): string {
  const token = randomBytes(32).toString('base64url');
  db.createSession({ id: hashToken(token), userId, expiresAt: Date.now() + 3_600_000, recovery });
  return `${'notes_session'}=${token}`;
}

/** Seed a user and return both the id and an authenticated cookie. */
export function seedAuthedUser(db: DB, opts: SeedUserOpts = {}): { id: string; cookie: string } {
  const id = seedUser(db, opts);
  return { id, cookie: authCookie(db, id) };
}

/** Make A and B friends directly (skips the invite/redeem/accept dance). */
export function makeFriends(db: DB, a: string, b: string): void {
  db.addFriendPair(a, b);
}
