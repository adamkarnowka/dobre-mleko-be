import type { App, Ctx } from '../app.js';
import { CATEGORIES, CRITERIA } from '../domain.js';
import { Meta } from '../schemas.js';

export function metaRoutes(app: App, ctx: Ctx) {
  app.get(
    '/meta',
    {
      schema: {
        tags: ['Meta'],
        summary: 'Categories, rating criteria and limits',
        response: { 200: Meta },
      },
    },
    async () => ({
      categories: [...CATEGORIES],
      criteria: CRITERIA.map((c) => ({ ...c })),
      starsPerMonth: ctx.config.STARS_PER_MONTH,
      timeZone: ctx.config.TIME_ZONE,
    }),
  );
}
