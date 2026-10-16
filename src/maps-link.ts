// Google Maps links people paste when adding a place: the place's name and exact position, read from the link
// itself. Short share links (maps.app.goo.gl) are followed server-side, hop by hop, to Google hosts only.

export interface MapsLink {
  /** The link to keep: the short link as pasted, else the full one without tracking parameters. */
  url: string;
  /** The place's name, when the link names a place. */
  name: string | null;
  /** Where the place is; `precise` is false for a map view's centre rather than the place itself. */
  location: { lat: number; lng: number; precise: boolean } | null;
}

export class MapsLinkError extends Error {}

const SHORT_HOSTS = new Set(['maps.app.goo.gl', 'goo.gl']);
const GOOGLE_HOST = /^(?:www\.|maps\.)?google\.(?:[a-z]{2,3}|co\.[a-z]{2}|com\.[a-z]{2})$/;
const MAX_HOPS = 5;
const TIMEOUT_MS = 5000;
// Parameters Google adds for tracking and app hand-off; the place does not depend on them.
const TRACKING = ['entry', 'g_ep', 'g_st', 'shorturl', 'utm_source', 'utm_medium', 'utm_campaign', 'hl', 'gl'];

export const isShortLink = (u: URL) =>
  SHORT_HOSTS.has(u.hostname) && (u.hostname !== 'goo.gl' || u.pathname.startsWith('/maps'));
export const isMapsLink = (u: URL) =>
  u.protocol === 'https:' &&
  (isShortLink(u) ||
    (GOOGLE_HOST.test(u.hostname) && (u.hostname.startsWith('maps.') || u.pathname.startsWith('/maps'))));

/** The first https link in pasted text (the Maps app may share "Name, address https://maps.app.goo.gl/…"). */
export function extractUrl(text: string): URL {
  const match = text.match(/https:\/\/[^\s<>"']+/);
  if (!match) throw new MapsLinkError('No link found');
  try {
    return new URL(match[0]);
  } catch {
    throw new MapsLinkError('Not a valid link');
  }
}

const coordsIn = (s: string | null | undefined) => {
  const m = s?.match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
};

const decode = (segment: string) => {
  try {
    return decodeURIComponent(segment.replace(/\+/g, ' ')).trim();
  } catch {
    return segment.trim();
  }
};

/** Name and position from a full Google Maps link. */
export function parseMapsUrl(u: URL): Omit<MapsLink, 'url'> {
  const path = u.pathname;
  let name: string | null = null;
  let location: MapsLink['location'] = null;

  // /maps/place/<name>/… or /maps/search/<query>/…
  const named = path.match(/\/maps\/(?:place|search)\/([^/]+)/);
  if (named) name = decode(named[1]!);

  // The place itself: …!3d<lat>!4d<lng> in the data part. The last pair is the place (earlier ones can be others).
  const pins = [...path.matchAll(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/g)];
  const pin = pins.at(-1);
  if (pin) location = { lat: Number(pin[1]), lng: Number(pin[2]), precise: true };

  // Query parameters: q / query / destination / ll — either coordinates or a name.
  for (const key of ['q', 'query', 'destination', 'll', 'center']) {
    const value = u.searchParams.get(key);
    if (!value) continue;
    const c = coordsIn(value);
    if (c && !location) location = { ...c, precise: key !== 'center' };
    else if (!c && !name && key !== 'll' && key !== 'center') name = value.trim();
  }

  // The map view's centre: @<lat>,<lng>,<zoom>z — near the place, not exactly on it.
  const view = path.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (view && !location) location = { lat: Number(view[1]), lng: Number(view[2]), precise: false };

  // A "name" that is only coordinates (dropped pins) is not a name.
  if (name && (coordsIn(name) || /^\d+°/.test(name))) name = null;
  if (name) name = name.slice(0, 120);
  return { name, location };
}

const withoutTracking = (u: URL) => {
  const clean = new URL(u);
  for (const key of TRACKING) clean.searchParams.delete(key);
  return clean.toString();
};

/** Follows a pasted Google Maps link (short links included) and reads the place's name and position. */
export async function resolveMapsLink(text: string, fetchImpl: typeof fetch = fetch): Promise<MapsLink> {
  const pasted = extractUrl(text);
  if (!isMapsLink(pasted)) throw new MapsLinkError('Not a Google Maps link');

  let current = pasted;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    // Outside the EU-consent detour, a full link is where the place is described.
    if (current.hostname === 'consent.google.com') {
      const next = current.searchParams.get('continue');
      if (!next) throw new MapsLinkError('Google asked for consent instead of showing the place');
      current = new URL(next);
      continue;
    }
    if (!isShortLink(current)) {
      if (!isMapsLink(current)) throw new MapsLinkError('The link leads outside Google Maps');
      const parsed = parseMapsUrl(current);
      if (!parsed.name && !parsed.location) throw new MapsLinkError('The link does not point at a place');
      return { url: isShortLink(pasted) ? pasted.toString() : withoutTracking(current), ...parsed };
    }
    const res = await fetchImpl(current, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !location) throw new MapsLinkError('The short link did not resolve');
    current = new URL(location, current);
  }
  throw new MapsLinkError('Too many redirects');
}
