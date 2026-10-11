import { describe, expect, it } from 'vitest';
import { createPlace, kreska, login, pawilon, podPionem, setup, type TestApp } from './helpers.js';

const h = setup();

// Smallest valid PNG (1×1).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function upload(app: TestApp, placeId: string, headers: Record<string, string>, type: string, data: Buffer) {
  const boundary = '----mleko';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="x"\r\nContent-Type: ${type}\r\n\r\n`,
    ),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({
    method: 'POST',
    url: `/places/${placeId}/photos`,
    headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
}

describe('comments', () => {
  it('shows comments newest first with the author’s rating', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const tomek = await login(h.app, 'tomek@gmail.com');
    const id = await createPlace(h.app, ola.headers, pawilon);
    await h.app.inject({
      method: 'PUT',
      url: `/places/${id}/rating`,
      headers: tomek.headers,
      payload: { vibe: 5, offer: 5, service: 5, value: 4 },
    });

    const first = await h.app.inject({
      method: 'POST',
      url: `/places/${id}/comments`,
      headers: ola.headers,
      payload: { body: 'Byłam w czwartek — kwartet był świetny.' },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ author: { name: 'Ola' }, authorRating: null });

    h.clock.now = new Date('2026-10-12T12:00:00Z');
    await h.app.inject({
      method: 'POST',
      url: `/places/${id}/comments`,
      headers: tomek.headers,
      payload: { body: 'Daję gwiazdkę.' },
    });

    const list = (await h.app.inject({ method: 'GET', url: `/places/${id}/comments`, headers: ola.headers })).json();
    expect(list.total).toBe(2);
    expect(list.items.map((c: { author: { name: string }; authorRating: number | null }) => [c.author.name, c.authorRating])).toEqual([
      ['Tomek', 4.75],
      ['Ola', null],
    ]);
    expect((await h.app.inject({ method: 'GET', url: `/places/${id}`, headers: ola.headers })).json().commentsCount).toBe(2);
  });

  it('only the author deletes a comment', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const tomek = await login(h.app, 'tomek@gmail.com');
    const id = await createPlace(h.app, ola.headers, pawilon);
    const c = (
      await h.app.inject({ method: 'POST', url: `/places/${id}/comments`, headers: ola.headers, payload: { body: 'Hej' } })
    ).json();
    expect((await h.app.inject({ method: 'DELETE', url: `/comments/${c.id}`, headers: tomek.headers })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'DELETE', url: `/comments/${c.id}`, headers: ola.headers })).statusCode).toBe(204);
  });
});

describe('photos', () => {
  it('uploads and serves photos; the first one is the cover', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const id = await createPlace(h.app, ola.headers, pawilon);

    const res = await upload(h.app, id, ola.headers, 'image/png', PNG);
    expect(res.statusCode).toBe(201);
    const photo = res.json();

    const got = await h.app.inject({ method: 'GET', url: photo.url });
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.rawPayload.equals(PNG)).toBe(true);

    const place = (await h.app.inject({ method: 'GET', url: `/places/${id}`, headers: ola.headers })).json();
    expect(place.coverPhotoUrl).toBe(photo.url);
    expect(place.photos).toEqual([photo]);
  });

  it('rejects other file types and oversized files', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const id = await createPlace(h.app, ola.headers, pawilon);
    expect((await upload(h.app, id, ola.headers, 'application/pdf', PNG)).statusCode).toBe(415);

    const small = await h.build({ MAX_PHOTO_BYTES: '10' });
    expect((await upload(small, id, ola.headers, 'image/png', PNG)).statusCode).toBe(413);
    await small.close();
  });

  it('only the uploader or place author deletes a photo', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const tomek = await login(h.app, 'tomek@gmail.com');
    const kuba = await login(h.app, 'kuba@gmail.com');
    const id = await createPlace(h.app, ola.headers, pawilon);
    const photo = (await upload(h.app, id, tomek.headers, 'image/png', PNG)).json();
    expect((await h.app.inject({ method: 'DELETE', url: photo.url, headers: kuba.headers })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'DELETE', url: photo.url, headers: ola.headers })).statusCode).toBe(204);
  });
});

describe('stats', () => {
  it('summarises the network and the person', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const kuba = await login(h.app, 'kuba@gmail.com');
    const a = await createPlace(h.app, kuba.headers, pawilon);
    const b = await createPlace(h.app, kuba.headers, podPionem);
    await createPlace(h.app, ola.headers, kreska);

    await h.app.inject({ method: 'PUT', url: `/places/${a}/rating`, headers: ola.headers, payload: { vibe: 5, offer: 4 } });
    await h.app.inject({ method: 'PUT', url: `/places/${b}/rating`, headers: ola.headers, payload: { vibe: 3, offer: 4 } });
    await h.app.inject({ method: 'POST', url: `/places/${a}/star`, headers: ola.headers });
    await h.app.inject({ method: 'POST', url: `/places/${a}/star`, headers: kuba.headers });
    await h.app.inject({ method: 'POST', url: `/places/${b}/star`, headers: kuba.headers });

    const net = (await h.app.inject({ method: 'GET', url: '/stats/network', headers: ola.headers })).json();
    expect(net).toMatchObject({
      places: 3,
      people: 2,
      ratings: 2,
      averageRating: 4,
      month: '2026-10-01',
      starsThisMonth: 3,
      starOfTheMonth: { place: { id: a }, stars: 2 },
    });
    expect(net.top.map((p: { id: string }) => p.id)).toEqual([a, b]); // unrated places are left out
    expect(net.categories.find((c: { category: string }) => c.category === 'club')).toEqual({
      category: 'club',
      count: 1,
      share: 0.333,
    });

    const me = (await h.app.inject({ method: 'GET', url: '/stats/me', headers: ola.headers })).json();
    expect(me).toEqual({
      placesAdded: 1,
      ratings: 2,
      averageGiven: 4,
      comments: 0,
      saved: 0,
      stars: { givenTotal: 1, givenThisMonth: 1, left: 2 },
    });
  });

  it('exposes categories and criteria', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/meta' });
    expect(res.json()).toMatchObject({ starsPerMonth: 3, criteria: [{ key: 'vibe', required: true }, {}, {}, {}] });
    expect(res.json().categories).toHaveLength(10);
  });
});
