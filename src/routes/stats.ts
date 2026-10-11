import type { App, Ctx } from '../app.js';
import { CATEGORIES, monthStart } from '../domain.js';
import { queryPlaces, toPlaceSummary } from '../places-query.js';
import { starsLeft } from './me.js';

export function statsRoutes(app: App, ctx: Ctx) {
  const { sql, config } = ctx;

  app.get('/stats/network', { preHandler: ctx.auth }, async (req) => {
    const now = ctx.now();
    const month = monthStart(now, config.TIME_ZONE);
    const [[totals], categories, top, [starOfMonth]] = await Promise.all([
      sql<{ places: number; people: number; ratings: number; average: number | null; stars: number }[]>`
        select
          (select count(*)::int from places) as places,
          (select count(*)::int from users) as people,
          (select count(*)::int from ratings) as ratings,
          (select avg(overall)::numeric(3, 2) from ratings) as average,
          (select count(*)::int from stars where month = ${month}::date) as stars
      `,
      sql<{ category: string; n: number }[]>`select category, count(*)::int as n from places group by category`,
      queryPlaces(sql, { userId: req.user.id, month, ratedOnly: true, sort: 'best', limit: 10 }),
      queryPlaces(sql, { userId: req.user.id, month, sort: 'stars', limit: 1 }),
    ]);

    const counts = new Map(categories.map((c) => [c.category, c.n]));
    return {
      places: totals!.places,
      people: totals!.people,
      ratings: totals!.ratings,
      averageRating: totals!.average,
      month,
      starsThisMonth: totals!.stars,
      starOfTheMonth:
        starOfMonth && starOfMonth.stars_month > 0
          ? { place: toPlaceSummary(starOfMonth, config.TIME_ZONE, now), stars: starOfMonth.stars_month }
          : null,
      top: top.map((r) => toPlaceSummary(r, config.TIME_ZONE, now)),
      categories: CATEGORIES.map((category) => {
        const count = counts.get(category) ?? 0;
        return { category, count, share: totals!.places ? Math.round((count / totals!.places) * 1000) / 1000 : 0 };
      }),
    };
  });

  app.get('/stats/me', { preHandler: ctx.auth }, async (req) => {
    const month = monthStart(ctx.now(), config.TIME_ZONE);
    const [s] = await sql<
      {
        places_added: number;
        ratings: number;
        average_given: number | null;
        comments: number;
        saved: number;
        stars_total: number;
        stars_month: number;
      }[]
    >`
      select
        (select count(*)::int from places where added_by = ${req.user.id}) as places_added,
        (select count(*)::int from ratings where user_id = ${req.user.id}) as ratings,
        (select avg(overall)::numeric(3, 2) from ratings where user_id = ${req.user.id}) as average_given,
        (select count(*)::int from comments where user_id = ${req.user.id}) as comments,
        (select count(*)::int from saved_places where user_id = ${req.user.id}) as saved,
        (select count(*)::int from stars where user_id = ${req.user.id}) as stars_total,
        (select count(*)::int from stars where user_id = ${req.user.id} and month = ${month}::date) as stars_month
    `;
    return {
      placesAdded: s!.places_added,
      ratings: s!.ratings,
      averageGiven: s!.average_given,
      comments: s!.comments,
      saved: s!.saved,
      stars: {
        givenTotal: s!.stars_total,
        givenThisMonth: s!.stars_month,
        left: await starsLeft(ctx, req.user.id, month),
      },
    };
  });
}
