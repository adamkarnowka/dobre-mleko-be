import { z } from 'zod';
import type { App, Ctx } from '../app.js';
import { HttpError, notFound } from '../errors.js';
import { lockHash, releaseFiles, sha256, sniffImageType } from '../photo-store.js';
import { Photo } from '../schemas.js';
import { placeAuthor } from './places.js';

const MAX_PHOTOS_PER_PLACE = 12;

export function photoRoutes(app: App, ctx: Ctx) {
  const { sql } = ctx;

  app.post(
    '/places/:id/photos',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Photos'],
        summary: 'Upload a photo',
        description:
          'multipart/form-data with one file field: JPEG, PNG or WebP (detected from the file itself), up to ' +
          `${Math.round(ctx.config.MAX_PHOTO_BYTES / 1024 / 1024)} MB, at most ${MAX_PHOTOS_PER_PLACE} per place. ` +
          'The first photo is the cover. Resize on the phone first (about 1600 px is plenty). ' +
          'Uploading the same file to the same place again returns the existing photo (200).',
        consumes: ['multipart/form-data'],
        params: z.object({ id: z.uuid() }),
        response: { 200: Photo, 201: Photo },
      },
    },
    async (req, reply) => {
      await placeAuthor(ctx, req.params.id);
      const file = await req.file();
      if (!file) throw new HttpError(400, 'invalid_request', 'Expected a file');
      const data = await file.toBuffer();
      const contentType = sniffImageType(data);
      if (!contentType) throw new HttpError(415, 'unsupported_type', 'Photos must be JPEG, PNG or WebP');
      const hash = sha256(data);

      const result = await sql.begin(async (tx) => {
        const [existing] = await tx<{ id: string }[]>`
          select id from place_photos where place_id = ${req.params.id} and hash = ${hash}
        `;
        if (existing) return { status: 200 as const, id: existing.id };
        const [{ n }] = await tx<[{ n: number }]>`
          select count(*)::int as n from place_photos where place_id = ${req.params.id}
        `;
        if (n >= MAX_PHOTOS_PER_PLACE) {
          throw new HttpError(409, 'too_many_photos', `A place can have at most ${MAX_PHOTOS_PER_PLACE} photos`);
        }
        await lockHash(tx, hash);
        await ctx.photos.put(hash, data);
        const [photo] = await tx<{ id: string }[]>`
          insert into place_photos (place_id, uploaded_by, hash, content_type, size_bytes)
          values (${req.params.id}, ${req.user.id}, ${hash}, ${contentType}, ${data.length})
          on conflict (place_id, hash) do update set hash = excluded.hash
          returning id
        `;
        return { status: 201 as const, id: photo!.id };
      });
      return reply.status(result.status).send({ id: result.id, url: `/photos/${hash}` });
    },
  );

  // Public so image components can load it without headers. Only files referenced by a photo are served.
  app.get(
    '/photos/:hash',
    {
      schema: {
        tags: ['Photos'],
        summary: 'Photo file',
        description: 'The image itself. URLs are content hashes, so responses are cached forever.',
        params: z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/) }),
      },
    },
    async (req, reply) => {
      const { hash } = req.params;
      const [photo] = await sql<{ content_type: string }[]>`
        select content_type from place_photos where hash = ${hash} limit 1
      `;
      if (!photo || !(await ctx.photos.exists(hash))) throw notFound('Photo');
      return reply
        .header('content-type', photo.content_type)
        .header('cache-control', 'public, max-age=31536000, immutable')
        .header('etag', `"${hash}"`)
        .send(ctx.photos.read(hash));
    },
  );

  app.delete(
    '/places/:id/photos/:photoId',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Photos'],
        summary: 'Delete a photo',
        description: 'Allowed for the uploader and the person who added the place.',
        params: z.object({ id: z.uuid(), photoId: z.uuid() }),
      },
    },
    async (req, reply) => {
      const [photo] = await sql<{ uploaded_by: string; added_by: string; hash: string }[]>`
        select ph.uploaded_by, p.added_by, ph.hash
        from place_photos ph join places p on p.id = ph.place_id
        where ph.id = ${req.params.photoId} and ph.place_id = ${req.params.id}
      `;
      if (!photo) throw notFound('Photo');
      if (photo.uploaded_by !== req.user.id && photo.added_by !== req.user.id) {
        throw new HttpError(403, 'forbidden', 'Only the uploader or the place author can delete this photo');
      }
      await sql.begin(async (tx) => {
        await tx`delete from place_photos where id = ${req.params.photoId}`;
        await releaseFiles(tx, ctx.photos, [photo.hash]);
      });
      return reply.status(204).send();
    },
  );
}
