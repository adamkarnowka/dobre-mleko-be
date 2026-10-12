import { describe, expect, it } from 'vitest';
import { ADMIN, createPlace, login, pawilon, podPionem, setup } from './helpers.js';

const h = setup();

type Headers = { authorization: string };
const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, headers?: Headers, payload?: object) =>
  h.app.inject({ method, url, headers, payload });

describe('admin access', () => {
  it('is for admins only', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const admin = await login(h.app, ADMIN);
    expect((await call('GET', '/admin/allowed')).statusCode).toBe(401);
    const res = await call('GET', '/admin/allowed', ola.headers);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('not_authorized');
    expect((await call('GET', '/admin/allowed', admin.headers)).statusCode).toBe(200);

    expect((await call('GET', '/me', ola.headers)).json().is_admin).toBe(false);
    expect((await call('GET', '/me', admin.headers)).json().is_admin).toBe(true);
  });
});

describe('whitelist', () => {
  it('lists everyone, with accounts and activity once they have signed in', async () => {
    const admin = await login(h.app, ADMIN);
    const ola = await login(h.app, 'ola@gmail.com');
    await createPlace(h.app, ola, pawilon);

    const list = (await call('GET', '/admin/allowed', admin.headers)).json();
    expect(list).toMatchObject({ admins: 1, members: 3 });
    const byEmail = Object.fromEntries(list.items.map((i: { email: string }) => [i.email, i]));
    expect(byEmail[ADMIN]).toMatchObject({ role: 'admin', from_environment: true });
    expect(byEmail['ola@gmail.com']).toMatchObject({
      role: 'member',
      from_environment: false,
      user: { display_name: 'Ola', places: 1, ratings: 1 },
    });
    expect(byEmail['kuba@gmail.com'].user).toBeNull(); // not signed in yet
  });

  it('adding someone lets them sign in', async () => {
    const admin = await login(h.app, ADMIN);
    const before = await call('POST', '/auth/google', undefined, { id_token: 'google:zosia@gmail.com' });
    expect(before.statusCode).toBe(403);

    const added = await call('POST', '/admin/allowed', admin.headers, { email: 'Zosia@Gmail.com', note: 'od Oli' });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({
      email: 'zosia@gmail.com',
      role: 'member',
      note: 'od Oli',
      added_by: { display_name: 'Marta' },
      user: null,
    });

    const dup = await call('POST', '/admin/allowed', admin.headers, { email: 'zosia@gmail.com' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe('already_allowed');

    expect((await call('POST', '/auth/google', undefined, { id_token: 'google:zosia@gmail.com' })).statusCode).toBe(
      200,
    );
  });

  it('removing someone cuts access at once; adding them back restores the same account', async () => {
    const admin = await login(h.app, ADMIN);
    const ola = await login(h.app, 'ola@gmail.com');
    const place = await createPlace(h.app, ola, pawilon);

    expect((await call('DELETE', '/admin/allowed/ola@gmail.com', admin.headers)).statusCode).toBe(204);
    expect((await call('GET', '/me', ola.headers)).statusCode).toBe(403);
    // Their place stays.
    expect((await call('GET', `/places/${place}`, admin.headers)).json().author.display_name).toBe('Ola');

    await call('POST', '/admin/allowed', admin.headers, { email: 'ola@gmail.com' });
    const again = await login(h.app, 'ola@gmail.com');
    expect(again.id).toBe(ola.id);
    expect((await call('GET', '/me', ola.headers)).statusCode).toBe(200); // the old token works again too
  });

  it('role changes apply to existing sessions', async () => {
    const admin = await login(h.app, ADMIN);
    const kuba = await login(h.app, 'kuba@gmail.com');
    expect((await call('GET', '/admin/settings', kuba.headers)).statusCode).toBe(403);

    const res = await call('PATCH', '/admin/allowed/kuba@gmail.com', admin.headers, {
      role: 'admin',
      note: 'współadmin',
    });
    expect(res.json()).toMatchObject({ role: 'admin', note: 'współadmin' });
    expect((await call('GET', '/admin/settings', kuba.headers)).statusCode).toBe(200);

    // Note only: the role stays.
    expect((await call('PATCH', '/admin/allowed/kuba@gmail.com', admin.headers, { note: null })).json()).toMatchObject({
      role: 'admin',
      note: null,
    });
  });

  it('refuses changes that could lock admins out', async () => {
    const admin = await login(h.app, ADMIN);
    await call('PATCH', '/admin/allowed/kuba@gmail.com', admin.headers, { role: 'admin' });
    const kuba = await login(h.app, 'kuba@gmail.com');

    const envDemote = await call('PATCH', `/admin/allowed/${ADMIN}`, kuba.headers, { role: 'member' });
    expect(envDemote.statusCode).toBe(409);
    expect(envDemote.json().error).toBe('managed_by_environment');
    expect((await call('DELETE', `/admin/allowed/${ADMIN}`, kuba.headers)).statusCode).toBe(409);

    const selfDemote = await call('PATCH', '/admin/allowed/kuba@gmail.com', kuba.headers, { role: 'member' });
    expect(selfDemote.json().error).toBe('cannot_change_self');
    expect((await call('DELETE', '/admin/allowed/kuba@gmail.com', kuba.headers)).statusCode).toBe(409);

    // Another admin can do it.
    expect((await call('PATCH', '/admin/allowed/kuba@gmail.com', admin.headers, { role: 'member' })).statusCode).toBe(
      200,
    );
  });

  it('validates input and reports unknown entries', async () => {
    const admin = await login(h.app, ADMIN);
    expect((await call('POST', '/admin/allowed', admin.headers, { email: 'nope' })).statusCode).toBe(422);
    expect((await call('POST', '/admin/allowed', admin.headers, { email: 'a@b.pl', role: 'owner' })).statusCode).toBe(
      422,
    );
    expect((await call('DELETE', '/admin/allowed/ghost@gmail.com', admin.headers)).statusCode).toBe(404);
  });
});

describe('settings', () => {
  it('lists settings with defaults and ranges', async () => {
    const admin = await login(h.app, ADMIN);
    const { items } = (await call('GET', '/admin/settings', admin.headers)).json();
    expect(items.map((s: { key: string }) => s.key)).toEqual([
      'starsPerMonth',
      'sessionTtlDays',
      'maxPhotoBytes',
      'maxPhotosPerRating',
      'starRankBonus',
    ]);
    expect(items[0]).toMatchObject({
      value: 3,
      default: 3,
      min: 0,
      max: 31,
      integer: true,
      updated_at: null,
      updated_by: null,
    });
  });

  it('changes take effect immediately and can be reset', async () => {
    const admin = await login(h.app, ADMIN);
    const ola = await login(h.app, 'ola@gmail.com');
    const a = await createPlace(h.app, ola, pawilon);
    const b = await createPlace(h.app, ola, podPionem);

    const set = await call('PUT', '/admin/settings/starsPerMonth', admin.headers, { value: 1 });
    expect(set.json()).toMatchObject({ key: 'starsPerMonth', value: 1, updated_by: { display_name: 'Marta' } });
    expect((await call('GET', '/meta')).json().gold_stars_per_month).toBe(1);
    expect((await call('GET', '/me', ola.headers)).json().gold_stars).toMatchObject({ per_month: 1, left: 1 });

    expect((await call('POST', `/places/${a}/gold-star`, ola.headers)).statusCode).toBe(200);
    expect((await call('POST', `/places/${b}/gold-star`, ola.headers)).json().error).toBe('no_gold_stars_left');

    const reset = await call('DELETE', '/admin/settings/starsPerMonth', admin.headers);
    expect(reset.json()).toMatchObject({ value: 3, updated_at: null });
    expect((await call('POST', `/places/${b}/gold-star`, ola.headers)).statusCode).toBe(200);
  });

  it('session length applies to new sign-ins', async () => {
    const admin = await login(h.app, ADMIN);
    await call('PUT', '/admin/settings/sessionTtlDays', admin.headers, { value: 2 });
    const res = await call('POST', '/auth/google', undefined, { id_token: 'google:ola@gmail.com' });
    const days = (new Date(res.json().expires_at).getTime() - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(1.9);
    expect(days).toBeLessThan(2.1);
  });

  it('rejects out-of-range values and unknown settings', async () => {
    const admin = await login(h.app, ADMIN);
    const bad = await call('PUT', '/admin/settings/starsPerMonth', admin.headers, { value: 100 });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error).toBe('invalid_input');
    expect((await call('PUT', '/admin/settings/starsPerMonth', admin.headers, { value: 'three' })).statusCode).toBe(
      422,
    );
    expect((await call('PUT', '/admin/settings/jwtSecret', admin.headers, { value: 1 })).statusCode).toBe(422);
  });
});

describe('dashboard', () => {
  it('is served with a strict content security policy', async () => {
    const res = await call('GET', '/admin/');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['content-security-policy']).toContain(
      "script-src 'self' https://accounts.google.com/gsi/client",
    );
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect((await call('GET', '/admin/app.js')).statusCode).toBe(200);
    const redirect = await call('GET', '/admin');
    expect(redirect.statusCode).toBe(302);
    expect(redirect.headers.location).toBe('/admin/');
  });

  it('exposes what the sign-in page needs', async () => {
    const meta = (await call('GET', '/meta')).json();
    expect(meta).toMatchObject({ google_web_client_id: null, dev_login: false, max_photos_per_rating: 6 });
  });
});
