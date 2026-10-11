import { constants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { buildApp } from './app.js';
import { ensureAdmins } from './auth.js';
import { loadConfig } from './config.js';
import { createDb, migrate } from './db.js';

const config = loadConfig();

// Fail at startup, not on the first upload, if the photo volume is missing or read-only.
await mkdir(config.PHOTO_DIR, { recursive: true });
await access(config.PHOTO_DIR, constants.W_OK);
const sql = createDb(config.DATABASE_URL);

const applied = await migrate(sql);
await ensureAdmins(sql, config.ADMIN_EMAILS);
const app = await buildApp({ config, sql, logger: true });
if (applied.length) app.log.info({ applied }, 'migrations applied');
if (!config.ADMIN_EMAILS.length) app.log.warn('ADMIN_EMAILS is empty: nobody can open the admin dashboard');

const shutdown = async () => {
  await app.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ host: '0.0.0.0', port: config.PORT });
