import { describe, expect, it } from 'vitest';
import { createPlace, kreska, login, pawilon, podPionem, setup } from './helpers.js';

const h = setup();
const center = 'lat=52.2297&lng=21.0122';

describe('places', () => {
  it('creates a place and returns its details', async () => {
    const kuba = await login(h.app, 'kuba@gmail.com');
    const res = await h.app.inject({
      method: 'POST',
      url: '/places',
      headers: kuba.headers,
      payload: { ...pawilon, openingHours: [{ day: 0, open: '00:00', close: '23:59' }] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      name: 'Pawilon Nocny',
      category: 'club',
      priceLevel: 2,
      tags: ['Późno w nocy', 'Muzyka na żywo', 'Ogródek'],
      addedBy: { id: kuba.id, name: 'Kuba' },
      rating: { average: null, count: 0 },
      stars: { total: 0, thisMonth: 0 },
      openNow: true, // the test clock is a Sunday
      myRating: null,
      myStar: { givenThisMonth: false, left: 3 },
      photos: [],
    });
  });

  it('validates input', async () => {
    const kuba = await login(h.app, 'kuba@gmail.com');
    const res = await h.app.inject({
      method: 'POST',
      url: '/places',
      headers: kuba.headers,
      payload: { ...pawilon, category: 'disco' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_request');
  });

  it('does not add the same Google place twice', async () => {
    const kuba = await login(h.app, 'kuba@gmail.com');
    const id = await createPlace(h.app, kuba.headers, { ...pawilon, googlePlaceId: 'ChIJ123' });
    const res = await h.app.inject({
      method: 'POST',
      url: '/places',
      headers: kuba.headers,
      payload: { ...pawilon, googlePlaceId: 'ChIJ123' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'place_exists', placeId: id });
  });

  it('lists, searches and filters by category and distance', async () => {
    const kuba = await login(h.app, 'kuba@gmail.com');
    await createPlace(h.app, kuba.headers, pawilon);
    await createPlace(h.app, kuba.headers, podPionem);
    await createPlace(h.app, kuba.headers, kreska);

    const list = async (qs: string) => {
      const res = await h.app.inject({ method: 'GET', url: `/places?${qs}`, headers: kuba.headers });
      expect(res.statusCode).toBe(200);
      return res.json() as { total: number; items: { name: string; distanceKm: number | null }[] };
    };

    expect((await list('')).total).toBe(3);
    expect((await list('q=pionem')).items.map((p) => p.name)).toEqual(['Bar Pod Pionem']);
    expect((await list('q=muzyka')).items.map((p) => p.name)).toEqual(['Pawilon Nocny']); // matches a tag
    expect((await list('category=bar,club')).total).toBe(2);

    const near = await list(`${center}&maxDistanceKm=2&sort=near`);
    expect(near.items.map((p) => p.name)).toEqual(['Bar Pod Pionem', 'Pawilon Nocny']);
    expect(near.items[0]!.distanceKm).toBe(0);
    expect(near.items[1]!.distanceKm).toBeCloseTo(0.5, 1);
  });

  it('returns the places inside a map viewport', async () => {
    const kuba = await login(h.app, 'kuba@gmail.com');
    await createPlace(h.app, kuba.headers, pawilon);
    await createPlace(h.app, kuba.headers, podPionem);
    await createPlace(h.app, kuba.headers, kreska); // Kraków

    const view = async (bbox: string) =>
      h.app.inject({ method: 'GET', url: `/places?bbox=${bbox}&limit=500`, headers: kuba.headers });

    const warsaw = (await view('20.85,52.1,21.25,52.37')).json();
    expect(warsaw.items.map((p: { name: string }) => p.name).sort()).toEqual(['Bar Pod Pionem', 'Pawilon Nocny']);
    expect((await view('14.1,49.0,24.2,54.9')).json().total).toBe(3); // all of Poland
    expect((await view('0,0,1,1')).json().total).toBe(0);

    expect((await view('21.2,52.1,20.8,52.3')).statusCode).toBe(400); // min > max
    expect((await view('1,2,3')).statusCode).toBe(400);
  });

  it('uses the spatial indexes', async () => {
    // With sequential scans off, the planner must find an index for each kind of spatial query.
    const plan = async (where: string, order = '') =>
      (
        await h.sql.begin(async (tx) => {
          await tx`set local enable_seqscan = off`;
          return tx.unsafe(`explain select id from places where ${where} ${order}`);
        })
      )
        .map((r) => r['QUERY PLAN'] as string)
        .join('\n');
    const here = 'ST_SetSRID(ST_MakePoint(21.01, 52.23), 4326)::geography';
    expect(await plan(`ST_DWithin(geom::geography, ${here}, 2000)`)).toContain('places_geog_idx');
    expect(await plan('geom && ST_MakeEnvelope(20.9, 52.1, 21.1, 52.3, 4326)')).toContain('places_geom_idx');
    expect(await plan('true', `order by geom::geography <-> ${here} limit 5`)).toContain('places_geog_idx');
  });

  it('needs coordinates to sort by distance', async () => {
    const kuba = await login(h.app, 'kuba@gmail.com');
    const res = await h.app.inject({ method: 'GET', url: '/places?sort=near', headers: kuba.headers });
    expect(res.statusCode).toBe(400);
  });

  it('only the author edits or deletes a place', async () => {
    const kuba = await login(h.app, 'kuba@gmail.com');
    const ola = await login(h.app, 'ola@gmail.com');
    const id = await createPlace(h.app, kuba.headers, pawilon);

    const forbidden = await h.app.inject({
      method: 'PATCH',
      url: `/places/${id}`,
      headers: ola.headers,
      payload: { name: 'Mój Pawilon' },
    });
    expect(forbidden.statusCode).toBe(403);

    const ok = await h.app.inject({
      method: 'PATCH',
      url: `/places/${id}`,
      headers: kuba.headers,
      payload: { priceLevel: 3, tags: ['Jazz'], location: { lat: 52.23, lng: 21.02 } },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ name: 'Pawilon Nocny', priceLevel: 3, tags: ['Jazz'], location: { lat: 52.23 } });

    expect((await h.app.inject({ method: 'DELETE', url: `/places/${id}`, headers: ola.headers })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'DELETE', url: `/places/${id}`, headers: kuba.headers })).statusCode).toBe(
      204,
    );
    expect((await h.app.inject({ method: 'GET', url: `/places/${id}`, headers: kuba.headers })).statusCode).toBe(404);
  });

  it('saves places for later', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const id = await createPlace(h.app, ola.headers, pawilon);
    await createPlace(h.app, ola.headers, podPionem);

    await h.app.inject({ method: 'PUT', url: `/places/${id}/saved`, headers: ola.headers });
    await h.app.inject({ method: 'PUT', url: `/places/${id}/saved`, headers: ola.headers }); // idempotent
    const saved = (await h.app.inject({ method: 'GET', url: '/me/saved', headers: ola.headers })).json();
    expect(saved.items.map((p: { id: string; saved: boolean }) => [p.id, p.saved])).toEqual([[id, true]]);

    await h.app.inject({ method: 'DELETE', url: `/places/${id}/saved`, headers: ola.headers });
    expect((await h.app.inject({ method: 'GET', url: '/me/saved', headers: ola.headers })).json().total).toBe(0);
  });
});
