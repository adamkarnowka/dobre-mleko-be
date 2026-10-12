import type { CurrentUser } from './auth.js';
import type { Ctx } from './app.js';
import { notAuthorized, notFound } from './errors.js';

/** Ensures the place exists and returns who added it. */
export async function placeAuthor(ctx: Ctx, placeId: string): Promise<string> {
  const [place] = await ctx.sql<{ added_by: string }[]>`select added_by from places where id = ${placeId}`;
  if (!place) throw notFound('Place');
  return place.added_by;
}

/** Authors manage their own things; admins manage everything. */
export function requireOwnerOrAdmin(user: CurrentUser, ownerId: string, what: string): void {
  if (user.id !== ownerId && user.role !== 'admin') throw notAuthorized(`Only the author or an admin can ${what}`);
}
