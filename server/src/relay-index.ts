import { existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { buildRelayApp } from './relay-app.js';
import { startBackups } from './backup.js';

// Standalone v8 relay entrypoint (spec/relay.md) — the operator's server. Runs
// only the relay surface; no web app, no legacy auth. Operator tasks (invites,
// device management) are the relay CLI (`npm run relay -- …`), not a frontend.

// Load integration secrets from a gitignored .env if present (same as the
// monolith). Must precede loadConfig(), which reads process.env.
for (const envPath of ['.env', '../.env']) {
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
    break;
  }
}

const config = loadConfig();
const db = openDb(config.dataDir);
const app = await buildRelayApp(db, config);

// Housekeeping: sweep expired challenges/invites (incl. relay + registration
// invites) hourly, and keep periodic DB backups.
setInterval(() => {
  db.cleanup();
  db.pruneRelayInvites(30 * 24 * 60 * 60_000);
  db.pruneRegistrationInvites(30 * 24 * 60 * 60_000);
}, 60 * 60 * 1000).unref();
startBackups(db, config.dataDir, app.log);

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`relay listening (registration: ${config.registrationMode})`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
