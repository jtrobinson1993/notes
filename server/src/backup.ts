import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { DB } from './db.js';

/** Periodic SQLite backups. The database only ever contains ciphertext and
 * public keys, so the backups are E2E-encrypted by construction. Attachment
 * blobs live in DATA_DIR/blobs and are likewise ciphertext; back up the whole
 * data volume to capture them. */
export function startBackups(db: DB, dataDir: string, log: FastifyBaseLogger): void {
  const intervalHours = Number(process.env.BACKUP_INTERVAL_HOURS ?? 24);
  const keep = Math.max(1, Number(process.env.BACKUP_KEEP ?? 14));
  if (!(intervalHours > 0)) {
    log.info('backups disabled (BACKUP_INTERVAL_HOURS=0)');
    return;
  }
  const backupDir = join(dataDir, 'backups');
  mkdirSync(backupDir, { recursive: true });

  async function run(): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
    const target = join(backupDir, `notes-${stamp}.db`);
    try {
      await db.raw.backup(target);
      const old = readdirSync(backupDir)
        .filter((f) => f.startsWith('notes-') && f.endsWith('.db'))
        .sort()
        .slice(0, -keep);
      for (const f of old) unlinkSync(join(backupDir, f));
      log.info(`backup written: ${target}`);
    } catch (err) {
      log.error({ err }, 'backup failed');
    }
  }

  setTimeout(run, 60_000).unref(); // first backup shortly after boot
  setInterval(run, intervalHours * 60 * 60 * 1000).unref();
}
