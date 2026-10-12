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
    async () => {
      const settings = await ctx.settings.all();
      return {
        categories: [...CATEGORIES],
        criteria: CRITERIA.map((c) => ({ ...c })),
        gold_stars_per_month: settings.starsPerMonth,
        max_photo_bytes: settings.maxPhotoBytes,
        max_photos_per_rating: settings.maxPhotosPerRating,
        time_zone: ctx.config.TIME_ZONE,
        google_web_client_id: ctx.config.GOOGLE_WEB_CLIENT_ID || null,
        dev_login: ctx.config.DEV_LOGIN && ctx.config.NODE_ENV !== 'production',
      };
    },
  );
}
