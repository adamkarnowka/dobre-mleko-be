import { describe, expect, it } from 'vitest';
import { createPlace, login, mapsRedirects, setup } from './helpers.js';

const h = setup();

const FULL =
  'https://www.google.com/maps/place/Kawiarnia+Relaks/@50.0951,18.5402,17z/data=!3m1!4b1!4m6!3m5!1s0x4711:0x22!8m2!3d50.0955!4d18.5419!16s%2Fg%2F11abc?entry=ttu';
const SHORT = 'https://maps.app.goo.gl/Relaks1';
mapsRedirects[SHORT] = FULL;

describe('adding a place from a Google Maps link', () => {
  it('reads the link and lists places already nearby', async () => {
    const kuba = await login(h.app, 'kuba@gmail.com');
    const near = await createPlace(h.app, kuba, {
      name: 'Kawiarnia Relaks',
      category_id: 'coffee',
      location: { lat: 50.0956, lng: 18.542 },
    });
    await createPlace(h.app, kuba, { name: 'Bar obok', category_id: 'bar', location: { lat: 50.0957, lng: 18.5418 } });
    await createPlace(h.app, kuba, { name: 'Daleko', category_id: 'bar', location: { lat: 50.2, lng: 18.6 } });

    const res = await h.app.inject({
      method: 'POST',
      url: '/maps-links/resolve',
      headers: kuba.headers,
      payload: { text: `Kawiarnia Relaks\n${SHORT}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      url: SHORT,
      name: 'Kawiarnia Relaks',
      location: { lat: 50.0955, lng: 18.5419, precise: true },
    });
    // The same name comes first, then by distance; far places are not listed.
    expect(body.nearby.map((p: { id: string }) => p.id)[0]).toBe(near);
    expect(body.nearby.map((p: { name: string }) => p.name)).toEqual(['Kawiarnia Relaks', 'Bar obok']);
    expect(body.nearby[0].distance_m).toBeLessThan(20);
  });

  it('refuses what is not a Google Maps place', async () => {
    const kuba = await login(h.app, 'kuba@gmail.com');
    for (const text of ['https://example.com/x', 'https://maps.app.goo.gl/unknown', 'zwykły tekst']) {
      const res = await h.app.inject({
        method: 'POST',
        url: '/maps-links/resolve',
        headers: kuba.headers,
        payload: { text },
      });
      expect([res.statusCode, res.json().error]).toEqual([422, 'unrecognized_link']);
    }
    expect(
      (await h.app.inject({ method: 'POST', url: '/maps-links/resolve', payload: { text: SHORT } })).statusCode,
    ).toBe(401);
  });

  it('keeps the link with the place', async () => {
    const kuba = await login(h.app, 'kuba@gmail.com');
    const id = await createPlace(h.app, kuba, {
      name: 'Kawiarnia Relaks',
      category_id: 'coffee',
      location: { lat: 50.0955, lng: 18.5419 },
      google_maps_url: SHORT,
    });
    const get = async () => (await h.app.inject({ method: 'GET', url: `/places/${id}`, headers: kuba.headers })).json();
    expect((await get()).google_maps_url).toBe(SHORT);

    const patch = (google_maps_url: string | null) =>
      h.app.inject({ method: 'PATCH', url: `/places/${id}`, headers: kuba.headers, payload: { google_maps_url } });
    expect((await patch('https://evil.example/maps')).statusCode).toBe(422);
    expect((await patch(null)).statusCode).toBe(200);
    expect((await get()).google_maps_url).toBeNull();
  });
});
