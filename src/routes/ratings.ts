import { z } from 'zod';
import type { App, Ctx } from '../app.js';
import { monthStart } from '../domain.js';
import { HttpError } from '../errors.js';
import { starsLeft } from './me.js';
import { loadPlace, placeAuthor } from './places.js';

const idParams = z.object({ id: z.uuid() });
const score = z.number().int().min(1).max(5);

const ratingBody = z.object({
  vibe: score,
  offer: score,
  // null or omitted = "nie dotyczy"
  service: score.nullable().default(null),
  value: score.nullable().default(null),
});

export function ratingRoutes(app: App, ctx: Ctx) {
  const { sql, config } = ctx;

  app.put(
    '/places/:id/rating',
    { preHandler: ctx.auth, schema: { params: idParams, body: ratingBody } },
    async (req) => {
      await placeAuthor(ctx, req.params.id);
      const { vibe, offer, service, value } = req.body;
      await sql`
        insert into ratings (user_id, place_id, vibe, offer, service, value)
        values (${req.user.id}, ${req.params.id}, ${vibe}, ${offer}, ${service}, ${value})
        on conflict (user_id, place_id) do update set
          vibe = excluded.vibe, offer = excluded.offer, service = excluded.service, value = excluded.value,
          updated_at = now()
      `;
      return loadPlace(ctx, req.params.id, req.user.id);
    },
  );

  app.delete('/places/:id/rating', { preHandler: ctx.auth, schema: { params: idParams } }, async (req) => {
    await placeAuthor(ctx, req.params.id);
    await sql`delete from ratings where user_id = ${req.user.id} and place_id = ${req.params.id}`;
    return loadPlace(ctx, req.params.id, req.user.id);
  });

  // Golden star: does not change the rating; limited to STARS_PER_MONTH per person, once per place per month.
  app.post('/places/:id/star', { preHandler: ctx.auth, schema: { params: idParams } }, async (req) => {
    await placeAuthor(ctx, req.params.id);
    const month = monthStart(ctx.now(), config.TIME_ZONE);
    await sql.begin(async (tx) => {
      // Serialises a person's concurrent star requests so the quota cannot be overrun.
      await tx`select id from users where id = ${req.user.id} for update`;
      const [already] = await tx`
        select 1 from stars where user_id = ${req.user.id} and place_id = ${req.params.id} and month = ${month}::date
      `;
      if (already) return;
      const [{ used }] = await tx<[{ used: number }]>`
        select count(*)::int as used from stars where user_id = ${req.user.id} and month = ${month}::date
      `;
      if (used >= config.STARS_PER_MONTH) {
        throw new HttpError(409, 'no_stars_left', 'No golden stars left this month');
      }
      await tx`insert into stars (user_id, place_id, month) values (${req.user.id}, ${req.params.id}, ${month}::date)`;
    });
    return { starred: true, left: await starsLeft(ctx, req.user.id, month) };
  });

  // Takes back a star given this month, returning it to the quota.
  app.delete('/places/:id/star', { preHandler: ctx.auth, schema: { params: idParams } }, async (req) => {
    const month = monthStart(ctx.now(), config.TIME_ZONE);
    await sql`
      delete from stars where user_id = ${req.user.id} and place_id = ${req.params.id} and month = ${month}::date
    `;
    return { starred: false, left: await starsLeft(ctx, req.user.id, month) };
  });
}
