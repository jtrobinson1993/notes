import { existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { buildRelayApp } from './relay-app.js';
import { startBackups } from './backup.js';
import {
  identityBundlePath,
  ingestIdentityBundle,
  isExpired,
  loadRelayIdentity,
  relayIdentityMissing,
  RelayIdentityError,
} from './relayIdentity.js';
import { DELEGATION_WARN_DAYS } from './relayIdentityAdmin.js';

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

// Boot step 1: ingest the identity bundle the operator dropped into DATA_DIR
// (or RELAY_IDENTITY_FILE) — the root PUBLIC key, the online keypair and the
// root-signed delegation. This is what makes deploying "copy one file and
// start": there is no setup command to run on the server, and re-reading the
// same bundle on every restart is a no-op.
//
// Boot step 2: the relay refuses to run without an identity (spec/relay.md). It
// used to mint one lazily on first boot, which put the pinned anchor's private
// half on the server disk and made a breach unrecoverable. Fail closed, and say
// exactly what to run — this is the first thing a new operator will see, so it
// gets a clean message rather than a stack trace.
const bundleFile = identityBundlePath(config.dataDir);
let app;
try {
  const ingest = ingestIdentityBundle(db, config.dataDir);
  // Say where we looked. loadRelayIdentity's own message can only name the
  // conventional filename; here we know the exact path this deployment uses.
  if (ingest.outcome === 'absent' && db.getRelayRootPubkey() === undefined) {
    throw new RelayIdentityError(relayIdentityMissing(bundleFile));
  }
  app = await buildRelayApp(db, config);
  if (ingest.outcome === 'installed') {
    app.log.info(`installed relay identity delegation v${ingest.version} from ${ingest.path}`);
  } else if (ingest.outcome === 'stale') {
    // Not fatal, and not honored: the database is already on a newer
    // delegation, and rolling back to a superseded (possibly stolen) online key
    // is exactly what the version counter exists to prevent.
    app.log.warn(
      `ignoring the identity bundle at ${ingest.path}: it carries delegation v${ingest.version}, ` +
        'older than the one already installed. Replace it with the newest bundle to keep the two in sync.',
    );
  }
} catch (err) {
  if (err instanceof RelayIdentityError) {
    process.stderr.write(`\n${err.message}\n\n`);
    process.exit(1);
  }
  throw err;
}

// Housekeeping: sweep expired challenges/invites (incl. relay + registration
// invites) hourly, and keep periodic DB backups.
setInterval(() => {
  db.cleanup();
  db.pruneRelayInvites(30 * 24 * 60 * 60_000);
  db.pruneRegistrationInvites(30 * 24 * 60 * 60_000);
}, 60 * 60 * 1000).unref();
startBackups(db, config.dataDir, app.log);

// A delegation clients will refuse (expired) or are about to (nearly expired)
// is an outage the operator can prevent with one command, so say so every boot.
// Only the operator can fix it: renewing needs the offline root private key.
{
  const { delegation } = loadRelayIdentity(db);
  const daysLeft = Math.floor((delegation.notAfter - Date.now()) / (24 * 60 * 60_000));
  if (isExpired(delegation)) {
    app.log.error(
      `relay delegation v${delegation.version} EXPIRED ${-daysLeft}d ago — clients will refuse this relay. ` +
        'Renew it: npm run relay -- rotate-online-key',
    );
  } else if (daysLeft <= DELEGATION_WARN_DAYS) {
    app.log.warn(
      `relay delegation v${delegation.version} expires in ${daysLeft}d — renew it with ` +
        '`npm run relay -- rotate-online-key` (needs the offline root key)',
    );
  }
}

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`relay listening (registration: ${config.registrationMode})`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
