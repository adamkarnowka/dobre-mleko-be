// Writes the OpenAPI document without a database or real secrets: `npm run openapi -- out.json`.
// API_URL sets the server URL shown in the docs.
import { writeFile } from 'node:fs/promises';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Fills in what can't be derived from the route schemas. */
function polish(doc: Json, serverUrl: string): Json {
  doc.servers = [{ url: serverUrl }];
  for (const [path, ops] of Object.entries<Json>(doc.paths)) {
    for (const [method, op] of Object.entries<Json>(ops)) {
      // GET /places/{id}/comments → getPlacesByIdComments
      op.operationId ??=
        method +
        path
          .split('/')
          .filter(Boolean)
          .map((seg) => seg.replace(/^\{(.+)\}$/, 'By-$1'))
          .flatMap((seg) => seg.split('-'))
          .map((w) => w[0]!.toUpperCase() + w.slice(1))
          .join('');
      for (const [status, res] of Object.entries<Json>(op.responses ?? {})) {
        if (res.description === 'Default Response') res.description = status === '4XX' ? 'Error' : 'OK';
      }
      if (!Object.keys(op.responses ?? {}).some((s) => s.startsWith('2'))) {
        op.responses = { 204: { description: 'Done, no content' }, ...op.responses };
      }
    }
    if (path === '/places/{id}/photos') {
      ops.post.requestBody = {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              properties: { photo: { type: 'string', format: 'binary' } },
              required: ['photo'],
            },
          },
        },
      };
    }
    if (path === '/photos/{hash}') {
      ops.get.responses = {
        200: {
          description: 'The image',
          content: Object.fromEntries(
            ['image/jpeg', 'image/png', 'image/webp'].map((t) => [t, { schema: { type: 'string', format: 'binary' } }]),
          ),
        },
        ...ops.get.responses,
      };
      delete ops.get.responses['204'];
    }
  }

  // Drop component schemas no operation reaches (the type provider also emits unused *Input variants).
  const schemas: Json = doc.components.schemas;
  const reachable = new Set<string>();
  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string' && v.startsWith('#/components/schemas/')) {
        const name = v.slice('#/components/schemas/'.length);
        if (!reachable.has(name)) {
          reachable.add(name);
          visit(schemas[name]);
        }
      } else visit(v);
    }
  };
  visit(doc.paths);
  for (const name of Object.keys(schemas)) if (!reachable.has(name)) delete schemas[name];
  return doc;
}

const out = process.argv[2] ?? 'openapi.json';
const config = loadConfig({
  DATABASE_URL: 'postgres://unused@localhost/unused',
  JWT_SECRET: 'x'.repeat(32),
  // Document the development-only sign-in too; its description says so.
  DEV_LOGIN: 'true',
});
const sql = createDb(config.DATABASE_URL); // never queried
const app = await buildApp({ config, sql });
await app.ready();
const serverUrl = process.env.API_URL || 'http://localhost:8080';
await writeFile(out, JSON.stringify(polish(app.swagger() as Json, serverUrl), null, 2) + '\n');
await app.close();
await sql.end();
console.log(`Wrote ${out}`);
