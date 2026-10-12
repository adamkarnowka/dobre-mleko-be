import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type preHandlerHookHandler,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from 'fastify';
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { createGoogleVerifier, requireAdmin, requireUser, Sessions, type GoogleVerifier } from './auth.js';
import type { Config } from './config.js';
import type { Sql } from './db.js';
import { HttpError } from './errors.js';
import { FileUrls } from './file-urls.js';
import { PhotoStore } from './photo-store.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { categoryRoutes } from './routes/categories.js';
import { commentRoutes } from './routes/comments.js';
import { meRoutes } from './routes/me.js';
import { metaRoutes } from './routes/meta.js';
import { photoRoutes } from './routes/photos.js';
import { placeRoutes } from './routes/places.js';
import { ratingRoutes } from './routes/ratings.js';
import { statsRoutes } from './routes/stats.js';
import { ErrorBody } from './schemas.js';
import { PHOTO_BYTES_CEILING, Settings } from './settings.js';

export interface AppDeps {
  config: Config;
  sql: Sql;
  verifyGoogle?: GoogleVerifier;
  now?: () => Date;
  logger?: boolean;
  /** How long settings are cached (default 10 s). */
  settingsCacheMs?: number;
}

export interface Ctx {
  config: Config;
  sql: Sql;
  sessions: Sessions;
  verifyGoogle: GoogleVerifier;
  /** Signed-in and whitelisted. */
  auth: preHandlerHookHandler;
  /** Signed-in, whitelisted admin. */
  admin: preHandlerHookHandler;
  settings: Settings;
  photos: PhotoStore;
  /** Signs photo and avatar URLs. */
  urls: FileUrls;
  now: () => Date;
}

/** What place and profile mappers need to render a response. */
export const view = (ctx: Ctx) => ({ timeZone: ctx.config.TIME_ZONE, now: ctx.now(), urls: ctx.urls });

export type App = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export async function buildApp(deps: AppDeps) {
  const { config, sql } = deps;
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 1024 * 1024 }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cors, { origin: config.CORS_ORIGINS.length ? config.CORS_ORIGINS : false });
  // The effective size limit is the maxPhotoBytes setting, applied per upload.
  await app.register(multipart, { limits: { fileSize: PHOTO_BYTES_CEILING, files: 1 } });
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Dobre Mleko API',
        version: '1',
        description: [
          'Place ratings for friends only. Only Google accounts on the server whitelist can sign in.',
          '',
          '**Signing in:** the app signs in with Google, sends the Google ID token to `POST /auth/google` and gets a',
          'session token back. Send it on every other request as `Authorization: Bearer <token>`. When',
          '`has_profile` is false, the app shows onboarding and finishes it with `POST /me/profile`.',
          '',
          '**Conventions:** JSON in snake_case, dates in ISO 8601 (UTC), ids are UUID strings. Lists are paginated',
          "with `limit` and `cursor`; pass the response's `next_cursor` to get the next page.",
          '',
          '**Errors** look like `{"error": "not_authorized", "message": "..."}`. Codes: `not_authenticated` (401,',
          'sign in again), `not_authorized` (403), `not_found` (404), `invalid_input` (422), `no_gold_stars_left`,',
          '`gold_star_already_awarded`, `rating_needs_photo` and other conflicts (409).',
          '',
          '**Photos** are private: their URLs are signed and expire after 12–24 h, so always use the URLs from the',
          'latest response.',
        ].join('\n'),
      },
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message, ...err.extra });
    }
    const e = err as { validation?: unknown; statusCode?: number; code?: string; message: string };
    if (e.validation) return reply.status(422).send({ error: 'invalid_input', message: e.message });
    if (e.code === 'FST_REQ_FILE_TOO_LARGE')
      return reply.status(413).send({ error: 'file_too_large', message: e.message });
    if (e.statusCode && e.statusCode < 500) {
      const code = e.statusCode === 400 || e.statusCode === 415 ? 'invalid_input' : 'bad_request';
      return reply.status(e.statusCode).send({ error: code, message: e.message });
    }
    req.log.error(err);
    return reply.status(500).send({ error: 'internal', message: 'Something went wrong' });
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: 'not_found', message: 'Not found' }));

  const sessions = new Sessions(config);
  const auth = requireUser({ sessions, sql });
  const now = deps.now ?? (() => new Date());
  const ctx: Ctx = {
    config,
    sql,
    sessions,
    verifyGoogle:
      deps.verifyGoogle ??
      createGoogleVerifier([...config.GOOGLE_CLIENT_IDS, config.GOOGLE_WEB_CLIENT_ID].filter(Boolean)),
    auth,
    admin: requireAdmin(auth),
    settings: new Settings(sql, deps.settingsCacheMs),
    photos: new PhotoStore(config.PHOTO_DIR),
    urls: new FileUrls(config.JWT_SECRET, now),
    now,
  };

  // Every documented route shares the error shape; signed-in routes are marked as needing the bearer token.
  app.addHook('onRoute', (route) => {
    if (!route.schema || route.schema.hide) return;
    const schema = route.schema as Record<string, unknown>;
    schema.response = { ...(schema.response as object), '4xx': ErrorBody };
    schema.security = route.preHandler === ctx.auth || route.preHandler === ctx.admin ? [{ bearerAuth: [] }] : [];
  });

  app.get('/healthz', { schema: { hide: true } }, async () => {
    await sql`select 1`;
    return { ok: true };
  });

  for (const routes of [
    metaRoutes,
    authRoutes,
    meRoutes,
    placeRoutes,
    ratingRoutes,
    commentRoutes,
    photoRoutes,
    statsRoutes,
    adminRoutes,
    categoryRoutes,
  ]) {
    routes(app, ctx);
  }

  return app;
}
