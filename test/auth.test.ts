import { describe, expect, it } from 'vitest';
import { login, makeImage, setup, upload } from './helpers.js';

const h = setup();

const signIn = (idToken: string) =>
  h.app.inject({ method: 'POST', url: '/auth/google', payload: { id_token: idToken } });

describe('auth', () => {
  it('signs in a whitelisted Google account; the profile starts unfinished', async () => {
    const res = await signIn('google:ola@gmail.com');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token).toBeTypeOf('string');
    expect(body.expires_at).toMatch(/Z$/);
    expect(body.has_profile).toBe(false);
    expect(body.user).toMatchObject({
      email: 'ola@gmail.com',
      display_name: 'Ola',
      badge: null,
      role: 'member',
      status: 'active',
      favorite_categories: [],
      is_admin: false,
      has_profile: false,
      gold_stars: { per_month: 3, left: 3, month: '2026-10-01' },
    });

    const me = await h.app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${body.token}` } });
    expect(me.json().id).toBe(body.user.id);
  });

  it('signing in again reuses the account', async () => {
    const a = await login(h.app, 'ola@gmail.com');
    const b = await login(h.app, 'ola@gmail.com');
    expect(a.id).toBe(b.id);
  });

  it('rejects accounts that are not on the whitelist', async () => {
    const res = await signIn('google:obcy@gmail.com');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'not_authorized' });
    const [{ n }] = await h.sql<[{ n: number }]>`select count(*)::int as n from users`;
    expect(n).toBe(0);
  });

  it('rejects unverified Google emails and invalid tokens', async () => {
    expect((await signIn('google:ola@gmail.com:unverified')).json().error).toBe('email_not_verified');
    expect((await signIn('garbage')).statusCode).toBe(401);
  });

  it('requires a session: 401 not_authenticated', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('not_authenticated');
    expect(
      (await h.app.inject({ method: 'GET', url: '/me', headers: { authorization: 'Bearer nope' } })).statusCode,
    ).toBe(401);
  });

  it('cuts off a signed-in user once removed from the whitelist or suspended', async () => {
    const tomek = await login(h.app, 'tomek@gmail.com');
    await h.sql`delete from allowed_emails where email = 'tomek@gmail.com'`;
    expect((await h.app.inject({ method: 'GET', url: '/me', headers: tomek.headers })).json().error).toBe(
      'not_authorized',
    );

    const ola = await login(h.app, 'ola@gmail.com');
    await h.sql`update users set status = 'suspended' where id = ${ola.id}`;
    expect((await h.app.inject({ method: 'GET', url: '/me', headers: ola.headers })).statusCode).toBe(403);
    expect((await signIn('google:ola@gmail.com')).statusCode).toBe(403);
  });

  it('dev login is off unless enabled, and never in production', async () => {
    const payload = { email: 'ola@gmail.com' };
    expect((await h.app.inject({ method: 'POST', url: '/auth/dev', payload })).statusCode).toBe(404);

    const dev = await h.build({ DEV_LOGIN: 'true' });
    expect((await dev.inject({ method: 'POST', url: '/auth/dev', payload })).statusCode).toBe(200);
    expect((await dev.inject({ method: 'POST', url: '/auth/dev', payload: { email: 'x@gmail.com' } })).statusCode).toBe(
      403,
    );
    await dev.close();

    const prod = await h.build({ DEV_LOGIN: 'true', NODE_ENV: 'production' });
    expect((await prod.inject({ method: 'POST', url: '/auth/dev', payload })).statusCode).toBe(404);
    await prod.close();
  });
});

describe('profile', () => {
  it('onboarding sets name, badge and favourite categories', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const res = await h.app.inject({
      method: 'POST',
      url: '/me/profile',
      headers: ola.headers,
      payload: { display_name: '  Ola K. ', badge: ' Mleczarka ', favorite_categories: ['coffee', 'kids'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      display_name: 'Ola K.',
      badge: 'Mleczarka',
      favorite_categories: ['coffee', 'kids'],
      has_profile: true,
    });
    expect(
      (
        await h.app.inject({ method: 'POST', url: '/auth/google', payload: { id_token: 'google:ola@gmail.com' } })
      ).json().has_profile,
    ).toBe(true);
  });

  it('validates badge and categories; an empty badge clears it', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const patch = (payload: object) => h.app.inject({ method: 'PATCH', url: '/me', headers: ola.headers, payload });

    expect((await patch({ badge: 'x'.repeat(17) })).statusCode).toBe(422);
    expect((await patch({ badge: 'x'.repeat(17) })).json().error).toBe('invalid_input');
    expect((await patch({ favorite_categories: ['bar', 'club', 'kids', 'food'] })).statusCode).toBe(422);
    expect((await patch({ favorite_categories: ['bar', 'bar'] })).statusCode).toBe(422);
    expect((await patch({ favorite_categories: ['disco'] })).statusCode).toBe(422);

    expect((await patch({ badge: 'SzachMat' })).json().badge).toBe('SzachMat');
    expect((await patch({ badge: '   ' })).json().badge).toBeNull();
    // Role and status are not writable.
    expect((await patch({ role: 'admin', status: 'deleted' })).json()).toMatchObject({
      role: 'member',
      status: 'active',
    });
  });

  it('own avatar replaces the Google picture, as a signed thumbnail', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const res = await upload(h.app, ola, await makeImage(7, 800, 600), { url: '/me/avatar', method: 'PUT' });
    expect(res.statusCode).toBe(200);
    const url: string = res.json().avatar_url;
    expect(url).toMatch(/^\/files\/[0-9a-f]{64}\/thumb\?exp=\d+&sig=/);
    const img = await h.app.inject({ method: 'GET', url });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/jpeg');

    const removed = await h.app.inject({ method: 'DELETE', url: '/me/avatar', headers: ola.headers });
    expect(removed.json().avatar_url).toBeNull();
    expect((await h.app.inject({ method: 'GET', url })).statusCode).toBe(404); // file gone
  });
});
