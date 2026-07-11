// Relay operator CLI (spec/relay.md). Operates directly on the relay DB — no
// running server, no frontend. This is the operator interface for a
// zero-knowledge relay: seed a fresh relay, mint registration invites, and
// manage enrolled devices.
//
//   npm run relay -- <command> [args]
//
// Honors DATA_DIR (same as the server) to locate the SQLite database.

import { existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { openDb, type DB } from './db.js';

// Load DATA_DIR (and RELAY_REGISTRATION_MODE) from the same gitignored .env the
// relay server reads, so `npm run relay -- …` targets the server's database
// without a per-command DATA_DIR prefix. Checked before any DATA_DIR read below.
for (const envPath of ['.env', '../.env']) {
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
    break;
  }
}

/** Resolve DATA_DIR the way the operator expects: relative paths are relative to
 *  where they ran `npm run` (INIT_CWD), not this workspace's cwd — otherwise the
 *  `-w server` hop would silently point the CLI at a different directory than the
 *  running relay. Absolute paths (recommended) are used as-is. */
function resolveDataDir(): string {
  const dir = process.env.DATA_DIR ?? './data';
  if (isAbsolute(dir)) return dir;
  return resolve(process.env.INIT_CWD ?? process.cwd(), dir);
}

const REGISTRATION_INVITE_DEFAULT_DAYS = 7;

/** hash(token) exactly as POST /api/relay/register computes it, so a token this
 *  CLI prints redeems against the row it stores. */
function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

function fmtTime(ms: number): string {
  return new Date(ms).toISOString();
}

function usage(): void {
  process.stdout.write(
    `Relay operator CLI — operates on the relay DB at DATA_DIR (default ./data).\n\n` +
      `Usage: npm run relay -- <command> [options]\n\n` +
      `Commands:\n` +
      `  create-invite [--days N]   Mint a one-time registration invite; prints the code to share.\n` +
      `                             (default expiry ${REGISTRATION_INVITE_DEFAULT_DAYS} days)\n` +
      `  list-devices               List every enrolled device (id, owner handle, name, state).\n` +
      `  revoke-device <id>         Revoke a device by id (stops honoring its next auth).\n` +
      `  status                     Summarize accounts, devices, and live registration invites.\n` +
      `  prune                      Drop expired/used invites past their grace window.\n` +
      `  help                       Show this help.\n`,
  );
}

/** Parse `--flag value` / `--flag=value` pairs and positional args. */
function parseArgs(argv: string[]): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) flags.set(a.slice(2, eq), a.slice(eq + 1));
      else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) (flags.set(a.slice(2), next), i++);
        else flags.set(a.slice(2), 'true');
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function createInvite(db: DB, flags: Map<string, string>): void {
  const days = Number(flags.get('days') ?? REGISTRATION_INVITE_DEFAULT_DAYS);
  if (!Number.isFinite(days) || days <= 0) {
    process.stderr.write('--days must be a positive number\n');
    process.exitCode = 1;
    return;
  }
  const token = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + days * 24 * 60 * 60_000;
  db.mintRegistrationInvite(tokenHash(token), expiresAt);
  process.stdout.write(
    `Registration invite created (expires ${fmtTime(expiresAt)}).\n` +
      `Share this code — it can be used once:\n\n  ${token}\n\n`,
  );
}

function listDevices(db: DB): void {
  const devices = db.listAllRelayDevices();
  if (devices.length === 0) {
    process.stdout.write('No devices enrolled.\n');
    return;
  }
  for (const d of devices) {
    const state = d.revoked ? 'REVOKED' : 'active';
    process.stdout.write(
      `${d.id}  ${(d.handle ?? d.userId).padEnd(14)}  ${state.padEnd(8)}  ${d.name ?? '(unnamed)'}  ${fmtTime(d.createdAt)}\n`,
    );
  }
}

function revokeDevice(db: DB, positional: string[]): void {
  const id = positional[0];
  if (!id) {
    process.stderr.write('usage: revoke-device <id>\n');
    process.exitCode = 1;
    return;
  }
  if (db.revokeRelayDeviceById(id)) process.stdout.write(`Revoked device ${id}.\n`);
  else {
    process.stderr.write(`No device with id ${id}.\n`);
    process.exitCode = 1;
  }
}

function status(db: DB): void {
  const mode = process.env.RELAY_REGISTRATION_MODE === 'public' ? 'public' : 'invite';
  const devices = db.listAllRelayDevices();
  const active = devices.filter((d) => !d.revoked).length;
  process.stdout.write(
    `Registration mode: ${mode}\n` +
      `Accounts:          ${db.userCount()}\n` +
      `Devices:           ${devices.length} (${active} active, ${devices.length - active} revoked)\n`,
  );
}

function prune(db: DB): void {
  const grace = 30 * 24 * 60 * 60_000;
  const reg = db.pruneRegistrationInvites(grace);
  const friend = db.pruneRelayInvites(grace);
  process.stdout.write(`Pruned ${reg} registration invite(s) and ${friend} friend invite(s).\n`);
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    usage();
    return;
  }
  const { positional, flags } = parseArgs(rest);
  const db = openDb(resolveDataDir());
  try {
    switch (command) {
      case 'create-invite':
        return createInvite(db, flags);
      case 'list-devices':
        return listDevices(db);
      case 'revoke-device':
        return revokeDevice(db, positional);
      case 'status':
        return status(db);
      case 'prune':
        return prune(db);
      default:
        process.stderr.write(`Unknown command: ${command}\n\n`);
        usage();
        process.exitCode = 1;
    }
  } finally {
    db.raw.close();
  }
}

main();
