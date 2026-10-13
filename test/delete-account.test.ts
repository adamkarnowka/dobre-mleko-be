import { describe, expect, it } from 'vitest';
import { ADMIN, createPlace, login, makeImage, pawilon, setup, upload } from './helpers.js';

const h = setup();

const deleteMe = (headers: { authorization: string }) => h.app.inject({ method: 'DELETE', url: '/me', headers });

describe('DELETE /me', () => {
  it('removes personal data, keeps places, ratings and comments as "Były członek"', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const kuba = await login(h.app, 'kuba@gmail.com');
    await h.app.inject({
      method: 'PATCH',
      url: '/me',
      headers: ola.headers,
      payload: { display_name: 'Ola', badge: 'Kawa', favorite_categories: ['bar'] },
    });
    expect((await upload(h.app, ola, await makeImage(3), { url: '/me/avatar', method: 'PUT' })).statusCode).toBe(200);
    const place = await createPlace(h.app, ola, pawilon);
    await h.app.inject({
      method: 'POST',
      url: `/places/${place}/comments`,
      headers: ola.headers,
      payload: { body: 'Hej' },
    });
    await h.app.inject({ method: 'PUT', url: `/places/${place}/saved`, headers: ola.headers });
    await h.app.inject({
      method: 'PUT',
      url: '/me/devices',
      headers: ola.headers,
      payload: { token: 'a'.repeat(64), platform: 'ios', environment: 'sandbox', app_id: 'pl.dobremleko.app' },
    });

    expect((await deleteMe(ola.headers)).statusCode).toBe(204);

    const [user] = await h.sql`select * from users where id = ${ola.id}`;
    expect(user).toMatchObject({
      status: 'deleted',
      name: 'Były członek',
      email: `deleted-${ola.id}@deleted.invalid`,
      google_sub: null,
      apple_sub: null,
      avatar_hash: null,
      badge: null,
      favorite_categories: [],
    });
    for (const table of ['saved_places', 'devices']) {
      const [{ n }] = await h.sql<[{ n: number }]>`
        select count(*)::int as n from ${h.sql(table)} where user_id = ${ola.id}
      `;
      expect(n).toBe(0);
    }
    expect(await h.sql`select 1 from allowed_emails where email = 'ola@gmail.com'`).toHaveLength(0);

    // Content stays, by "Były członek".
    const seen = (await h.app.inject({ method: 'GET', url: `/places/${place}`, headers: kuba.headers })).json();
    expect(seen.author).toMatchObject({ id: ola.id, display_name: 'Były członek', status: 'deleted' });
    const comments = (
      await h.app.inject({ method: 'GET', url: `/places/${place}/comments`, headers: kuba.headers })
    ).json();
    expect(comments.items[0]).toMatchObject({ body: 'Hej', author: { display_name: 'Były członek' } });
  });

  it('ends every session; the same e-mail is a new account once back on the list', async () => {
    const tomek = await login(h.app, 'tomek@gmail.com');
    await deleteMe(tomek.headers);
    expect((await h.app.inject({ method: 'GET', url: '/me', headers: tomek.headers })).statusCode).toBe(403);
    const again = await h.app.inject({
      method: 'POST',
      url: '/auth/google',
      payload: { id_token: 'google:tomek@gmail.com' },
    });
    expect(again.json().error).toBe('not_authorized');

    await h.sql`insert into allowed_emails (email) values ('tomek@gmail.com')`;
    const fresh = await login(h.app, 'tomek@gmail.com');
    expect(fresh.id).not.toBe(tomek.id);
  });

  it('needs a session, and keeps ADMIN_EMAILS admins on the list', async () => {
    expect((await h.app.inject({ method: 'DELETE', url: '/me' })).statusCode).toBe(401);
    const marta = await login(h.app, ADMIN);
    expect((await deleteMe(marta.headers)).statusCode).toBe(204);
    expect(await h.sql`select 1 from allowed_emails where email = ${ADMIN}`).toHaveLength(1);
  });
});
