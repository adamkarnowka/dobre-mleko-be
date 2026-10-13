import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureAdmins, type GoogleIdentity } from '../src/auth.js';
import { loadConfig, type Config } from '../src/config.js';
import { createDb, migrate, type Sql } from '../src/db.js';
import { HttpError } from '../src/errors.js';
import type { PushMessage, PushResult, PushSender, PushTarget } from '../src/push.js';

export const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://mleko:mleko@localhost:5432/mleko_test';

/** One photo directory per test file, removed afterwards. */
export const PHOTO_DIR = mkdtempSync(join(tmpdir(), 'mleko-photos-'));

/** Whitelisted as members before each test; ADMIN is the admin from the environment. */
export const ALLOWED = ['ola@gmail.com', 'kuba@gmail.com', 'tomek@gmail.com'];
export const ADMIN = 'marta@gmail.com';

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL,
    ADMIN_EMAILS: ADMIN,
    GOOGLE_CLIENT_IDS: 'test-client',
    JWT_SECRET: 'test-secret-test-secret-test-secret-123',
    PHOTO_DIR,
    ...overrides,
  });
}

/** Fake Google: the ID token "google:<email>[:unverified]" stands for that account. */
export async function fakeGoogle(idToken: string): Promise<GoogleIdentity> {
  const [prefix, email, flag] = idToken.split(':');
  if (prefix !== 'google' || !email) throw new HttpError(401, 'invalid_google_token', 'bad token');
  return {
    sub: `sub-${email}`,
    email,
    emailVerified: flag !== 'unverified',
    name: email.split('@')[0]!.replace(/^./, (c) => c.toUpperCase()),
    picture: null,
  };
}

export type TestApp = Awaited<ReturnType<typeof buildApp>>;

/** Records push notifications instead of calling APNs; tokens in `gone` are reported as no longer valid. */
export class FakePushSender implements PushSender {
  configured = true;
  sent: { token: string; title: string; body: string; placeId?: string | null }[] = [];
  gone = new Set<string>();
  async send(target: PushTarget, message: PushMessage): Promise<PushResult> {
    this.sent.push({ token: target.token, ...message });
    return this.gone.has(target.token) ? 'gone' : 'delivered';
  }
  close(): void {}
}

export const pushes = new FakePushSender();

export interface Harness {
  sql: Sql;
  app: TestApp;
  clock: { now: Date };
  build: (overrides?: Record<string, string>) => Promise<TestApp>;
}

/** The categories migration 007 creates, restored before each test. */
let defaultCategories: Record<string, unknown>[] = [];
let defaultIcons: Record<string, unknown>[] = [];

/** Fresh schema per test file, tables truncated before each test (categories reset to the defaults). */
export function setup(): Harness {
  const h = { clock: { now: new Date('2026-10-11T12:00:00Z') } } as Harness;

  beforeAll(async () => {
    h.sql = createDb(DATABASE_URL);
    await h.sql.unsafe('drop schema public cascade; create schema public;');
    await migrate(h.sql);
    defaultIcons = await h.sql`select * from icons`;
    defaultCategories = await h.sql`select * from categories`;
    h.build = (overrides = {}) =>
      buildApp({
        config: testConfig(overrides),
        sql: h.sql,
        verifyGoogle: fakeGoogle,
        now: () => h.clock.now,
        settingsCacheMs: 0,
        pushSender: pushes,
      });
    h.app = await h.build();
  });

  beforeEach(async () => {
    h.clock.now = new Date('2026-10-11T12:00:00Z');
    await h.sql`truncate users, places, place_photos, ratings, stars, comments, saved_places, allowed_emails, settings, categories, icons, push_log cascade`;
    pushes.sent = [];
    pushes.gone.clear();
    await h.sql`insert into icons ${h.sql(defaultIcons)}`;
    await h.sql`insert into categories ${h.sql(defaultCategories)}`;
    rmSync(PHOTO_DIR, { recursive: true, force: true });
    await ensureAdmins(h.sql, [ADMIN]);
    for (const email of ALLOWED) await h.sql`insert into allowed_emails (email) values (${email})`;
  });

  afterAll(async () => {
    await h.app?.close();
    await h.sql?.end();
    rmSync(PHOTO_DIR, { recursive: true, force: true });
  });

  return h;
}

