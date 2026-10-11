import { describe, expect, it } from 'vitest';
import { login, setup } from './helpers.js';

const h = setup();

describe('auth', () => {
  it('signs in a whitelisted Google account and creates the user', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/auth/google',
      payload: { idToken: 'google:ola@gmail.com' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token).toBeTypeOf('string');
    expect(body.user).toMatchObject({ email: 'ola@gmail.com', name: 'Ola', stars: { perMonth: 3, left: 3 } });

    const me = await h.app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${body.token}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json().id).toBe(body.user.id);
  });

  it('signing in again reuses the account', async () => {
    const a = await login(h.app, 'ola@gmail.com');
    const b = await login(h.app, 'ola@gmail.com');
    expect(a.id).toBe(b.id);
  });

  it('rejects accounts that are not on the whitelist', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/auth/google',
      payload: { idToken: 'google:obcy@gmail.com' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('not_whitelisted');
    const [{ n }] = await h.sql<[{ n: number }]>`select count(*)::int as n from users`;
    expect(n).toBe(0);
  });

  it('rejects unverified Google emails', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/auth/google',
      payload: { idToken: 'google:ola@gmail.com:unverified' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('email_not_verified');
  });

  it('rejects invalid Google tokens', async () => {
    const res = await h.app.inject({ method: 'POST', url: '/auth/google', payload: { idToken: 'garbage' } });
    expect(res.statusCode).toBe(401);
  });

  it('requires a session for the API', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/me' })).statusCode).toBe(401);
    expect(
      (await h.app.inject({ method: 'GET', url: '/me', headers: { authorization: 'Bearer nope' } })).statusCode,
    ).toBe(401);
  });

  it('cuts off a signed-in user once removed from the whitelist', async () => {
    const tomek = await login(h.app, 'tomek@gmail.com');
    await h.sql`delete from allowed_emails where email = 'tomek@gmail.com'`;
    const res = await h.app.inject({ method: 'GET', url: '/me', headers: tomek.headers });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('not_whitelisted');
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
