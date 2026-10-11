import { z } from 'zod';

const csv = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(/[,\s]+/)
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean),
  );

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().default(8080),
  DATABASE_URL: z.string().min(1),
  // Comma- or whitespace-separated list of Google account emails allowed to sign in.
  ALLOWED_EMAILS: csv,
  // OAuth client IDs (web, iOS, Android) whose Google ID tokens we accept.
  GOOGLE_CLIENT_IDS: csv,
  // Secret for signing our own session tokens. At least 32 characters.
  JWT_SECRET: z.string().min(32),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  // Enables POST /auth/dev for local development. Never honoured in production.
  DEV_LOGIN: z
    .string()
    .default('false')
    .transform((s) => s === 'true' || s === '1'),
  TIME_ZONE: z.string().default('Europe/Warsaw'),
  STARS_PER_MONTH: z.coerce.number().int().positive().default(3),
  MAX_PHOTO_BYTES: z.coerce.number().int().positive().default(8 * 1024 * 1024),
  CORS_ORIGINS: csv,
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}
