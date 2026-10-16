import { z } from 'zod';
import type { App, Ctx } from '../app.js';
import { HttpError } from '../errors.js';
import { MapsLinkError, resolveMapsLink } from '../maps-link.js';
import { ResolvedMapsLink } from '../schemas.js';

/** Pasting a Google Maps link when adding a place: what the link says, and what is already here. */
export function mapsLinkRoutes(app: App, ctx: Ctx) {
  const { sql } = ctx;

  app.post(
    '/maps-links/resolve',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Places'],
        summary: 'Read a Google Maps link',
        description:
          "The place's name and position from a Google Maps link (full links and the app's maps.app.goo.gl share " +
          'links, which are followed on the server, to Google hosts only), plus places already in the app nearby. ' +
          'Fill the rest (address, category) from a map search. The text may contain more than the link. ' +
          '422 `unrecognized_link` when it is not a Google Maps link to a place or does not resolve.',
        body: z.object({ text: z.string().min(1).max(2000).meta({ description: 'The pasted link (or share text)' }) }),
        response: { 200: ResolvedMapsLink },
      },
    },
    async (req) => {
      let link;
      try {
        link = await resolveMapsLink(req.body.text, ctx.fetchMapsLink);
      } catch (error) {
        if (error instanceof MapsLinkError || (error instanceof Error && error.name === 'TimeoutError')) {
          throw new HttpError(422, 'unrecognized_link', error.message);
        }
        throw error;
      }
      const nearby = link.location
        ? await sql<{ id: string; name: string; category_id: string; distance_m: number }[]>`
            with here as (select st_setsrid(st_makepoint(${link.location.lng}, ${link.location.lat}), 4326)::geography as g)
            select p.id, p.name, p.category as category_id, round(st_distance(p.geom::geography, here.g))::int as distance_m
            from places p, here
            where st_dwithin(p.geom::geography, here.g, 150)
            order by similarity(f_unaccent(lower(p.name)), f_unaccent(lower(${link.name ?? ''}))) desc, distance_m
            limit 5
          `
        : [];
      return { ...link, nearby };
    },
  );
}
