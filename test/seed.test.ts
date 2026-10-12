import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PhotoStore } from '../src/photo-store.js';
import { resetData, seed, SEED_USERS } from '../src/seed.js';
import { login, PHOTO_DIR, setup } from './helpers.js';

const h = setup();

describe('development fixtures', () => {
  it('seed data follows the same rules as the API', { timeout: 30_000 }, async () => {
    const store = new PhotoStore(PHOTO_DIR);
    const counts = await seed(h.sql, store, { places: 15, now: h.clock.now });
    expect(counts).toMatchObject({ users: 10, places: 15 });

    const [check] = await h.sql<
      { unrated_photos: number; ratings_without_photo: number; max_stars: number; profiles_done: number }[]
    >`
      select
        (select count(*)::int from ratings r where not exists (
          select 1 from place_photos ph where ph.place_id = r.place_id and ph.uploaded_by = r.user_id)) as ratings_without_photo,
        (select count(*)::int from place_photos ph where not exists (
          select 1 from ratings r where r.place_id = ph.place_id and r.user_id = ph.uploaded_by)) as unrated_photos,
        (select coalesce(max(n), 0)::int from (select count(*) as n from stars group by user_id, month) s) as max_stars,
        (select count(*)::int from users where profile_completed_at is not null) as profiles_done
    `;
    expect(check).toEqual({ ratings_without_photo: 0, unrated_photos: 0, max_stars: 3, profiles_done: 10 });

    const files = await h.sql<{ hash: string }[]>`select hash from place_photos limit 5`;
    for (const f of files) {
      expect(existsSync(join(PHOTO_DIR, f.hash.slice(0, 2), f.hash))).toBe(true);
      expect(existsSync(join(PHOTO_DIR, f.hash.slice(0, 2), `${f.hash}.thumb`))).toBe(true);
    }

    // The seeded admin can use the API and the dashboard endpoints.
    const marta = await login(h.app, SEED_USERS[0].email);
    const me = (await h.app.inject({ method: 'GET', url: '/me', headers: marta.headers })).json();
    expect(me).toMatchObject({ is_admin: true, has_profile: true, badge: 'Mleczarka' });
    const list = (
      await h.app.inject({ method: 'GET', url: '/places?include_closed=true&limit=100', headers: marta.headers })
    ).json();
    expect(list.total).toBe(15);
    expect(list.items.every((p: { cover_photo: unknown }) => p.cover_photo)).toBe(true);
    expect((await h.app.inject({ method: 'GET', url: '/admin/allowed', headers: marta.headers })).statusCode).toBe(200);
  });

  it('is deterministic and can be reset', { timeout: 30_000 }, async () => {
    const store = new PhotoStore(PHOTO_DIR);
    await seed(h.sql, store, { places: 5, now: h.clock.now });
    const first = await h.sql<{ name: string }[]>`select name from places order by name`;
    const hash = (await h.sql<{ hash: string }[]>`select hash from place_photos limit 1`)[0]!.hash;

    await resetData(h.sql, store);
    const [{ n }] = await h.sql<[{ n: number }]>`select count(*)::int as n from users`;
    expect(n).toBe(0);
    expect(existsSync(join(PHOTO_DIR, hash.slice(0, 2), hash))).toBe(false);

    await seed(h.sql, store, { places: 5, now: h.clock.now });
    expect(await h.sql<{ name: string }[]>`select name from places order by name`).toEqual(first);
  });
});
