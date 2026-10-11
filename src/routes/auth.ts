import { z } from 'zod';
import type { App, Ctx } from '../app.js';
import type { GoogleIdentity } from '../auth.js';
import { HttpError } from '../errors.js';
import { loadProfile } from './me.js';

export function authRoutes(app: App, ctx: Ctx) {
  const { sql, config } = ctx;

  async function signIn(identity: GoogleIdentity) {
    if (!identity.emailVerified) throw new HttpError(403, 'email_not_verified', 'Google email is not verified');
    if (!ctx.allowed.has(identity.email)) {
      throw new HttpError(403, 'not_whitelisted', 'This account is not on the list');
    }
    const name = identity.name?.trim() || identity.email.split('@')[0]!;
    const [user] = await sql<{ id: string }[]>`
      insert into users (email, google_sub, name, avatar_url)
      values (${identity.email}, ${identity.sub}, ${name}, ${identity.picture})
      on conflict (email) do update set
        google_sub = excluded.google_sub,
        avatar_url = coalesce(users.avatar_url, excluded.avatar_url),
        last_seen_at = now()
      returning id
    `;
    const session = await ctx.sessions.issue(user!.id);
    return { ...session, user: await loadProfile(ctx, user!.id) };
  }

  app.post(
    '/auth/google',
    { schema: { body: z.object({ idToken: z.string().min(1) }) } },
    async (req) => signIn(await ctx.verifyGoogle(req.body.idToken)),
  );

  // Local development only: sign in as any whitelisted email without Google.
  if (config.DEV_LOGIN && config.NODE_ENV !== 'production') {
    app.post(
      '/auth/dev',
      { schema: { body: z.object({ email: z.email(), name: z.string().optional() }) } },
      async (req) => {
        const email = req.body.email.toLowerCase();
        return signIn({ sub: `dev:${email}`, email, emailVerified: true, name: req.body.name ?? null, picture: null });
      },
    );
  }
}
