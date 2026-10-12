import { z } from 'zod';
import type { App, Ctx } from '../app.js';
import { CATEGORIES, CRITERIA, monthStart, type CriterionKey } from '../domain.js';
import { HttpError, notFound } from '../errors.js';
import { releaseFiles } from '../photo-store.js';
import { queryPlaces, toPlaceSummary } from '../places-query.js';
import { ErrorBody, PlaceDetail, PlaceList, SavedResult } from '../schemas.js';
import { starsLeft } from './me.js';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');

const placeFields = {
  name: z.string().trim().min(1).max(120),
  category: z.enum(CATEGORIES),
  priceLevel: z.number().int().min(1).max(4).nullable(),
  address: z.string().trim().max(200).nullable(),
  location: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }),
  description: z.string().trim().max(2000).nullable(),
  tags: z.array(z.string().trim().min(1).max(30)).max(10),
  openingHours: z
    .array(z.object({ day: z.number().int().min(0).max(6), open: hhmm, close: hhmm }))
    .max(21)
    .nullable(),
  googlePlaceId: z.string().max(200).nullable(),
};

const createPlace = z.object({
  ...placeFields,
  priceLevel: placeFields.priceLevel.default(null),
  address: placeFields.address.default(null),
  description: placeFields.description.default(null),
  tags: placeFields.tags.default([]),
  openingHours: placeFields.openingHours.default(null),
  googlePlaceId: placeFields.googlePlaceId.default(null),
});

const updatePlace = z.object(placeFields).partial();

const idParams = z.object({ id: z.uuid() });

