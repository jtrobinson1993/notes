// Relay operator CLI (spec/relay.md). Two kinds of command live here, and the
// difference matters:
//
//   • `init-identity` and `rotate-online-key` run on the OPERATOR'S OWN MACHINE.
//     They open no database, read no DATA_DIR, and reach no server — they are
//     pure key generation, writing an identity *bundle* file the operator then
//     copies to the relay. That is what keeps the relay's trust anchor off the
//     relay: the root private key is printed once and never persisted anywhere.
//
//   • everything else operates directly on the relay's SQLite database at
//     DATA_DIR — invites, devices, status.
//
//   npm run relay -- <command> [args]

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { openDb, type DB } from './db.js';
import {
  BUNDLE_FILENAME,
  parseIdentityBundle,
  RelayIdentityError,
  type IdentityBundle,
} from './relayIdentity.js';
import {
  identitySummary,
  initIdentity,
  rotateOnlineKey,
  DELEGATION_DEFAULT_DAYS,
} from './relayIdentityAdmin.js';

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
 *  running relay. Absolute paths (recommended) are used as-is. An *empty*
 *  DATA_DIR falls back to the default rather than resolving to the cwd, which
 *  would silently target (and create) a database somewhere unintended. */
function resolveDataDir(): string {
  const dir = process.env.DATA_DIR?.trim() || './data';
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
    `Relay operator CLI.\n\n` +
      `Usage: npm run relay -- <command> [options]\n\n` +
      `On YOUR OWN MACHINE (no database, no DATA_DIR, no server — pure key generation):\n` +
      `  init-identity              Create the relay's identity: an offline ROOT key that\n` +
      `                             delegates to an online signing key. Writes ${BUNDLE_FILENAME}\n` +
      `                             (root PUBLIC key + online keypair + delegation v1) and prints\n` +
      `                             the root PRIVATE key ONCE — store it in a password manager.\n` +
      `                             Deploy by copying that file into the relay's DATA_DIR.\n` +
      `                               --out PATH     where to write the bundle (default ./${BUNDLE_FILENAME})\n` +
      `                               --days N       delegation lifetime (default ${DELEGATION_DEFAULT_DAYS})\n` +
      `                               --if-missing   do nothing if the bundle already exists\n` +
      `                               --force        overwrite an existing bundle (new relay identity)\n\n` +
      `  rotate-online-key          Revoke the online key and delegate to a fresh one at version+1.\n` +
      `                             Reads the root private key from stdin or ACCORD_RELAY_ROOT_KEY\n` +
      `                             and never stores it. Writes a new bundle to install the same\n` +
      `                             way. The pinned fingerprint does NOT change, so no client has\n` +
      `                             to re-register.\n` +
      `                               --in PATH      the bundle being replaced (default ./${BUNDLE_FILENAME})\n` +
      `                               --current-version N   if you no longer have that bundle\n` +
      `                               --out PATH     where to write (default: over --in)\n` +
      `                               --days N       delegation lifetime (default ${DELEGATION_DEFAULT_DAYS})\n\n` +
      `On the RELAY (these read the database at DATA_DIR, default ./data):\n` +
      `  create-invite [--days N]   Mint a one-time registration invite; prints the code to share.\n` +
      `                             (default expiry ${REGISTRATION_INVITE_DEFAULT_DAYS} days)\n` +
      `  list-devices               List every enrolled device (id, owner handle, name, state).\n` +
      `  revoke-device <id>         Revoke a device by id (stops honoring its next auth).\n` +
      `  status                     Identity, accounts, devices, and registration mode.\n` +
      `  prune                      Drop expired/used invites past their grace window.\n` +
      `  help                       Show this help.\n`,
  );
}

/** The root private key for `rotate-online-key`: from ACCORD_RELAY_ROOT_KEY, or
 *  piped on stdin. Never a flag (argv is visible to every process on the box and
 *  lands in shell history), and never written anywhere by us. */
