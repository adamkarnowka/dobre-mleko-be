import { z } from 'zod';
import type { App, Ctx } from '../app.js';
import type { Role } from '../auth.js';
import { monthStart, type Category } from '../domain.js';
import { notFound } from '../errors.js';
import { queryPlaces, toPlaceSummary } from '../places-query.js';
import { MyRatingList, PlaceList, Profile } from '../schemas.js';

export async function starsLeft(ctx: Ctx, userId: string, month: string): Promise<number> {
  const [{ used }] = await ctx.sql<[{ used: number }]>`
    select count(*)::int as used from stars where user_id = ${userId} and month = ${month}::date
  `;
  return Math.max(0, (await ctx.settings.get('starsPerMonth')) - used);
}

export async function loadProfile(ctx: Ctx, userId: string) {
  const [user] = await ctx.sql<
    { id: string; email: string; name: string; avatar_url: string | null; created_at: Date; role: Role | null }[]
  >`
    select u.id, u.email, u.name, u.avatar_url, u.created_at, a.role
    from users u left join allowed_emails a on a.email = u.email
    where u.id = ${userId}
  `;
  if (!user) throw notFound('User');
  const month = monthStart(ctx.now(), ctx.config.TIME_ZONE);
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatar_url,
    joinedAt: user.created_at.toISOString(),
    isAdmin: user.role === 'admin',
    stars: {
      perMonth: await ctx.settings.get('starsPerMonth'),
      left: await starsLeft(ctx, user.id, month),
      month,
    },
  };
}

const paging = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export function meRoutes(app: App, ctx: Ctx) {
  const { sql } = ctx;

  app.get(
    '/me',
    { preHandler: ctx.auth, schema: { tags: ['Me'], summary: 'My profile', response: { 200: Profile } } },
    async (req) => loadProfile(ctx, req.user.id),
  );

  app.patch(
    '/me',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Me'],
        summary: 'Change my display name',
        body: z.object({ name: z.string().trim().min(1).max(60) }),
        response: { 200: Profile },
      },
    },
    async (req) => {
      await sql`update users set name = ${req.body.name} where id = ${req.user.id}`;
      return loadProfile(ctx, req.user.id);
    },
  );

  app.get(
    '/me/saved',
    {
      preHandler: ctx.auth,
      schema: { tags: ['Me'], summary: 'My saved places', querystring: paging, response: { 200: PlaceList } },
    },
    async (req) => {
      const now = ctx.now();
      const rows = await queryPlaces(sql, {
        userId: req.user.id,
        month: monthStart(now, ctx.config.TIME_ZONE),
        savedOnly: true,
        sort: 'newest',
        ...req.query,
      });
      return { total: rows[0]?.total ?? 0, items: rows.map((r) => toPlaceSummary(r, ctx.config.TIME_ZONE, now)) };
    },
  );

  app.get(
    '/me/ratings',
    {
      preHandler: ctx.auth,
      schema: { tags: ['Me'], summary: 'My ratings', querystring: paging, response: { 200: MyRatingList } },
    },
    async (req) => {
      const rows = await sql<
        {
          place_id: string;
          place_name: string;
          category: Category;
          vibe: number;
          offer: number;
          service: number | null;
          value: number | null;
          overall: number;
          updated_at: Date;
          total: number;
        }[]
      >`
      select r.place_id, p.name as place_name, p.category, r.vibe, r.offer, r.service, r.value, r.overall, r.updated_at,
             (count(*) over ())::int as total
      from ratings r join places p on p.id = r.place_id
      where r.user_id = ${req.user.id}
      order by r.updated_at desc
      limit ${req.query.limit} offset ${req.query.offset}
    `;
      return {
        total: rows[0]?.total ?? 0,
        items: rows.map((r) => ({
          place: { id: r.place_id, name: r.place_name, category: r.category },
          scores: { vibe: r.vibe, offer: r.offer, service: r.service, value: r.value },
          overall: r.overall,
          updatedAt: r.updated_at.toISOString(),
        })),
      };
    },
  );
}
