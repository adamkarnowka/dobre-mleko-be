import { z } from 'zod';
import type { App, Ctx } from '../app.js';
import { view } from '../app.js';
import { CATEGORIES, monthStart, type Category } from '../domain.js';
import { notFound } from '../errors.js';
import { decodeCursor, page, pagingQuery } from '../paging.js';
import { lockHash, releaseFiles } from '../photo-store.js';
import { queryPlaces, toPlaceSummary } from '../places-query.js';
import { toProfile, type ProfileJson } from '../profiles.js';
import { GoldStarQuota, Me, MyRatingList, PlaceList } from '../schemas.js';
import { readImageUpload, storeImage } from '../uploads.js';

export async function starsLeft(ctx: Ctx, userId: string, month: string): Promise<number> {
  const [{ used }] = await ctx.sql<[{ used: number }]>`
    select count(*)::int as used from stars where user_id = ${userId} and month = ${month}::date
  `;
  return Math.max(0, (await ctx.settings.get('starsPerMonth')) - used);
}

export async function goldStarQuota(ctx: Ctx, userId: string) {
  const month = monthStart(ctx.now(), ctx.config.TIME_ZONE);
  return { per_month: await ctx.settings.get('starsPerMonth'), left: await starsLeft(ctx, userId, month), month };
}

export async function loadMe(ctx: Ctx, userId: string) {
  const [user] = await ctx.sql<{ profile: ProfileJson; email: string; profile_completed_at: Date | null }[]>`
    select profile_json(u) as profile, u.email, u.profile_completed_at from users u where u.id = ${userId}
  `;
  if (!user) throw notFound('User');
  const profile = toProfile(user.profile, ctx.urls);
  return {
    ...profile,
    email: user.email,
    is_admin: profile.role === 'admin',
    has_profile: !!user.profile_completed_at,
    gold_stars: await goldStarQuota(ctx, userId),
  };
}

const displayName = z.string().trim().min(1).max(60);
// Trimmed; an empty badge clears it.
const badge = z
  .string()
  .trim()
  .max(16)
  .nullable()
  .transform((b) => b || null);
const favoriteCategories = z
  .array(z.enum(CATEGORIES))
  .max(3)
  .refine((c) => new Set(c).size === c.length, 'Categories must be different');

