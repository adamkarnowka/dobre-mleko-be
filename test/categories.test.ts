import { describe, expect, it } from 'vitest';
import { ADMIN, createPlace, login, pawilon, setup } from './helpers.js';

const h = setup();

type Headers = { authorization: string };
const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, headers?: Headers, payload?: object) =>
  h.app.inject({ method, url, headers, payload });
const meta = async () => (await call('GET', '/meta')).json();
const sauna = { id: 'sauna', label: 'Sauna', color: '#1e8a8a', shape: 'circle' };

describe('categories in /meta', () => {
  it('describes every category in display order', async () => {
    const m = await meta();
    expect(m.categories).toEqual([
      'food',
      'coffee',
      'bar',
      'club',
      'kids',
      'culture',
      'nature',
      'sport',
      'shopping',
      'hotel',
      'brewery',
      'museum',
      'pool',
      'curiosity',
      'other',
    ]);
    expect(m.category_details).toHaveLength(15);
    expect(m.category_details[0]).toEqual({
      id: 'food',
      label: 'Jedzenie',
      color: '#D7301F',
      shape: 'circle',
      icon: { id: 'plate', path: expect.stringMatching(/^M/) },
      position: 1,
      active: true,
    });
    expect(m.category_details.find((c: { id: string }) => c.id === 'hotel')).toMatchObject({
      shape: 'house',
      icon: { id: 'bed' },
    });
    expect(m.category_details.find((c: { id: string }) => c.id === 'curiosity')).toMatchObject({
      label: 'Osobliwość',
      icon: { id: 'eye' },
    });
  });
});

describe('managing categories', () => {
  it('is for admins only', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    expect((await call('GET', '/admin/categories', ola.headers)).statusCode).toBe(403);
    expect((await call('POST', '/admin/categories', ola.headers, sauna)).statusCode).toBe(403);
  });

  it('adds a category that everyone can use right away', async () => {
    const admin = await login(h.app, ADMIN);
    const kuba = await login(h.app, 'kuba@gmail.com');
    const res = await call('POST', '/admin/categories', admin.headers, sauna);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      ...sauna,
      color: '#1E8A8A',
      icon: null,
      position: 16,
      active: true,
      places: 0,
      updated_by: { display_name: expect.any(String) },
    });
    expect((await meta()).categories.at(-1)).toBe('sauna');

    await createPlace(h.app, kuba, { name: 'Sauna Parowa', category_id: 'sauna', location: { lat: 50.1, lng: 18.5 } });
    const list = (await call('GET', '/admin/categories', admin.headers)).json().items;
    expect(list.find((c: { id: string }) => c.id === 'sauna').places).toBe(1);
    const patch = await call('PATCH', '/me', kuba.headers, { favorite_categories: ['sauna', 'coffee'] });
    expect(patch.json().favorite_categories).toEqual(['sauna', 'coffee']);
  });

  it('validates ids, names, colours and shapes', async () => {
    const admin = await login(h.app, ADMIN);
    const post = (body: object) => call('POST', '/admin/categories', admin.headers, { ...sauna, ...body });
    expect((await post({ id: 'Sauna!' })).statusCode).toBe(422);
    expect((await post({ color: 'teal' })).statusCode).toBe(422);
    expect((await post({ shape: 'star' })).statusCode).toBe(422);
    expect((await post({ label: '' })).statusCode).toBe(422);
    const sameId = await post({ id: 'hotel', label: 'Nocleg' });
    expect([sameId.statusCode, sameId.json().error]).toEqual([409, 'category_exists']);
    const sameName = await post({ label: 'kawa' });
    expect([sameName.statusCode, sameName.json().error]).toEqual([409, 'category_exists']);
    const unknown = await call('POST', '/places', admin.headers, { ...pawilon, category_id: 'nope' });
    expect(unknown.statusCode).toBe(422);
  });

  it('changes a category and retires it without touching its places', async () => {
    const admin = await login(h.app, ADMIN);
    const ola = await login(h.app, 'ola@gmail.com');
    const club = await createPlace(h.app, ola, pawilon);

    const changed = await call('PATCH', '/admin/categories/club', admin.headers, {
      label: 'Klub muzyczny',
      color: '#6b4c9a',
      shape: 'ring',
    });
    expect(changed.json()).toMatchObject({ label: 'Klub muzyczny', color: '#6B4C9A', shape: 'ring', places: 1 });

    expect((await call('PATCH', '/admin/categories/club', admin.headers, { active: false })).json().active).toBe(false);
    const m = await meta();
    expect(m.categories).not.toContain('club');
    expect(m.category_details.find((c: { id: string }) => c.id === 'club').active).toBe(false);

    // The place stays a club and can still be edited; nothing new goes into a retired category.
    expect((await call('GET', `/places/${club}`, ola.headers)).json().category_id).toBe('club');
    const edit = await call('PATCH', `/places/${club}`, ola.headers, { category_id: 'club', name: 'Pawilon' });
    expect(edit.statusCode).toBe(200);
    await expect(createPlace(h.app, ola, { ...pawilon, name: 'Nowy klub' })).rejects.toThrow(
      'Category club is retired',
    );
    expect((await createPlace(h.app, ola, { ...pawilon, name: 'Bar', category_id: 'bar' })).length).toBeGreaterThan(0);
    const moved = await call('PATCH', `/places/${club}`, ola.headers, { category_id: 'kids' });
    expect(moved.statusCode).toBe(200);
    const back = await call('PATCH', `/places/${club}`, ola.headers, { category_id: 'club' });
    expect(back.statusCode).toBe(422);
  });

  it('reorders categories', async () => {
    const admin = await login(h.app, ADMIN);
    const ids = (await meta()).categories as string[];
    const order = ['other', ...ids.filter((id) => id !== 'other')];
    const res = await call('PUT', '/admin/categories/order', admin.headers, { ids: order });
    expect(res.json().items.map((c: { id: string }) => c.id)).toEqual(order);
    expect((await meta()).categories).toEqual(order);
    expect((await call('PUT', '/admin/categories/order', admin.headers, { ids: order.slice(1) })).statusCode).toBe(422);
  });

  it('deletes only unused categories, and drops them from favourites', async () => {
    const admin = await login(h.app, ADMIN);
    const ola = await login(h.app, 'ola@gmail.com');
    await createPlace(h.app, ola, pawilon);
    await call('PATCH', '/me', ola.headers, { favorite_categories: ['kids', 'bar'] });

    const inUse = await call('DELETE', '/admin/categories/club', admin.headers);
    expect(inUse.json()).toMatchObject({ error: 'category_in_use', places: 1 });
    expect((await call('DELETE', '/admin/categories/kids', admin.headers)).statusCode).toBe(204);
    expect((await meta()).category_details.map((c: { id: string }) => c.id)).not.toContain('kids');
    expect((await call('GET', '/me', ola.headers)).json().favorite_categories).toEqual(['bar']);
    expect((await call('DELETE', '/admin/categories/kids', admin.headers)).statusCode).toBe(404);
  });

  it('keeps at least one category open for new places', async () => {
    const admin = await login(h.app, ADMIN);
    const ids = ((await meta()).categories as string[]).filter((id) => id !== 'other');
    for (const id of ids) await call('PATCH', `/admin/categories/${id}`, admin.headers, { active: false });
    const last = await call('PATCH', '/admin/categories/other', admin.headers, { active: false });
    expect([last.statusCode, last.json().error]).toEqual([409, 'last_category']);
    expect((await call('DELETE', '/admin/categories/other', admin.headers)).json().error).toBe('last_category');
  });
});
