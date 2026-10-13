import type { Ctx } from './app.js';
import type { PushCounts } from './push.js';

/** Who an admin message goes to. */
export type Audience =
  | { kind: 'all' }
  | { kind: 'users'; user_ids: string[] }
  | { kind: 'categories'; categories: string[] };

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/**
 * A new place: to everyone who wants all new places, and to those with its category among their favourites
 * (the default) — not to its author.
 */
export function notifyNewPlace(ctx: Ctx, placeId: string, authorId: string): void {
  ctx.notifier.background(async () => {
    const [place] = await ctx.sql<{ name: string; category: string; label: string | null; author: string }[]>`
      select p.name, p.category, c.label, u.name as author
      from places p join users u on u.id = p.added_by left join categories c on c.id = p.category
      where p.id = ${placeId}
    `;
    if (!place) return;
    const rows = await ctx.sql<{ id: string }[]>`
      select id from users
      where status = 'active' and id <> ${authorId}
        and (notify_new_places = 'all'
             or (notify_new_places = 'favorites' and ${place.category} = any(favorite_categories)))
    `;
    await ctx.notifier.deliver(
      'new_place',
      rows.map((r) => r.id),
      {
        title: clip(`Nowe miejsce: ${place.name}`, 120),
        body: `${place.author} poleca · ${place.label ?? place.category}`,
        placeId,
      },
      { kind: 'new_place', category: place.category },
    );
  });
}

/**
 * A new comment: to the place's author, others who commented on it and those who saved it — not to the commenter,
 * and only to people who want comment notifications.
 */
export function notifyComment(ctx: Ctx, placeId: string, commenterId: string, body: string): void {
  ctx.notifier.background(async () => {
    const [place] = await ctx.sql<{ name: string; commenter: string }[]>`
      select p.name, (select name from users where id = ${commenterId}) as commenter from places p where p.id = ${placeId}
    `;
    if (!place) return;
    const rows = await ctx.sql<{ id: string }[]>`
      select u.id from users u
      where u.status = 'active' and u.notify_comments and u.id <> ${commenterId}
        and (u.id = (select added_by from places where id = ${placeId})
             or exists (select 1 from comments c where c.place_id = ${placeId} and c.user_id = u.id)
             or exists (select 1 from saved_places s where s.place_id = ${placeId} and s.user_id = u.id))
    `;
    await ctx.notifier.deliver(
      'new_comment',
      rows.map((r) => r.id),
      { title: clip(`${place.commenter} o: ${place.name}`, 120), body: clip(body, 160), placeId },
      { kind: 'new_comment' },
    );
  });
}

/** An admin message: to everyone, to chosen people, or to people with chosen favourite categories. */
export async function sendAdminMessage(
  ctx: Ctx,
  audience: Audience,
  message: { title: string; body: string; placeId: string | null },
  adminId: string,
): Promise<PushCounts> {
  const rows =
    audience.kind === 'all'
      ? await ctx.sql<{ id: string }[]>`select id from users where status = 'active'`
      : audience.kind === 'users'
        ? await ctx.sql<{ id: string }[]>`
            select id from users where status = 'active' and id = any(${audience.user_ids}::uuid[])
          `
        : await ctx.sql<{ id: string }[]>`
            select id from users where status = 'active' and favorite_categories && ${audience.categories}::text[]
          `;
  return ctx.notifier.deliver(
    'admin',
    rows.map((r) => r.id),
    message,
    audience,
    adminId,
  );
}
