import { describe, expect, it } from 'vitest';
import { createPlace, login, setup } from './helpers.js';

const h = setup();

const at = { lat: 50.0955, lng: 18.5419 };

describe('tag suggestions', () => {
  it('suggests used tags, most used first, matching without accents', async () => {
    const kuba = await login(h.app, 'kuba@gmail.com');
    await createPlace(h.app, kuba, { name: 'A', category_id: 'bar', location: at, tags: ['Ogródek', 'Jazz'] });
    await createPlace(h.app, kuba, { name: 'B', category_id: 'food', location: at, tags: ['ogródek', 'Wege'] });
    await createPlace(h.app, kuba, { name: 'C', category_id: 'food', location: at, tags: ['Ogródek', 'Na lunch'] });
    await createPlace(h.app, kuba, { name: 'D', category_id: 'coffee', location: at, tags: ['Późno w nocy'] });
    const get = async (query = '') =>
      (await h.app.inject({ method: 'GET', url: `/tags${query}`, headers: kuba.headers })).json().items;

    // All, most used first; "Ogródek" and "ogródek" are one tag, as most spell it.
    expect((await get()).map((t: { tag: string }) => t.tag)).toEqual([
      'Ogródek',
      'Jazz',
      'Na lunch',
      'Późno w nocy',
      'Wege',
    ]);
    expect((await get())[0]).toEqual({ tag: 'Ogródek', places: 3, in_category: 0 });

    // Typed text: anywhere in the tag, no accents needed, tags starting with it first.
    expect((await get('?q=ogrod')).map((t: { tag: string }) => t.tag)).toEqual(['Ogródek']);
    expect((await get('?q=e')).map((t: { tag: string }) => t.tag)).toEqual(['Ogródek', 'Wege']);
    // Equal counts: "Wege" starts with "w", so it comes before "Późno w nocy".
    expect((await get('?q=W')).map((t: { tag: string }) => t.tag)).toEqual(['Wege', 'Późno w nocy']);
    expect(await get('?q=%25')).toEqual([]); // wildcards are literal

    // A category's own tags first.
    const forFood = await get('?category=food&limit=2');
    expect(forFood).toEqual([
      { tag: 'Ogródek', places: 3, in_category: 2 },
      { tag: 'Na lunch', places: 1, in_category: 1 },
    ]);
  });

  it('needs a session', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/tags' })).statusCode).toBe(401);
  });
});
