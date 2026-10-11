import { createDb, migrate } from './db.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const sql = createDb(url);
const applied = await migrate(sql);
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Up to date');
await sql.end();
