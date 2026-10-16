import { describe, expect, it } from 'vitest';
import { MapsLinkError, parseMapsUrl, resolveMapsLink } from '../src/maps-link.js';

const FULL =
  'https://www.google.com/maps/place/Kawiarnia+Relaks/@50.0951,18.5402,17z/data=!3m1!4b1!4m6!3m5!1s0x4711:0x22!8m2!3d50.0955132!4d18.5419042!16s%2Fg%2F11abc?entry=ttu&g_ep=EgoyMDI2';

/** A fake fetch that answers each URL with a redirect (or a 200). */
const redirects =
  (map: Record<string, string>): typeof fetch =>
  async (input) => {
    const target = map[String(input)];
    return new Response(null, target ? { status: 302, headers: { location: target } } : { status: 200 });
  };

describe('Google Maps links', () => {
  it('reads the name and the exact pin from a full link', () => {
    expect(parseMapsUrl(new URL(FULL))).toEqual({
      name: 'Kawiarnia Relaks',
      location: { lat: 50.0955132, lng: 18.5419042, precise: true },
    });
  });

  it('falls back to the map centre, query coordinates or a search', () => {
    expect(parseMapsUrl(new URL('https://www.google.com/maps/@50.1,18.5,15z')).location).toEqual({
      lat: 50.1,
      lng: 18.5,
      precise: false,
    });
    expect(parseMapsUrl(new URL('https://maps.google.com/?q=50.0955,18.5419'))).toEqual({
      name: null,
      location: { lat: 50.0955, lng: 18.5419, precise: true },
    });
    expect(parseMapsUrl(new URL('https://www.google.pl/maps/search/Pizzeria+Roma+Rybnik/'))).toEqual({
      name: 'Pizzeria Roma Rybnik',
      location: null,
    });
    // A dropped pin has coordinates for a name.
    expect(
      parseMapsUrl(new URL("https://www.google.com/maps/place/50%C2%B005'43.8%22N/@50.1,18.5,17z")).name,
    ).toBeNull();
  });

  it('follows short links, keeps the short link and drops tracking from full ones', async () => {
    const short = 'https://maps.app.goo.gl/AbC123';
    const resolved = await resolveMapsLink(`Kawiarnia Relaks ${short}`, redirects({ [short]: FULL }));
    expect(resolved).toEqual({
      url: short,
      name: 'Kawiarnia Relaks',
      location: { lat: 50.0955132, lng: 18.5419042, precise: true },
    });
    const direct = await resolveMapsLink(FULL, redirects({}));
    expect(direct.url).not.toContain('entry=');
    expect(direct.url).toContain('!3d50.0955132');
  });

  it('passes the EU consent page through to the place', async () => {
    const short = 'https://maps.app.goo.gl/Xyz';
    const consent = `https://consent.google.com/m?continue=${encodeURIComponent(FULL)}&gl=PL`;
    expect((await resolveMapsLink(short, redirects({ [short]: consent }))).name).toBe('Kawiarnia Relaks');
  });

  it('refuses other sites, redirects away from Google and links without a place', async () => {
    const fail = (text: string, map: Record<string, string> = {}) =>
      expect(resolveMapsLink(text, redirects(map))).rejects.toThrow(MapsLinkError);
    await fail('no link here');
    await fail('https://example.com/maps/place/X/@1,2,3z');
    await fail('http://www.google.com/maps/place/X/@1,2,3z'); // not https
    await fail('https://maps.app.goo.gl/evil', { 'https://maps.app.goo.gl/evil': 'https://evil.example/' });
    await fail('https://maps.app.goo.gl/loop', { 'https://maps.app.goo.gl/loop': 'https://maps.app.goo.gl/loop' });
    await fail('https://www.google.com/maps');
  });
});
