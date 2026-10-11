import { afterAll, beforeAll, beforeEach } from 'vitest';
import { buildApp } from '../src/app.js';
import type { GoogleIdentity } from '../src/auth.js';
import { loadConfig, type Config } from '../src/config.js';
import { createDb, migrate, type Sql } from '../src/db.js';
import { HttpError } from '../src/errors.js';

export const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://mleko:mleko@localhost:5432/mleko_test';

export const ALLOWED = ['ola@gmail.com', 'kuba@gmail.com', 'tomek@gmail.com'];

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL,
    ALLOWED_EMAILS: ALLOWED.join(','),
    GOOGLE_CLIENT_IDS: 'test-client',
    JWT_SECRET: 'test-secret-test-secret-test-secret-123',
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

export interface Harness {
  sql: Sql;
  app: TestApp;
  clock: { now: Date };
  build: (overrides?: Record<string, string>) => Promise<TestApp>;
}

/** Fresh schema per test file, tables truncated before each test. */
export function setup(): Harness {
  const h = { clock: { now: new Date('2026-10-11T12:00:00Z') } } as Harness;

  beforeAll(async () => {
    h.sql = createDb(DATABASE_URL);
    await h.sql.unsafe('drop schema public cascade; create schema public;');
    await migrate(h.sql);
    h.build = (overrides = {}) =>
      buildApp({ config: testConfig(overrides), sql: h.sql, verifyGoogle: fakeGoogle, now: () => h.clock.now });
    h.app = await h.build();
  });

  beforeEach(async () => {
    h.clock.now = new Date('2026-10-11T12:00:00Z');
    await h.sql`truncate users, places, place_photos, ratings, stars, comments, saved_places cascade`;
  });

  afterAll(async () => {
    await h.app?.close();
    await h.sql?.end();
  });

  return h;
}

export async function login(app: TestApp, email: string): Promise<{ id: string; headers: { authorization: string } }> {
  const res = await app.inject({ method: 'POST', url: '/auth/google', payload: { idToken: `google:${email}` } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const body = res.json();
  return { id: body.user.id, headers: { authorization: `Bearer ${body.token}` } };
}

export const pawilon = {
  name: 'Pawilon Nocny',
  category: 'club',
  priceLevel: 2,
  address: 'ul. Nowy Świat 22',
  location: { lat: 52.2319, lng: 21.0186 },
  description: 'Najlepszy dźwięk w mieście i zero lansu.',
  tags: ['Późno w nocy', 'Muzyka na żywo', 'Ogródek'],
};

export const podPionem = {
  name: 'Bar Pod Pionem',
  category: 'bar',
  location: { lat: 52.2297, lng: 21.0122 },
};

export const kreska = {
  name: 'Kawiarnia Ostra Kreska',
  category: 'coffee',
  // Kraków, far from the others.
  location: { lat: 50.0614, lng: 19.9366 },
};

export async function createPlace(app: TestApp, headers: Record<string, string>, payload: object): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/places', headers, payload });
  if (res.statusCode !== 201) throw new Error(`create place failed: ${res.statusCode} ${res.body}`);
  return res.json().id;
}