export type Who = { id: string; headers: { authorization: string } };

export async function login(app: TestApp, email: string): Promise<Who> {
  const res = await app.inject({ method: 'POST', url: '/auth/google', payload: { id_token: `google:${email}` } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const body = res.json();
  return { id: body.user.id, headers: { authorization: `Bearer ${body.token}` } };
}

/** A real, decodable JPEG; different seeds give different files. */
export async function makeImage(seed = 0, width = 64, height = 48): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: (seed * 37) % 256, g: (seed * 91) % 256, b: 120 } },
  })
    .jpeg()
    .toBuffer();
}

export function multipart(parts: { name: string; value: string | Buffer; filename?: string; type?: string }[]) {
  const boundary = '----mleko' + Math.random().toString(16).slice(2);
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const head =
      `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"` +
      (p.filename ? `; filename="${p.filename}"\r\nContent-Type: ${p.type ?? 'application/octet-stream'}` : '') +
      '\r\n\r\n';
    chunks.push(Buffer.from(head), Buffer.isBuffer(p.value) ? p.value : Buffer.from(p.value), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

export async function upload(
  app: TestApp,
  who: Who,
  file: Buffer,
  opts: { blurhash?: string; url?: string; method?: 'POST' | 'PUT' } = {},
) {
  const parts: Parameters<typeof multipart>[0] = [{ name: 'file', value: file, filename: 'x.jpg', type: 'image/jpeg' }];
  if (opts.blurhash) parts.unshift({ name: 'blurhash', value: opts.blurhash });
  const { payload, contentType } = multipart(parts);
  return app.inject({
    method: opts.method ?? 'POST',
    url: opts.url ?? '/photos',
    headers: { ...who.headers, 'content-type': contentType },
    payload,
  });
}

let imageSeed = 1;
/** Uploads a fresh photo and returns its id. */
export async function photoId(app: TestApp, who: Who): Promise<string> {
  const res = await upload(app, who, await makeImage(imageSeed++));
  if (res.statusCode !== 201) throw new Error(`upload failed: ${res.statusCode} ${res.body}`);
  return res.json().id;
}

export const pawilon = {
  name: 'Pawilon Nocny',
  category_id: 'club',
  price_level: 2,
  address: 'ul. Nowy Świat 22',
  location: { lat: 52.2319, lng: 21.0186 },
  description: 'Najlepszy dźwięk w mieście i zero lansu.',
  tags: ['Późno w nocy', 'Muzyka na żywo', 'Ogródek'],
};

export const podPionem = {
  name: 'Bar Pod Pionem',
  category_id: 'bar',
  location: { lat: 52.2297, lng: 21.0122 },
};

export const kreska = {
  name: 'Kawiarnia Ostra Kreska',
  category_id: 'coffee',
  // Kraków, far from the others.
  location: { lat: 50.0614, lng: 19.9366 },
};

/**
 * Adds a place with the author's rating and one fresh photo (both required). `rating` defaults to 4/4.
 * Returns the new place's id.
 */
export async function createPlace(
  app: TestApp,
  who: Who,
  payload: Record<string, unknown>,
  rating: Record<string, unknown> = { vibe: 4, offer: 4 },
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/places',
    headers: who.headers,
    payload: { rating, photo_ids: [await photoId(app, who)], ...payload },
  });
  if (res.statusCode !== 201) throw new Error(`create place failed: ${res.statusCode} ${res.body}`);
  return res.json().id;
}

/** Rates a place with a fresh photo. */
export async function rate(app: TestApp, who: Who, placeId: string, scores: Record<string, unknown>) {
  return app.inject({
    method: 'PUT',
    url: `/places/${placeId}/rating`,
    headers: who.headers,
    payload: { photo_ids: [await photoId(app, who)], ...scores },
  });
}
