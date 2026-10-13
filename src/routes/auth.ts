import { z } from 'zod';
import type { App, Ctx } from '../app.js';
import type { AppleIdentity, GoogleIdentity } from '../auth.js';
import { HttpError, notAuthorized } from '../errors.js';
import { Session } from '../schemas.js';
import { loadMe } from './me.js';

export function authRoutes(app: App, ctx: Ctx) {
  const { sql, config } = ctx;

  /** A session for an active account. */
  async function startSession(user: { id: string; status: string }) {
    if (user.status !== 'active') throw notAuthorized(`This account is ${user.status}`);
    const session = await ctx.sessions.issue(user.id, await ctx.settings.get('sessionTtlDays'));
    const me = await loadMe(ctx, user.id);
    return { ...session, has_profile: me.has_profile, user: me };
  }

  async function requireAllowed(email: string) {
    const [allowed] = await sql`select 1 from allowed_emails where email = ${email}`;
    if (!allowed) throw notAuthorized('This account is not on the list');
  }

  async function signIn(identity: GoogleIdentity) {
    if (!identity.emailVerified) throw new HttpError(403, 'email_not_verified', 'Google email is not verified');
    await requireAllowed(identity.email);
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
    return startSession(user!);
  }

  async function signInWithApple(identity: AppleIdentity, givenName: string | null) {
    if (!identity.email) {
      // Signed in before without sharing the e-mail in this token: the account is known by its Apple id.
      const [user] = await sql<{ id: string; status: string; email: string }[]>`
        update users set last_seen_at = now() where apple_sub = ${identity.sub} returning id, status, email
      `;
      if (!user) throw notAuthorized('This account is not on the list');
      await requireAllowed(user.email);
      return startSession(user);
    }
    if (!identity.emailVerified) throw new HttpError(403, 'email_not_verified', 'Apple email is not verified');
    const [allowed] = await sql`select 1 from allowed_emails where email = ${identity.email}`;
    if (!allowed) {
      if (identity.privateEmail) {
        throw new HttpError(
          403,
          'private_email',
          'Hide My Email address is not on the list; sign in again sharing the real e-mail',
        );
      }
      throw notAuthorized('This account is not on the list');
    }
    const name = givenName?.trim() || identity.email.split('@')[0]!;
    const [user] = await sql<{ id: string; status: string }[]>`
      insert into users (email, apple_sub, name)
      values (${identity.email}, ${identity.sub}, ${name})
      on conflict (email) do update set apple_sub = excluded.apple_sub, last_seen_at = now()
      returning id, status
    `;
    return startSession(user!);
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

  app.post(
    '/auth/apple',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Sign in with Apple',
        description:
          'Exchanges a Sign in with Apple identity token (audience: the iOS bundle id, `APPLE_CLIENT_IDS`) for a ' +
          'session, like `/auth/google`; an account with the same e-mail is the same account. `name` is the name ' +
          'Apple gives the app on the first sign-in only, used for a new account. Later tokens may come without ' +
          'the e-mail; the account is then found by its Apple id. 403 `not_authorized` if the e-mail is not on ' +
          'the list, `private_email` if it is a Hide My Email address that is not (sign in again sharing the real ' +
          'e-mail); 401 `invalid_apple_token`.',
        body: z.object({ id_token: z.string().min(1), name: z.string().max(100).nullable().optional() }),
        response: { 200: Session },
      },
    },
    async (req) => signInWithApple(await ctx.verifyApple(req.body.id_token), req.body.name ?? null),
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
