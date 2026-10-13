import { z } from 'zod';
import type { App, Ctx } from '../app.js';
import { likeEscape } from '../places-query.js';
import { TagList } from '../schemas.js';

/** Tags already on places, for suggestions while tagging a place or searching. */
export function tagRoutes(app: App, ctx: Ctx) {
  const { sql } = ctx;

  app.get(
    '/tags',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Places'],
        summary: 'Tag suggestions',
        description:
          'Tags used on places, most used first. `q` matches anywhere in the tag, ignoring case and Polish ' +
          'accents (tags starting with it first); `category` puts the tags of that category first. Spellings ' +
          'that differ only in case count as one tag.',
        querystring: z.object({
          q: z.string().trim().max(30).optional(),
          category: z.string().max(32).optional(),
          limit: z.coerce.number().int().min(1).max(50).default(10),
        }),
        response: { 200: TagList },
      },
    },
    async (req) => {
      const { q, category, limit } = req.query;
      const text = q ? likeEscape(q) : null;
      const rows = await sql<{ tag: string; places: number; in_category: number }[]>`
        select mode() within group (order by t) as tag,
               count(*)::int as places,
               count(*) filter (where p.category = ${category ?? null})::int as in_category
        from places p, unnest(p.tags) as t
        ${text ? sql`where f_unaccent(lower(t)) like f_unaccent(lower(${`%${text}%`}))` : sql``}
        group by lower(t)
        order by
          ${text ? sql`bool_or(f_unaccent(lower(t)) like f_unaccent(lower(${`${text}%`}))) desc,` : sql``}
          in_category desc, places desc, tag
        limit ${limit}
      `;
      return { items: rows };
    },
  );
}
