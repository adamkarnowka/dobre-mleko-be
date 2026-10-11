import { z } from 'zod';
import type { App, Ctx } from '../app.js';
import { HttpError, notFound } from '../errors.js';
import { Comment, CommentList } from '../schemas.js';
import { placeAuthor } from './places.js';

interface CommentRow {
  id: string;
  body: string;
  created_at: Date;
  user_id: string;
  user_name: string;
  avatar_url: string | null;
  rating: number | null;
  total: number;
}

const toComment = (r: CommentRow) => ({
  id: r.id,
  body: r.body,
  createdAt: r.created_at.toISOString(),
  author: { id: r.user_id, name: r.user_name, avatarUrl: r.avatar_url },
  // The author's current overall rating of the place, shown next to the comment.
  authorRating: r.rating,
});

export function commentRoutes(app: App, ctx: Ctx) {
  const { sql } = ctx;

  const select = (where: ReturnType<typeof sql>) => sql<CommentRow[]>`
    select c.id, c.body, c.created_at, u.id as user_id, u.name as user_name, u.avatar_url, r.overall as rating,
           (count(*) over ())::int as total
    from comments c
    join users u on u.id = c.user_id
    left join ratings r on r.user_id = c.user_id and r.place_id = c.place_id
    where ${where}
  `;

  app.get(
    '/places/:id/comments',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Comments'],
        summary: 'Comments on a place',
        description: 'Newest first. Each carries the author’s current overall rating of the place.',
        response: { 200: CommentList },
        params: z.object({ id: z.uuid() }),
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(100).default(20),
          offset: z.coerce.number().int().min(0).default(0),
        }),
      },
    },
    async (req) => {
      await placeAuthor(ctx, req.params.id);
      const rows = await sql<CommentRow[]>`
        ${select(sql`c.place_id = ${req.params.id}`)}
        order by c.created_at desc, c.id
        limit ${req.query.limit} offset ${req.query.offset}
      `;
      return { total: rows[0]?.total ?? 0, items: rows.map(toComment) };
    },
  );

  app.post(
    '/places/:id/comments',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Comments'],
        summary: 'Add a comment',
        params: z.object({ id: z.uuid() }),
        body: z.object({ body: z.string().trim().min(1).max(2000) }),
        response: { 201: Comment },
      },
    },
    async (req, reply) => {
      await placeAuthor(ctx, req.params.id);
      const [created] = await sql<{ id: string }[]>`
        insert into comments (place_id, user_id, body) values (${req.params.id}, ${req.user.id}, ${req.body.body})
        returning id
      `;
      const [row] = await select(sql`c.id = ${created!.id}`);
      return reply.status(201).send(toComment(row!));
    },
  );

  app.delete(
    '/comments/:id',
    {
      preHandler: ctx.auth,
      schema: { tags: ['Comments'], summary: 'Delete my comment', params: z.object({ id: z.uuid() }) },
    },
    async (req, reply) => {
      const [comment] = await sql<{ user_id: string }[]>`select user_id from comments where id = ${req.params.id}`;
      if (!comment) throw notFound('Comment');
      if (comment.user_id !== req.user.id)
        throw new HttpError(403, 'forbidden', 'You can only delete your own comments');
      await sql`delete from comments where id = ${req.params.id}`;
      return reply.status(204).send();
    },
  );
}