function readRootPrivateKey(): string | null {
  const fromEnv = process.env.ACCORD_RELAY_ROOT_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv;
  if (process.stdin.isTTY) return null;
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return null;
  }
}

const ROOT_KEY_HELP =
  'Supply the root private key — the one `init-identity` printed:\n\n' +
  '  npm run relay -- rotate-online-key < root-key.txt\n' +
  '  ACCORD_RELAY_ROOT_KEY="$(pass accord/relay-root)" npm run relay -- rotate-online-key\n\n' +
  'It is used to sign one delegation and then dropped; nothing writes it to disk.\n';

function num(flags: Map<string, string>, name: string): number | undefined {
  const raw = flags.get(name);
  return raw === undefined ? undefined : Number(raw);
}

/** Resolve a bundle path against where the operator actually ran `npm run`
 *  (INIT_CWD), not this workspace's cwd — the `-w server` hop would otherwise
 *  write the file somewhere surprising. */
function resolveBundlePath(flags: Map<string, string>, flag: string): string {
  const given = flags.get(flag) ?? BUNDLE_FILENAME;
  return isAbsolute(given) ? given : resolve(process.env.INIT_CWD ?? process.cwd(), given);
}

/** Write a bundle with owner-only permissions: it carries the ONLINE private
 *  key (not the root's, which is never written at all), and that key signs the
 *  key-transparency log. */
