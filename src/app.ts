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
import { createGoogleVerifier, requireUser, Sessions, type GoogleVerifier } from './auth.js';
import type { Config } from './config.js';
import type { Sql } from './db.js';
import { HttpError } from './errors.js';
import { PhotoStore } from './photo-store.js';
import { authRoutes } from './routes/auth.js';
import { commentRoutes } from './routes/comments.js';
import { meRoutes } from './routes/me.js';
import { metaRoutes } from './routes/meta.js';
import { photoRoutes } from './routes/photos.js';
import { placeRoutes } from './routes/places.js';
import { ratingRoutes } from './routes/ratings.js';
import { statsRoutes } from './routes/stats.js';
import { ErrorBody } from './schemas.js';

export interface AppDeps {
  config: Config;
  sql: Sql;
  verifyGoogle?: GoogleVerifier;
  now?: () => Date;
  logger?: boolean;
}

export interface Ctx {
  config: Config;
  sql: Sql;
  sessions: Sessions;
  verifyGoogle: GoogleVerifier;
  allowed: Set<string>;
  auth: preHandlerHookHandler;
  photos: PhotoStore;
  now: () => Date;
}

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
  await app.register(multipart, { limits: { fileSize: config.MAX_PHOTO_BYTES, files: 1 } });
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Dobre Mleko API',
        version: '1',
        description: [
          'Place ratings for friends only. Only Google accounts on the server whitelist can sign in.',
          '',
          '**Signing in:** the app signs in with Google, sends the Google ID token to `POST /auth/google` and gets a',
          'session token back. Send it on every other request as `Authorization: Bearer <token>`.',
          '',
          '**Errors** look like `{"error": {"code": "not_whitelisted", "message": "..."}}`.',
        ].join('\n'),
      },
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    const e = err as { validation?: unknown; statusCode?: number; code?: string; message: string };
    if (e.validation) {
      return reply.status(400).send({ error: { code: 'invalid_request', message: e.message } });
    }
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: { code: e.code ?? 'bad_request', message: e.message } });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'internal', message: 'Something went wrong' } });
  });
  app.setNotFoundHandler((_req, reply) =>
    reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } }),
  );

  const sessions = new Sessions(config);
  const allowed = new Set(config.ALLOWED_EMAILS);
  const ctx: Ctx = {
    config,
    sql,
    sessions,
    allowed,
    verifyGoogle: deps.verifyGoogle ?? createGoogleVerifier(config.GOOGLE_CLIENT_IDS),
    auth: requireUser({ sessions, sql, allowed }),
    photos: new PhotoStore(config.PHOTO_DIR),
    now: deps.now ?? (() => new Date()),
  };

  // Every documented route shares the error shape; signed-in routes are marked as needing the bearer token.
  app.addHook('onRoute', (route) => {
    if (!route.schema || route.schema.hide) return;
    const schema = route.schema as Record<string, unknown>;
    schema.response = { ...(schema.response as object), '4xx': ErrorBody };
    schema.security = route.preHandler === ctx.auth ? [{ bearerAuth: [] }] : [];
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
  ]) {
    routes(app, ctx);
  }

  return app;
}
