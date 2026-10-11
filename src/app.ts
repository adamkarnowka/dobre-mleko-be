import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type preHandlerHookHandler,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { createGoogleVerifier, requireUser, Sessions, type GoogleVerifier } from './auth.js';
import type { Config } from './config.js';
import type { Sql } from './db.js';
import { HttpError } from './errors.js';
import { authRoutes } from './routes/auth.js';
import { commentRoutes } from './routes/comments.js';
import { meRoutes } from './routes/me.js';
import { metaRoutes } from './routes/meta.js';
import { photoRoutes } from './routes/photos.js';
import { placeRoutes } from './routes/places.js';
import { ratingRoutes } from './routes/ratings.js';
import { statsRoutes } from './routes/stats.js';

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
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } }));

  const sessions = new Sessions(config);
  const allowed = new Set(config.ALLOWED_EMAILS);
  const ctx: Ctx = {
    config,
    sql,
    sessions,
    allowed,
    verifyGoogle: deps.verifyGoogle ?? createGoogleVerifier(config.GOOGLE_CLIENT_IDS),
    auth: requireUser({ sessions, sql, allowed }),
    now: deps.now ?? (() => new Date()),
  };

  app.get('/healthz', async () => {
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
