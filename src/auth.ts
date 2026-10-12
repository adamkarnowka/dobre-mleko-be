import type { FastifyReply, FastifyRequest } from 'fastify';
import { OAuth2Client } from 'google-auth-library';
import { SignJWT, jwtVerify } from 'jose';
import type { Config } from './config.js';
import type { Sql } from './db.js';
import { HttpError, notAuthorized } from './errors.js';

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

export type GoogleVerifier = (idToken: string) => Promise<GoogleIdentity>;

export function createGoogleVerifier(clientIds: string[]): GoogleVerifier {
  const client = new OAuth2Client();
  return async (idToken) => {
    let payload;
    try {
      const ticket = await client.verifyIdToken({ idToken, audience: clientIds });
      payload = ticket.getPayload();
    } catch {
      throw new HttpError(401, 'invalid_google_token', 'Google ID token is invalid or expired');
    }
    if (!payload?.sub || !payload.email) {
      throw new HttpError(401, 'invalid_google_token', 'Google ID token has no email');
    }
    return {
      sub: payload.sub,
      email: payload.email.toLowerCase(),
      emailVerified: payload.email_verified === true,
      name: payload.name ?? null,
      picture: payload.picture ?? null,
    };
  };
}

export class Sessions {
  private readonly key: Uint8Array;

  constructor(config: Pick<Config, 'JWT_SECRET'>) {
    this.key = new TextEncoder().encode(config.JWT_SECRET);
  }

  async issue(userId: string, ttlDays: number): Promise<{ token: string; expires_at: string }> {
    const exp = Math.floor(Date.now() / 1000) + ttlDays * 86400;
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime(exp)
      .sign(this.key);
    return { token, expires_at: new Date(exp * 1000).toISOString() };
  }

  async verify(token: string): Promise<string | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, { algorithms: ['HS256'] });
      return payload.sub ?? null;
    } catch {
      return null;
    }
  }
}

export type Role = 'member' | 'admin';

export interface CurrentUser {
  id: string;
  email: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: CurrentUser;
  }
}

/**
 * preHandler for authenticated routes. Checks the session token and, on every request, that the account is
 * still on the whitelist and what its role is, so removing someone or changing their role applies immediately.
 */
export function requireUser(deps: { sessions: Sessions; sql: Sql }) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    const userId = token ? await deps.sessions.verify(token) : null;
    if (!userId) throw new HttpError(401, 'not_authenticated', 'Sign in required');
    const [user] = await deps.sql<{ id: string; email: string; role: Role | null; status: string }[]>`
      select u.id, u.email, a.role, u.status
      from users u left join allowed_emails a on a.email = u.email
      where u.id = ${userId}
    `;
    if (!user) throw new HttpError(401, 'not_authenticated', 'Sign in required');
    if (!user.role) throw notAuthorized('This account is not on the list');
    if (user.status !== 'active') throw notAuthorized(`This account is ${user.status}`);
    req.user = { id: user.id, email: user.email, role: user.role };
  };
}

/** preHandler for admin routes: a signed-in, whitelisted user with the admin role. */
export function requireAdmin(requireSignedIn: ReturnType<typeof requireUser>) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    await requireSignedIn(req, reply);
    if (req.user.role !== 'admin') throw notAuthorized('Admins only');
  };
}

/** Makes sure the ADMIN_EMAILS from the environment are whitelisted admins. Run at startup. */
export async function ensureAdmins(sql: Sql, emails: string[]): Promise<void> {
  for (const email of emails) {
    await sql`
      insert into allowed_emails (email, role, note) values (${email}, 'admin', 'ADMIN_EMAILS')
      on conflict (email) do update set role = 'admin', updated_at = now()
    `;
  }
}
