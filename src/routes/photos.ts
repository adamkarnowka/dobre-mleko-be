import { z } from 'zod';
import type { App, Ctx } from '../app.js';
import { HttpError, notFound } from '../errors.js';
import { placeAuthor } from './places.js';

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_PHOTOS_PER_PLACE = 12;

export function photoRoutes(app: App, ctx: Ctx) {
  const { sql } = ctx;

  // multipart/form-data with a single file field. Clients should resize before upload (≈1600 px is plenty).
  app.post(
    '/places/:id/photos',
    { preHandler: ctx.auth, schema: { params: z.object({ id: z.uuid() }) } },
    async (req, reply) => {
      await placeAuthor(ctx, req.params.id);
      const file = await req.file();
      if (!file) throw new HttpError(400, 'invalid_request', 'Expected a file');
      if (!ALLOWED_TYPES.has(file.mimetype)) {
        throw new HttpError(415, 'unsupported_type', 'Photos must be JPEG, PNG or WebP');
      }
      const data = await file.toBuffer();
      if (file.file.truncated) throw new HttpError(413, 'too_large', 'Photo is too large');

      const [{ n }] = await sql<[{ n: number }]>`
        select count(*)::int as n from place_photos where place_id = ${req.params.id}
      `;
      if (n >= MAX_PHOTOS_PER_PLACE) {
        throw new HttpError(409, 'too_many_photos', `A place can have at most ${MAX_PHOTOS_PER_PLACE} photos`);
      }

      const [photo] = await sql<{ id: string }[]>`
        insert into place_photos (place_id, uploaded_by, content_type, data)
        values (${req.params.id}, ${req.user.id}, ${file.mimetype}, ${data})
        returning id
      `;
      return reply.status(201).send({ id: photo!.id, url: `/photos/${photo!.id}` });
    },
  );

  // Public so image components can load it without headers; ids are random UUIDs.
  app.get('/photos/:id', { schema: { params: z.object({ id: z.uuid() }) } }, async (req, reply) => {
    const [photo] = await sql<{ content_type: string; data: Buffer }[]>`
      select content_type, data from place_photos where id = ${req.params.id}
    `;
    if (!photo) throw notFound('Photo');
    return reply
      .header('content-type', photo.content_type)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(photo.data);
  });

  app.delete(
    '/photos/:id',
    { preHandler: ctx.auth, schema: { params: z.object({ id: z.uuid() }) } },
    async (req, reply) => {
      const [photo] = await sql<{ uploaded_by: string; added_by: string }[]>`
        select ph.uploaded_by, p.added_by from place_photos ph join places p on p.id = ph.place_id where ph.id = ${req.params.id}
      `;
      if (!photo) throw notFound('Photo');
      if (photo.uploaded_by !== req.user.id && photo.added_by !== req.user.id) {
        throw new HttpError(403, 'forbidden', 'Only the uploader or the place author can delete this photo');
      }
      await sql`delete from place_photos where id = ${req.params.id}`;
      return reply.status(204).send();
    },
  );
}
