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
        starsPerMonth: settings.starsPerMonth,
        maxPhotoBytes: settings.maxPhotoBytes,
        maxPhotosPerPlace: settings.maxPhotosPerPlace,
        timeZone: ctx.config.TIME_ZONE,
        googleWebClientId: ctx.config.GOOGLE_WEB_CLIENT_ID || null,
        devLogin: ctx.config.DEV_LOGIN && ctx.config.NODE_ENV !== 'production',
      };
    },
  );
}
