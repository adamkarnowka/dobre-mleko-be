import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb, migrate } from './db.js';

const config = loadConfig();
const sql = createDb(config.DATABASE_URL);

const applied = await migrate(sql);
const app = await buildApp({ config, sql, logger: true });
if (applied.length) app.log.info({ applied }, 'migrations applied');
if (!config.ALLOWED_EMAILS.length) app.log.warn('ALLOWED_EMAILS is empty: nobody can sign in');

const shutdown = async () => {
  await app.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ host: '0.0.0.0', port: config.PORT });
