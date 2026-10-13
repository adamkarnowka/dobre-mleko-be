import { describe, expect, it } from 'vitest';
import { checkIconPath } from '../src/icons.js';
import { ADMIN, login, setup } from './helpers.js';

const h = setup();

type Headers = { authorization: string };
const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, headers?: Headers, payload?: object) =>
  h.app.inject({ method, url, headers, payload });
const meta = async () => (await call('GET', '/meta')).json();
const sauna = { id: 'steam', label: 'Para', path: 'M4 20 L20 20 L12 4 Z' };

describe('icon paths', () => {
  it('accepts path commands, absolute and relative, and collapses whitespace', () => {
    expect(checkIconPath('  M2 2\n L22 2 l0 20 H2 Z ')).toBe('M2 2 L22 2 l0 20 H2 Z');
    expect(
      checkIconPath('M12 2a10 10 0 1 0 .001 0zM12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5Z'),
    ).toMatch(/^M12/);
    expect(checkIconPath('M1e1 2.5Q12 .5 20 10T22 22z')).toBeTruthy();
  });

  it('rejects markup, wrong argument counts and points off the grid', () => {
    for (const bad of ['', 'L2 2', '<path d="M0 0"/>', 'M2 2 L3', 'M2 2 Z 4', 'M2 2 L30 2', 'M2 2 X 4 4', 'url(#a)']) {
      expect(() => checkIconPath(bad), bad).toThrow();
    }
    expect(() => checkIconPath('M0 0' + ' L1 1'.repeat(2000))).toThrow(/too long/);
  });
});

describe('icon library', () => {
  it('serves every built-in category with its own pictogram path in /meta', async () => {
    const details = (await meta()).category_details as { icon: { id: string; path: string } | null }[];
    const ids = details.map((c) => c.icon?.id);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of details) expect(() => checkIconPath(c.icon!.path)).not.toThrow();
  });

  it('is for admins only', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    expect((await call('GET', '/admin/icons', ola.headers)).statusCode).toBe(403);
    expect((await call('POST', '/admin/icons', ola.headers, sauna)).statusCode).toBe(403);
  });

  it('adds an icon, gives it to a category, changes its path everywhere and guards deletion', async () => {
    const admin = await login(h.app, ADMIN);
    const added = await call('POST', '/admin/icons', admin.headers, sauna);
    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({ id: 'steam', label: 'Para', path: sauna.path, categories: 0 });

    const category = await call('PATCH', '/admin/categories/other', admin.headers, { icon: 'steam' });
    expect(category.json().icon).toEqual({ id: 'steam', path: sauna.path });

    await call('PATCH', '/admin/icons/steam', admin.headers, { path: 'M2 22 L22 22 L12 2 Z' });
    const other = (await meta()).category_details.find((c: { id: string }) => c.id === 'other');
    expect(other.icon).toEqual({ id: 'steam', path: 'M2 22 L22 22 L12 2 Z' });

    const inUse = await call('DELETE', '/admin/icons/steam', admin.headers);
    expect([inUse.statusCode, inUse.json().error, inUse.json().categories]).toEqual([409, 'icon_in_use', 1]);
    await call('PATCH', '/admin/categories/other', admin.headers, { icon: null });
    expect((await call('DELETE', '/admin/icons/steam', admin.headers)).statusCode).toBe(204);
    expect((await meta()).category_details.find((c: { id: string }) => c.id === 'other').icon).toBeNull();
  });

  it('validates icons and their use', async () => {
    const admin = await login(h.app, ADMIN);
    const post = (body: object) => call('POST', '/admin/icons', admin.headers, { ...sauna, ...body });
    expect((await post({ path: '<svg/>' })).statusCode).toBe(422);
    expect((await post({ id: 'Bad!' })).statusCode).toBe(422);
    const sameId = await post({ id: 'bed', label: 'Nocleg' });
    expect([sameId.statusCode, sameId.json().error]).toEqual([409, 'icon_exists']);
    const sameName = await post({ label: 'łóżko' });
    expect([sameName.statusCode, sameName.json().error]).toEqual([409, 'icon_exists']);
    const unknown = await call('PATCH', '/admin/categories/other', admin.headers, { icon: 'nope' });
    expect(unknown.statusCode).toBe(422);
    const list = (await call('GET', '/admin/icons', admin.headers)).json().items;
    expect(list).toHaveLength(15);
    expect(list.find((i: { id: string }) => i.id === 'plate').categories).toBe(1);
  });
});
