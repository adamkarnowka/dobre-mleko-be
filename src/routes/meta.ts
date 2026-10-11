import type { App, Ctx } from '../app.js';
import { CATEGORIES, CRITERIA } from '../domain.js';

export function metaRoutes(app: App, ctx: Ctx) {
  app.get('/meta', async () => ({
    categories: CATEGORIES,
    criteria: CRITERIA,
    starsPerMonth: ctx.config.STARS_PER_MONTH,
    timeZone: ctx.config.TIME_ZONE,
  }));
}
