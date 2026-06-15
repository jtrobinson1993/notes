import { existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { buildApp } from './app.js';
import { startBackups } from './backup.js';

// Load integration secrets (KLIPY_API_KEY, …) from a gitignored .env if present.
// Documented in .env.example. Check cwd (prod/docker run from repo root) and the
// repo root relative to the server/ workspace (dev runs there). Must precede
// loadConfig(), which reads process.env.
for (const envPath of ['.env', '../.env']) {
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
    break;
  }
}

const config = loadConfig();
const db = openDb(config.dataDir);
const app = await buildApp(db, config);

setInterval(() => {
  db.cleanup();
  db.purgeExpiredInvites();
}, 60 * 60 * 1000).unref();
startBackups(db, config.dataDir, app.log);

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`origin: ${config.appOrigin} (rpId: ${config.rpId})`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
