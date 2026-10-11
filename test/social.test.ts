import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPlace, kreska, login, pawilon, PHOTO_DIR, podPionem, setup, type TestApp } from './helpers.js';

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
    expect(
      list.items.map((c: { author: { name: string }; authorRating: number | null }) => [c.author.name, c.authorRating]),
    ).toEqual([
      ['Tomek', 4.75],
      ['Ola', null],
    ]);
    expect(
      (await h.app.inject({ method: 'GET', url: `/places/${id}`, headers: ola.headers })).json().commentsCount,
    ).toBe(2);
  });

  it('only the author deletes a comment', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const tomek = await login(h.app, 'tomek@gmail.com');
    const id = await createPlace(h.app, ola.headers, pawilon);
    const c = (
      await h.app.inject({
        method: 'POST',
        url: `/places/${id}/comments`,
        headers: ola.headers,
        payload: { body: 'Hej' },
      })
    ).json();
    expect(
      (await h.app.inject({ method: 'DELETE', url: `/comments/${c.id}`, headers: tomek.headers })).statusCode,
    ).toBe(403);
    expect((await h.app.inject({ method: 'DELETE', url: `/comments/${c.id}`, headers: ola.headers })).statusCode).toBe(
      204,
    );
  });
});

describe('photos', () => {
  const fileOf = (url: string) => {
    const hash = url.split('/').pop()!;
    return join(PHOTO_DIR, hash.slice(0, 2), hash);
  };

  it('stores the file on disk by its hash and serves it; the first one is the cover', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const id = await createPlace(h.app, ola.headers, pawilon);

    const res = await upload(h.app, id, ola.headers, 'image/png', PNG);
    expect(res.statusCode).toBe(201);
    const photo = res.json();
    const hash = createHash('sha256').update(PNG).digest('hex');
    expect(photo.url).toBe(`/photos/${hash}`);
    expect(readFileSync(fileOf(photo.url)).equals(PNG)).toBe(true);
    const [row] = await h.sql`select hash, size_bytes from place_photos where id = ${photo.id}`;
    expect(row).toEqual({ hash, size_bytes: PNG.length });

    const got = await h.app.inject({ method: 'GET', url: photo.url });
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['cache-control']).toContain('immutable');
    expect(got.rawPayload.equals(PNG)).toBe(true);

    const place = (await h.app.inject({ method: 'GET', url: `/places/${id}`, headers: ola.headers })).json();
    expect(place.coverPhotoUrl).toBe(photo.url);
    expect(place.photos).toEqual([photo]);
  });

  it('keeps one file for identical uploads and deletes it with the last reference', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const a = await createPlace(h.app, ola.headers, pawilon);
    const b = await createPlace(h.app, ola.headers, podPionem);

    const first = await upload(h.app, a, ola.headers, 'image/png', PNG);
    const again = await upload(h.app, a, ola.headers, 'image/png', PNG);
    expect(again.statusCode).toBe(200); // same file, same place: the existing photo
    expect(again.json()).toEqual(first.json());
    const other = (await upload(h.app, b, ola.headers, 'image/png', PNG)).json();
    expect(other.url).toBe(first.json().url);

    const del = (place: string, photo: string) =>
      h.app.inject({ method: 'DELETE', url: `/places/${place}/photos/${photo}`, headers: ola.headers });
    expect((await del(a, first.json().id)).statusCode).toBe(204);
    expect(existsSync(fileOf(other.url))).toBe(true); // still used by place b

    // Deleting the place removes its photos and the now unused file.
    expect((await h.app.inject({ method: 'DELETE', url: `/places/${b}`, headers: ola.headers })).statusCode).toBe(204);
    expect(existsSync(fileOf(other.url))).toBe(false);
    expect((await h.app.inject({ method: 'GET', url: other.url })).statusCode).toBe(404);
  });

  it('checks the file itself, not the declared type, and the size limit', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const id = await createPlace(h.app, ola.headers, pawilon);
    const fake = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect((await upload(h.app, id, ola.headers, 'image/png', fake)).statusCode).toBe(415);

    const small = await h.build({ MAX_PHOTO_BYTES: '10' });
    expect((await upload(small, id, ola.headers, 'image/png', PNG)).statusCode).toBe(413);
    await small.close();
  });

  it('does not serve files that no photo references', async () => {
    const hash = 'a'.repeat(64);
    expect((await h.app.inject({ method: 'GET', url: `/photos/${hash}` })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'GET', url: '/photos/..%2F..%2Fetc%2Fpasswd' })).statusCode).toBe(400);
  });

  it('only the uploader or place author deletes a photo', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const tomek = await login(h.app, 'tomek@gmail.com');
    const kuba = await login(h.app, 'kuba@gmail.com');
    const id = await createPlace(h.app, ola.headers, pawilon);
    const photo = (await upload(h.app, id, tomek.headers, 'image/png', PNG)).json();
    const url = `/places/${id}/photos/${photo.id}`;
    expect((await h.app.inject({ method: 'DELETE', url, headers: kuba.headers })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'DELETE', url, headers: ola.headers })).statusCode).toBe(204);
    expect(existsSync(fileOf(photo.url))).toBe(false);
  });
});

describe('stats', () => {
  it('summarises the network and the person', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const kuba = await login(h.app, 'kuba@gmail.com');
    const a = await createPlace(h.app, kuba.headers, pawilon);
    const b = await createPlace(h.app, kuba.headers, podPionem);
    await createPlace(h.app, ola.headers, kreska);

    await h.app.inject({
      method: 'PUT',
      url: `/places/${a}/rating`,
      headers: ola.headers,
      payload: { vibe: 5, offer: 4 },
    });
    await h.app.inject({
      method: 'PUT',
      url: `/places/${b}/rating`,
      headers: ola.headers,
      payload: { vibe: 3, offer: 4 },
    });
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
