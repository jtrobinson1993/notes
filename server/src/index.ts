import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { buildApp } from './app.js';
import { startBackups } from './backup.js';

const config = loadConfig();
const db = openDb(config.dataDir);
const app = await buildApp(db, config);

setInterval(() => db.cleanup(), 60 * 60 * 1000).unref();
startBackups(db, config.dataDir, app.log);

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`origin: ${config.appOrigin} (rpId: ${config.rpId})`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