function writeBundle(path: string, bundle: IdentityBundle): void {
  writeFileSync(path, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
}

function bundleSummary(bundle: IdentityBundle): string {
  return (
    `Root fingerprint:   ${bundle.rootFingerprint}\n` +
    `                    (this is what clients pin, and what an invite carries)\n` +
    `Online key:         ${bundle.delegation.onlineKey}\n` +
    `Delegation version: ${bundle.delegation.version}\n` +
    `Delegation expires: ${fmtTime(bundle.delegation.notAfter)}\n`
  );
}

/** Where the operator has to put the bundle, and what happens then. */
function deployInstructions(path: string): string {
  return (
    `\nBundle written to:  ${path}\n` +
    `It holds the root PUBLIC key, the online keypair and the delegation — no root\n` +
    `private key, so copying it around does not copy your anchor.\n\n` +
    `Deploy it (no extra commands on the relay — it ingests this at boot):\n\n` +
    `  scp ${path} you@relay:/srv/accord-data/${BUNDLE_FILENAME}\n` +
    `  # or, with docker compose:  docker compose cp ${path} notes:/data/${BUNDLE_FILENAME}\n` +
    `  # then start (or restart) the relay.\n\n` +
    `The relay reads it from DATA_DIR/${BUNDLE_FILENAME} (or RELAY_IDENTITY_FILE) every\n` +
    `boot: installing is idempotent, and dropping in a rotated bundle takes effect on\n` +
    `the next restart. Leaving the file in place is fine and expected.\n`
  );
}

/** `init-identity` — runs anywhere, touches no relay state. */
function cmdInitIdentity(flags: Map<string, string>): void {
  const out = resolveBundlePath(flags, 'out');
  if (existsSync(out)) {
    if (flags.get('if-missing') === 'true') {
      process.stdout.write(`An identity bundle already exists at ${out}; leaving it alone.\n`);
      return;
    }
    if (flags.get('force') !== 'true') {
      process.stderr.write(
        `${out} already exists — refusing to overwrite it.\n\n` +
          'That file is a relay identity. Replacing it mints a NEW root, which every client has\n' +
          'pinned: a relay that switched to it would look exactly like a substitution attack, and\n' +
          'every account would have to re-register. To replace the ONLINE key instead (which keeps\n' +
          'the anchor, and is almost certainly what you want):\n\n' +
          '  npm run relay -- rotate-online-key\n\n' +
          'If you really are setting up a brand-new relay here, pass --force or --out <other path>.\n',
      );
      process.exitCode = 1;
      return;
    }
  }
  const { bundle, rootPrivKey } = initIdentity({ days: num(flags, 'days') });
  writeBundle(out, bundle);
  process.stdout.write(
    `Relay identity created.\n\n${bundleSummary(bundle)}` +
      `\n================= ROOT PRIVATE KEY — SHOWN ONCE =================\n\n` +
      `${rootPrivKey}\n\n` +
      `Store it in your password manager NOW. It was not written to any file: not the\n` +
      `bundle, not this directory, nowhere. Nothing can print it again.\n\n` +
      `You need it only to rotate the online key after a breach, or to renew the\n` +
      `delegation before it expires. Losing it means the relay cannot be recovered from\n` +
      `a compromise, and every account must move to a new relay when the delegation\n` +
      `expires. It must never be copied onto the relay — that would undo the whole\n` +
      `point of keeping it here.\n` +
      `=================================================================\n` +
      deployInstructions(out),
  );
}

/** `rotate-online-key` — also runs on the operator's machine. */
function cmdRotateOnlineKey(flags: Map<string, string>): void {
  const inPath = resolveBundlePath(flags, 'in');
  let previous: IdentityBundle | undefined;
  if (existsSync(inPath)) {
    previous = parseIdentityBundle(readFileSync(inPath, 'utf8'));
  } else if (flags.get('current-version') === undefined) {
    process.stderr.write(
      `No bundle at ${inPath}, and no --current-version given.\n\n` +
        'Rotation must know the delegation version the relay is on, so the new one strictly\n' +
        'exceeds it (otherwise the relay would refuse the result as a rollback). Either point\n' +
        '--in at the bundle you are replacing, or read the version off the running relay\n' +
        '(`GET /api/relay/info` → delegation.version) and pass --current-version N.\n',
    );
    process.exitCode = 1;
    return;
  }

  const rootPrivKey = readRootPrivateKey();
  if (!rootPrivKey) {
    process.stderr.write(ROOT_KEY_HELP);
    process.exitCode = 1;
    return;
  }
  const bundle = rotateOnlineKey({
    rootPrivKey,
    previous,
    currentVersion: num(flags, 'current-version'),
    days: num(flags, 'days'),
  });
  const out = flags.get('out') ? resolveBundlePath(flags, 'out') : inPath;
  writeBundle(out, bundle);
  process.stdout.write(
    `Online key rotated to v${bundle.delegation.version}.\n\n${bundleSummary(bundle)}\n` +
      `The previous online key is revoked: once the relay installs this delegation it\n` +
      `deletes that key's private half, and a client seeing v${bundle.delegation.version} refuses to accept an\n` +
      `older one. The pinned fingerprint is unchanged, so no client has to re-register.\n` +
      deployInstructions(out),
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
    identitySummary(db) +
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

/** The identity commands: no relay database is opened, so they work on a laptop
 *  that has never seen the relay — no DATA_DIR, no server, nothing to break.
 *  Returns false if `command` isn't one of them. */
function runOffline(command: string, flags: Map<string, string>): boolean {
  if (command === 'init-identity') {
    cmdInitIdentity(flags);
    return true;
  }
  if (command === 'rotate-online-key') {
    cmdRotateOnlineKey(flags);
    return true;
  }
  return false;
}

function runWithDb(command: string, positional: string[], flags: Map<string, string>, db: DB): void {
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
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    usage();
    return;
  }
  const { positional, flags } = parseArgs(rest);
  try {
    if (runOffline(command, flags)) return;
    const db = openDb(resolveDataDir());
    try {
      runWithDb(command, positional, flags, db);
    } finally {
      db.raw.close();
    }
  } catch (err) {
    // A bad key or a refused version is an operator mistake, not a crash: print
    // the sentence, not a stack trace.
    if (err instanceof RelayIdentityError) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

main();