export function meRoutes(app: App, ctx: Ctx) {
  const { sql } = ctx;

  app.get(
    '/me',
    { preHandler: ctx.auth, schema: { tags: ['Me'], summary: 'Me', response: { 200: Me } } },
    async (req) => loadMe(ctx, req.user.id),
  );

  app.post(
    '/me/profile',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Me'],
        summary: 'Finish onboarding',
        description:
          'Sets the display name, badge (max 16 characters) and up to 3 favourite categories; `has_profile` becomes true.',
        body: z.object({
          display_name: displayName,
          badge: badge.default(null),
          favorite_categories: favoriteCategories.default([]),
        }),
        response: { 200: Me },
      },
    },
    async (req) => {
      const b = req.body;
      await sql`
        update users set
          name = ${b.display_name}, badge = ${b.badge}, favorite_categories = ${b.favorite_categories},
          profile_completed_at = coalesce(profile_completed_at, now())
        where id = ${req.user.id}
      `;
      return loadMe(ctx, req.user.id);
    },
  );

  app.patch(
    '/me',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Me'],
        summary: 'Update my profile',
        description: 'Send only the fields to change. Role and status cannot be changed here.',
        body: z.object({
          display_name: displayName.optional(),
          badge: badge.optional(),
          favorite_categories: favoriteCategories.optional(),
        }),
        response: { 200: Me },
      },
    },
    async (req) => {
      const b = req.body;
      const set: Record<string, unknown> = {};
      if (b.display_name !== undefined) set.name = b.display_name;
      if (b.badge !== undefined) set.badge = b.badge;
      if (b.favorite_categories !== undefined) set.favorite_categories = b.favorite_categories;
      if (Object.keys(set).length) await sql`update users set ${sql(set)} where id = ${req.user.id}`;
      return loadMe(ctx, req.user.id);
    },
  );

  app.put(
    '/me/avatar',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Me'],
        summary: 'Upload my avatar',
        description: 'multipart/form-data with one image file. Replaces the Google picture.',
        consumes: ['multipart/form-data'],
        response: { 200: Me },
      },
    },
    async (req) => {
      const upload = await readImageUpload(req, ctx);
      await sql.begin(async (tx) => {
        const [old] = await tx<{ avatar_hash: string | null }[]>`
          select avatar_hash from users where id = ${req.user.id} for update
        `;
        await lockHash(tx, upload.hash);
        await storeImage(ctx, upload);
        await tx`update users set avatar_hash = ${upload.hash} where id = ${req.user.id}`;
        if (old?.avatar_hash && old.avatar_hash !== upload.hash) await releaseFiles(tx, ctx.photos, [old.avatar_hash]);
      });
      return loadMe(ctx, req.user.id);
    },
  );

  app.delete(
    '/me/avatar',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Me'],
        summary: 'Remove my avatar',
        description: 'Falls back to the Google picture.',
        response: { 200: Me },
      },
    },
    async (req) => {
      await sql.begin(async (tx) => {
        const [old] = await tx<{ avatar_hash: string | null }[]>`
          select avatar_hash from users where id = ${req.user.id} for update
        `;
        await tx`update users set avatar_hash = null where id = ${req.user.id}`;
        if (old?.avatar_hash) await releaseFiles(tx, ctx.photos, [old.avatar_hash]);
      });
      return loadMe(ctx, req.user.id);
    },
  );

  app.get(
    '/me/gold-stars',
    {
      preHandler: ctx.auth,
      schema: { tags: ['Me'], summary: 'My gold stars left this month', response: { 200: GoldStarQuota } },
    },
    async (req) => goldStarQuota(ctx, req.user.id),
  );

  app.get(
    '/me/saved',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Me'],
        summary: 'My saved places',
        description: 'Same as `GET /places?saved_only=true&sort=newest`.',
        querystring: z.object({ ...pagingQuery() }),
        response: { 200: PlaceList },
      },
    },
    async (req) => {
      const offset = decodeCursor(req.query.cursor);
      const rows = await queryPlaces(sql, {
        userId: req.user.id,
        month: monthStart(ctx.now(), ctx.config.TIME_ZONE),
        starRankBonus: await ctx.settings.get('starRankBonus'),
        savedOnly: true,
        includeClosed: true,
        sort: 'newest',
        limit: req.query.limit,
        offset,
      });
      const v = view(ctx);
      return page(
        rows.map((r) => toPlaceSummary(r, v)),
        offset,
        rows[0]?.total ?? 0,
      );
    },
  );

  app.get(
    '/me/ratings',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Me'],
        summary: 'My ratings',
        querystring: z.object({ ...pagingQuery() }),
        response: { 200: MyRatingList },
      },
    },
    async (req) => {
      const offset = decodeCursor(req.query.cursor);
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
        select r.place_id, p.name as place_name, p.category, r.vibe, r.offer, r.service, r.value, r.overall,
               r.updated_at, (count(*) over ())::int as total
        from ratings r join places p on p.id = r.place_id
        where r.user_id = ${req.user.id}
        order by r.updated_at desc, r.place_id
        limit ${req.query.limit} offset ${offset}
      `;
      return page(
        rows.map((r) => ({
          place: { id: r.place_id, name: r.place_name, category_id: r.category },
          scores: { vibe: r.vibe, offer: r.offer, service: r.service, value: r.value },
          overall: r.overall,
          updated_at: r.updated_at.toISOString(),
        })),
        offset,
        rows[0]?.total ?? 0,
      );
    },
  );
}
