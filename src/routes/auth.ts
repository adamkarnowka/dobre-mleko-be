import { z } from 'zod';
import type { App, Ctx } from '../app.js';
import type { GoogleIdentity } from '../auth.js';
import { HttpError, notAuthorized } from '../errors.js';
import { Session } from '../schemas.js';
import { loadMe } from './me.js';

export function authRoutes(app: App, ctx: Ctx) {
  const { sql, config } = ctx;

  async function signIn(identity: GoogleIdentity) {
    if (!identity.emailVerified) throw new HttpError(403, 'email_not_verified', 'Google email is not verified');
    const [allowed] = await sql`select 1 from allowed_emails where email = ${identity.email}`;
    if (!allowed) throw notAuthorized('This account is not on the list');
    const name = identity.name?.trim() || identity.email.split('@')[0]!;
    const [user] = await sql<{ id: string; status: string }[]>`
      insert into users (email, google_sub, name, avatar_url)
      values (${identity.email}, ${identity.sub}, ${name}, ${identity.picture})
      on conflict (email) do update set
        google_sub = excluded.google_sub,
        avatar_url = coalesce(users.avatar_url, excluded.avatar_url),
        last_seen_at = now()
      returning id, status
    `;
    if (user!.status !== 'active') throw notAuthorized(`This account is ${user!.status}`);
    const session = await ctx.sessions.issue(user!.id, await ctx.settings.get('sessionTtlDays'));
    const me = await loadMe(ctx, user!.id);
    return { ...session, has_profile: me.has_profile, user: me };
  }

  app.post(
    '/auth/google',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Sign in with Google',
        description:
          'Exchanges a Google ID token from Google Sign-In for a session token valid for the sessionTtlDays setting. ' +
          'The account is created on first sign-in; `has_profile` is false until onboarding is finished with ' +
          '`POST /me/profile`. 403 `not_authorized` if the email is not on the list, `email_not_verified` if ' +
          'Google has not verified it; 401 `invalid_google_token`.',
        body: z.object({ id_token: z.string().min(1) }),
        response: { 200: Session },
      },
    },
    async (req) => signIn(await ctx.verifyGoogle(req.body.id_token)),
  );

  // Local development only: sign in as any whitelisted email without Google.
  if (config.DEV_LOGIN && config.NODE_ENV !== 'production') {
    app.post(
      '/auth/dev',
      {
        schema: {
          tags: ['Auth'],
          summary: 'Sign in without Google (development only)',
          description: 'Exists only when DEV_LOGIN=true outside production. The email must still be whitelisted.',
          body: z.object({ email: z.email(), name: z.string().optional() }),
          response: { 200: Session },
        },
      },
      async (req) => {
        const email = req.body.email.toLowerCase();
        return signIn({ sub: `dev:${email}`, email, emailVerified: true, name: req.body.name ?? null, picture: null });
      },
    );
  }
}
