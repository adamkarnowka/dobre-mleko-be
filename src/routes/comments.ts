import { z } from 'zod';
import type { App, Ctx } from '../app.js';
import { notAuthorized, notFound } from '../errors.js';
import { decodeCursor, page, pagingQuery } from '../paging.js';
import { placeAuthor, requireOwnerOrAdmin } from '../place-access.js';
import { toProfile, type ProfileJson } from '../profiles.js';
import { Comment, CommentList } from '../schemas.js';

interface CommentRow {
  id: string;
  body: string;
  created_at: Date;
  updated_at: Date | null;
  author: ProfileJson;
  author_rating: number | null;
  total: number;
}

const body = z.string().trim().min(1).max(1000);

/** Comments with their authors, oldest first. */
export async function selectComments(
  ctx: Ctx,
  where: { placeId?: string; commentId?: string },
  limit = 1000,
  offset = 0,
): Promise<CommentRow[]> {
  const { sql } = ctx;
  return sql<CommentRow[]>`
    select c.id, c.body, c.created_at, c.updated_at, profile_json(u) as author, r.overall as author_rating,
           (count(*) over ())::int as total
    from comments c
    join users u on u.id = c.user_id
    left join ratings r on r.user_id = c.user_id and r.place_id = c.place_id
    where ${where.commentId ? sql`c.id = ${where.commentId}` : sql`c.place_id = ${where.placeId!}`}
    order by c.created_at, c.id
    limit ${limit} offset ${offset}
  `;
}

export const toComment = (ctx: Ctx, r: CommentRow, userId: string) => ({
  id: r.id,
  body: r.body,
  author: toProfile(r.author, ctx.urls),
  author_rating: r.author_rating,
  is_mine: r.author.id === userId,
  created_at: r.created_at.toISOString(),
  updated_at: r.updated_at?.toISOString() ?? null,
});

export function commentRoutes(app: App, ctx: Ctx) {
  const { sql } = ctx;
  const idParams = z.object({ id: z.uuid() });

  async function loadComment(id: string, userId: string) {
    const [row] = await selectComments(ctx, { commentId: id });
    if (!row) throw notFound('Comment');
    return toComment(ctx, row, userId);
  }

  async function commentAuthor(id: string): Promise<string> {
    const [c] = await sql<{ user_id: string }[]>`select user_id from comments where id = ${id}`;
    if (!c) throw notFound('Comment');
    return c.user_id;
  }

  app.get(
    '/places/:id/comments',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Comments'],
        summary: 'Comments on a place',
        description: 'Oldest first. `GET /places/{id}` already includes all of them; this pages through them.',
        params: idParams,
        querystring: z.object({ ...pagingQuery() }),
        response: { 200: CommentList },
      },
    },
    async (req) => {
      await placeAuthor(ctx, req.params.id);
      const offset = decodeCursor(req.query.cursor);
      const rows = await selectComments(ctx, { placeId: req.params.id }, req.query.limit, offset);
      return page(
        rows.map((r) => toComment(ctx, r, req.user.id)),
        offset,
        rows[0]?.total ?? 0,
      );
    },
  );

  app.post(
    '/places/:id/comments',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Comments'],
        summary: 'Add a comment',
        description: '1–1000 characters after trimming.',
        params: idParams,
        body: z.object({ body }),
        response: { 201: Comment },
      },
    },
    async (req, reply) => {
      await placeAuthor(ctx, req.params.id);
      const [created] = await sql<{ id: string }[]>`
        insert into comments (place_id, user_id, body) values (${req.params.id}, ${req.user.id}, ${req.body.body})
        returning id
      `;
      return reply.status(201).send(await loadComment(created!.id, req.user.id));
    },
  );

  app.patch(
    '/comments/:id',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Comments'],
        summary: 'Edit my comment',
        params: idParams,
        body: z.object({ body }),
        response: { 200: Comment },
      },
    },
    async (req) => {
      if ((await commentAuthor(req.params.id)) !== req.user.id) {
        throw notAuthorized('Only the author can edit a comment');
      }
      await sql`update comments set body = ${req.body.body}, updated_at = now() where id = ${req.params.id}`;
      return loadComment(req.params.id, req.user.id);
    },
  );

  app.delete(
    '/comments/:id',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Comments'],
        summary: 'Delete a comment',
        description: 'The author or an admin.',
        params: idParams,
      },
    },
    async (req, reply) => {
      requireOwnerOrAdmin(req.user, await commentAuthor(req.params.id), 'delete this comment');
      await sql`delete from comments where id = ${req.params.id}`;
      return reply.status(204).send();
    },
  );
}
