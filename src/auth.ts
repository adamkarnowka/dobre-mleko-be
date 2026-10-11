import type { FastifyReply, FastifyRequest } from 'fastify';
import { OAuth2Client } from 'google-auth-library';
import { SignJWT, jwtVerify } from 'jose';
import type { Config } from './config.js';
import type { Sql } from './db.js';
import { HttpError } from './errors.js';

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

  constructor(private readonly config: Pick<Config, 'JWT_SECRET' | 'SESSION_TTL_DAYS'>) {
    this.key = new TextEncoder().encode(config.JWT_SECRET);
  }

  async issue(userId: string): Promise<{ token: string; expiresAt: string }> {
    const exp = Math.floor(Date.now() / 1000) + this.config.SESSION_TTL_DAYS * 86400;
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime(exp)
      .sign(this.key);
    return { token, expiresAt: new Date(exp * 1000).toISOString() };
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

export interface CurrentUser {
  id: string;
  email: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: CurrentUser;
  }
}

/**
 * preHandler for authenticated routes. Checks the session token and that the account is still on the
 * whitelist, so removing an email from ALLOWED_EMAILS cuts access immediately.
 */
export function requireUser(deps: { sessions: Sessions; sql: Sql; allowed: Set<string> }) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    const userId = token ? await deps.sessions.verify(token) : null;
    if (!userId) throw new HttpError(401, 'unauthorized', 'Sign in required');
    const [user] = await deps.sql<CurrentUser[]>`select id, email from users where id = ${userId}`;
    if (!user) throw new HttpError(401, 'unauthorized', 'Sign in required');
    if (!deps.allowed.has(user.email)) throw new HttpError(403, 'not_whitelisted', 'This account is not on the list');
    req.user = user;
  };
}