const listQuery = z
  .object({
    q: z.string().max(100).optional(),
    category: z
      .string()
      .optional()
      .transform((s) => (s ? s.split(',').map((c) => c.trim()) : undefined))
      .pipe(z.array(z.enum(CATEGORIES)).optional()),
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    maxDistanceKm: z.coerce.number().positive().optional(),
    bbox: z
      .string()
      .optional()
      .meta({ description: 'Map viewport: minLng,minLat,maxLng,maxLat', example: '20.9,52.15,21.15,52.3' })
      .transform((s, c) => {
        if (s == null) return undefined;
        const n = s.split(',').map(Number);
        const [minLng, minLat, maxLng, maxLat] = n as [number, number, number, number];
        const ok =
          n.length === 4 &&
          n.every(Number.isFinite) &&
          minLng >= -180 &&
          maxLng <= 180 &&
          minLat >= -90 &&
          maxLat <= 90 &&
          minLng < maxLng &&
          minLat < maxLat;
        if (!ok) {
          c.addIssue({ code: 'custom', message: 'bbox must be minLng,minLat,maxLng,maxLat' });
          return z.NEVER;
        }
        return { minLng, minLat, maxLng, maxLat };
      }),
    sort: z.enum(['best', 'stars', 'near', 'newest']).default('best'),
    limit: z.coerce.number().int().min(1).max(500).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .refine((q) => (q.lat == null) === (q.lng == null), { message: 'lat and lng go together' })
  .refine((q) => q.lat != null || (q.sort !== 'near' && q.maxDistanceKm == null), {
    message: 'sort=near and maxDistanceKm need lat and lng',
  });

const nearQuery = z
  .object({ lat: z.coerce.number().min(-90).max(90).optional(), lng: z.coerce.number().min(-180).max(180).optional() })
  .refine((q) => (q.lat == null) === (q.lng == null), { message: 'lat and lng go together' });

/** Ensures the place exists and returns its author. */
export async function placeAuthor(ctx: Ctx, placeId: string): Promise<string> {
  const [place] = await ctx.sql<{ added_by: string }[]>`select added_by from places where id = ${placeId}`;
  if (!place) throw notFound('Place');
  return place.added_by;
}

export async function loadPlace(ctx: Ctx, placeId: string, userId: string, near?: { lat: number; lng: number }) {
  const { sql, config } = ctx;
  const now = ctx.now();
  const month = monthStart(now, config.TIME_ZONE);
  const [row] = await queryPlaces(sql, { userId, month, ids: [placeId], near });
  if (!row) throw notFound('Place');

  const [[extra], photos, [criteria], [mine], [myStar]] = await Promise.all([
    sql<{ description: string | null; google_place_id: string | null; updated_at: Date; comments: number }[]>`
      select description, google_place_id, updated_at,
             (select count(*)::int from comments c where c.place_id = p.id) as comments
      from places p where id = ${placeId}
    `,
    sql<
      { id: string; hash: string }[]
    >`select id, hash from place_photos where place_id = ${placeId} order by created_at, id`,
    sql<Record<string, number | null>[]>`
      select avg(vibe)::numeric(3, 2) as vibe, avg(offer)::numeric(3, 2) as offer,
             avg(service)::numeric(3, 2) as service, avg(value)::numeric(3, 2) as value,
             count(service)::int as service_count, count(value)::int as value_count
      from ratings where place_id = ${placeId}
    `,
    sql<
      { vibe: number; offer: number; service: number | null; value: number | null; overall: number; updated_at: Date }[]
    >`
      select vibe, offer, service, value, overall, updated_at from ratings where place_id = ${placeId} and user_id = ${userId}
    `,
    sql`select 1 from stars where place_id = ${placeId} and user_id = ${userId} and month = ${month}::date`,
  ]);

  const breakdown = CRITERIA.map((c) => ({
    key: c.key,
    average: criteria?.[c.key] ?? null,
    count: c.required ? row.rating_count : (criteria?.[`${c.key}_count`] ?? 0),
  }));
  const strongest = breakdown
    .filter((c) => c.average != null)
    .reduce<(typeof breakdown)[number] | null>((best, c) => (!best || c.average! > best.average! ? c : best), null);

  return {
    ...toPlaceSummary(row, config.TIME_ZONE, now),
    description: extra!.description,
    googlePlaceId: extra!.google_place_id,
    openingHours: row.opening_hours,
    photos: photos.map((p) => ({ id: p.id, url: `/photos/${p.hash}` })),
    criteria: breakdown,
    strongestCriterion: (strongest?.key ?? null) as CriterionKey | null,
    commentsCount: extra!.comments,
    myRating: mine
      ? {
          scores: { vibe: mine.vibe, offer: mine.offer, service: mine.service, value: mine.value },
          overall: mine.overall,
          updatedAt: mine.updated_at.toISOString(),
        }
      : null,
    myStar: { givenThisMonth: !!myStar, left: await starsLeft(ctx, userId, month) },
    updatedAt: extra!.updated_at.toISOString(),
  };
}

export function placeRoutes(app: App, ctx: Ctx) {
  const { sql, config } = ctx;

  app.get(
    '/places',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Places'],
        summary: 'Discover places',
        description:
          'Search (`q` matches name, address and tags), filter and sort. `sort=best` ranks by rating pulled towards ' +
          'the network average with the weight of 3 ratings; `stars` by golden stars this month; `near` by distance. ' +
          'For the map, pass `bbox` (the visible area) with a `limit` of up to 500.',
        querystring: listQuery,
        response: { 200: PlaceList },
      },
    },
    async (req) => {
      const { q, category, lat, lng, maxDistanceKm, bbox, sort, limit, offset } = req.query;
      const now = ctx.now();
      const rows = await queryPlaces(sql, {
        userId: req.user.id,
        month: monthStart(now, config.TIME_ZONE),
        q,
        categories: category,
        near: lat != null && lng != null ? { lat, lng } : undefined,
        maxDistanceKm,
        bbox,
        sort,
        limit,
        offset,
      });
      return { total: rows[0]?.total ?? 0, items: rows.map((r) => toPlaceSummary(r, config.TIME_ZONE, now)) };
    },
  );

  app.post(
    '/places',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Places'],
        summary: 'Add a place',
        description: '409 `place_exists` (with `placeId`) when a place with the same `googlePlaceId` is already there.',
        body: createPlace,
        response: { 201: PlaceDetail, 409: ErrorBody },
      },
    },
    async (req, reply) => {
      const b = req.body;
      if (b.googlePlaceId) {
        const [existing] = await sql`select id from places where google_place_id = ${b.googlePlaceId}`;
        if (existing) {
          return reply.status(409).send({
            error: { code: 'place_exists', message: 'This place is already on the map', placeId: existing.id },
          });
        }
      }
      const [created] = await sql<{ id: string }[]>`
      insert into places (name, category, price_level, address, lat, lng, description, tags, opening_hours, google_place_id, added_by)
      values (${b.name}, ${b.category}, ${b.priceLevel}, ${b.address}, ${b.location.lat}, ${b.location.lng},
              ${b.description}, ${b.tags}, ${b.openingHours ? sql.json(b.openingHours) : null}, ${b.googlePlaceId}, ${req.user.id})
      returning id
    `;
      return reply.status(201).send(await loadPlace(ctx, created!.id, req.user.id));
    },
  );

  app.get(
    '/places/:id',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Places'],
        summary: 'Place details',
        description: 'Pass `lat`/`lng` to get `distanceKm`.',
        params: idParams,
        querystring: nearQuery,
        response: { 200: PlaceDetail },
      },
    },
    async (req) => {
      const { lat, lng } = req.query;
      return loadPlace(ctx, req.params.id, req.user.id, lat != null && lng != null ? { lat, lng } : undefined);
    },
  );

  app.patch(
    '/places/:id',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Places'],
        summary: 'Edit a place',
        description: 'Only the person who added the place. Send just the fields to change.',
        params: idParams,
        body: updatePlace,
        response: { 200: PlaceDetail },
      },
    },
    async (req) => {
      if ((await placeAuthor(ctx, req.params.id)) !== req.user.id) {
        throw new HttpError(403, 'forbidden', 'Only the person who added the place can edit it');
      }
      const b = req.body;
      const set: Record<string, unknown> = {};
      if (b.name !== undefined) set.name = b.name;
      if (b.category !== undefined) set.category = b.category;
      if (b.priceLevel !== undefined) set.price_level = b.priceLevel;
      if (b.address !== undefined) set.address = b.address;
      if (b.location !== undefined) Object.assign(set, { lat: b.location.lat, lng: b.location.lng });
      if (b.description !== undefined) set.description = b.description;
      if (b.tags !== undefined) set.tags = b.tags;
      if (b.openingHours !== undefined) set.opening_hours = b.openingHours ? sql.json(b.openingHours) : null;
      if (b.googlePlaceId !== undefined) set.google_place_id = b.googlePlaceId;
      if (Object.keys(set).length) {
        await sql`update places set ${sql(set)}, updated_at = now() where id = ${req.params.id}`;
      }
      return loadPlace(ctx, req.params.id, req.user.id);
    },
  );

  app.delete(
    '/places/:id',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Places'],
        summary: 'Delete a place',
        description: 'Only the person who added it. Removes its ratings, stars, comments and photos.',
        params: idParams,
      },
    },
    async (req, reply) => {
      if ((await placeAuthor(ctx, req.params.id)) !== req.user.id) {
        throw new HttpError(403, 'forbidden', 'Only the person who added the place can delete it');
      }
      await sql.begin(async (tx) => {
        const photos = await tx<{ hash: string }[]>`select hash from place_photos where place_id = ${req.params.id}`;
        await tx`delete from places where id = ${req.params.id}`;
        await releaseFiles(
          tx,
          ctx.photos,
          photos.map((p) => p.hash),
        );
      });
      return reply.status(204).send();
    },
  );

  const savedSchema = (summary: string) => ({
    tags: ['Places'],
    summary,
    params: idParams,
    response: { 200: SavedResult },
  });

  app.put('/places/:id/saved', { preHandler: ctx.auth, schema: savedSchema('Save a place for later') }, async (req) => {
    await placeAuthor(ctx, req.params.id);
    await sql`
      insert into saved_places (user_id, place_id) values (${req.user.id}, ${req.params.id}) on conflict do nothing
    `;
    return { saved: true };
  });

  app.delete('/places/:id/saved', { preHandler: ctx.auth, schema: savedSchema('Unsave a place') }, async (req) => {
    await sql`delete from saved_places where user_id = ${req.user.id} and place_id = ${req.params.id}`;
    return { saved: false };
  });
}
