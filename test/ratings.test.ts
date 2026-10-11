import { describe, expect, it } from 'vitest';
import { createPlace, kreska, login, pawilon, podPionem, setup } from './helpers.js';

const h = setup();

describe('ratings', () => {
  it('averages only the criteria that apply', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const id = await createPlace(h.app, ola.headers, pawilon);

    // Value marked "nie dotyczy": (5 + 4 + 4) / 3
    const res = await h.app.inject({
      method: 'PUT',
      url: `/places/${id}/rating`,
      headers: ola.headers,
      payload: { vibe: 5, offer: 4, service: 4, value: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().myRating).toMatchObject({
      scores: { vibe: 5, offer: 4, service: 4, value: null },
      overall: 4.33,
    });
    expect(res.json().rating).toEqual({ average: 4.33, count: 1 });
  });

  it('requires the mandatory criteria and 1–5 scores', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const id = await createPlace(h.app, ola.headers, pawilon);
    const put = (payload: object) =>
      h.app.inject({ method: 'PUT', url: `/places/${id}/rating`, headers: ola.headers, payload });
    expect((await put({ vibe: 5 })).statusCode).toBe(400);
    expect((await put({ vibe: 6, offer: 4 })).statusCode).toBe(400);
    expect((await put({ vibe: 0, offer: 4 })).statusCode).toBe(400);
  });

  it('one rating per person, updated in place, with per-criterion breakdown', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const tomek = await login(h.app, 'tomek@gmail.com');
    const id = await createPlace(h.app, ola.headers, pawilon);
    const rate = (who: typeof ola, payload: object) =>
      h.app.inject({ method: 'PUT', url: `/places/${id}/rating`, headers: who.headers, payload });

    await rate(ola, { vibe: 3, offer: 3 });
    await rate(ola, { vibe: 5, offer: 4, service: 3 }); // replaces the first one
    await rate(tomek, { vibe: 5, offer: 5, service: 5, value: 4 });

    const place = (await h.app.inject({ method: 'GET', url: `/places/${id}`, headers: ola.headers })).json();
    expect(place.rating.count).toBe(2);
    expect(place.criteria).toEqual([
      { key: 'vibe', average: 5, count: 2 },
      { key: 'offer', average: 4.5, count: 2 },
      { key: 'service', average: 4, count: 2 },
      { key: 'value', average: 4, count: 1 },
    ]);
    expect(place.strongestCriterion).toBe('vibe');

    const mine = (await h.app.inject({ method: 'GET', url: '/me/ratings', headers: ola.headers })).json();
    expect(mine.total).toBe(1);

    const del = await h.app.inject({ method: 'DELETE', url: `/places/${id}/rating`, headers: ola.headers });
    expect(del.json()).toMatchObject({ myRating: null, rating: { count: 1 } });
  });

  it('ranks by rating, pulling places with few ratings towards the average', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const kuba = await login(h.app, 'kuba@gmail.com');
    const tomek = await login(h.app, 'tomek@gmail.com');
    const a = await createPlace(h.app, ola.headers, pawilon);
    const b = await createPlace(h.app, ola.headers, podPionem);
    const c = await createPlace(h.app, ola.headers, kreska);
    const rate = (who: typeof ola, id: string, v: number) =>
      h.app.inject({
        method: 'PUT',
        url: `/places/${id}/rating`,
        headers: who.headers,
        payload: { vibe: v, offer: v },
      });

    // a: three 5s; b: a single 5; c: three 2s. One lone 5 must not beat three of them.
    for (const who of [ola, kuba, tomek]) {
      await rate(who, a, 5);
      await rate(who, c, 2);
    }
    await rate(ola, b, 5);

    const best = (await h.app.inject({ method: 'GET', url: '/places?sort=best', headers: ola.headers })).json();
    expect(best.items.map((p: { id: string }) => p.id)).toEqual([a, b, c]);
  });
});

describe('golden stars', () => {
  it('gives up to three a month, once per place', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(await createPlace(h.app, ola.headers, { ...pawilon, name: `Miejsce ${i}` }));
    const star = (id: string) => h.app.inject({ method: 'POST', url: `/places/${id}/star`, headers: ola.headers });

    expect((await star(ids[0]!)).json()).toEqual({ starred: true, left: 2 });
    expect((await star(ids[0]!)).json()).toEqual({ starred: true, left: 2 }); // already starred: no-op
    expect((await star(ids[1]!)).json()).toEqual({ starred: true, left: 1 });
    expect((await star(ids[2]!)).json()).toEqual({ starred: true, left: 0 });

    const fourth = await star(ids[3]!);
    expect(fourth.statusCode).toBe(409);
    expect(fourth.json().error.code).toBe('no_stars_left');

    // Taking one back returns it.
    const undo = await h.app.inject({ method: 'DELETE', url: `/places/${ids[2]}/star`, headers: ola.headers });
    expect(undo.json()).toEqual({ starred: false, left: 1 });
    expect((await star(ids[3]!)).statusCode).toBe(200);
  });

  it('does not change the rating and renews next month', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const id = await createPlace(h.app, ola.headers, pawilon);
    await h.app.inject({
      method: 'PUT',
      url: `/places/${id}/rating`,
      headers: ola.headers,
      payload: { vibe: 4, offer: 4 },
    });
    await h.app.inject({ method: 'POST', url: `/places/${id}/star`, headers: ola.headers });

    let place = (await h.app.inject({ method: 'GET', url: `/places/${id}`, headers: ola.headers })).json();
    expect(place).toMatchObject({
      rating: { average: 4, count: 1 },
      stars: { total: 1, thisMonth: 1 },
      myStar: { givenThisMonth: true, left: 2 },
    });

    h.clock.now = new Date('2026-11-02T10:00:00Z');
    place = (await h.app.inject({ method: 'GET', url: `/places/${id}`, headers: ola.headers })).json();
    expect(place).toMatchObject({ stars: { total: 1, thisMonth: 0 }, myStar: { givenThisMonth: false, left: 3 } });

    // A new star for the same place in the new month.
    expect((await h.app.inject({ method: 'POST', url: `/places/${id}/star`, headers: ola.headers })).json().left).toBe(
      2,
    );
  });

  it('cannot be overrun by concurrent requests', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(await createPlace(h.app, ola.headers, { ...pawilon, name: `Miejsce ${i}` }));
    await Promise.all(
      ids.map((id) => h.app.inject({ method: 'POST', url: `/places/${id}/star`, headers: ola.headers })),
    );
    const [{ n }] = await h.sql<[{ n: number }]>`select count(*)::int as n from stars`;
    expect(n).toBe(3);
  });
});
