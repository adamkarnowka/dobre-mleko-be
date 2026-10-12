import type { FastifyRequest } from 'fastify';
import type { Ctx } from './app.js';
import { HttpError, invalidInput } from './errors.js';
import { processImage, sha256, sniffImageType } from './photo-store.js';

export interface ImageUpload {
  hash: string;
  contentType: string;
  size: number;
  width: number;
  height: number;
  thumb: Buffer;
  data: Buffer;
  blurhash: string | null;
}

const BLURHASH = /^[0-9A-Za-z#$%*+,\-.:;=?@[\]^_{|}~]{6,100}$/;

/**
 * Reads a multipart upload: one file (JPEG, PNG or WebP, detected from its bytes) and an optional `blurhash`
 * field, in any order. Makes the 400 px thumbnail.
 */
export async function readImageUpload(req: FastifyRequest, ctx: Ctx): Promise<ImageUpload> {
  const maxBytes = await ctx.settings.get('maxPhotoBytes');
  let data: Buffer | null = null;
  let blurhash: string | null = null;
  for await (const part of req.parts({ limits: { fileSize: maxBytes, files: 1 } })) {
    if (part.type === 'file') data = await part.toBuffer();
    else if (part.fieldname === 'blurhash' && typeof part.value === 'string' && part.value) blurhash = part.value;
  }
  if (!data) throw invalidInput('Expected an image file');
  if (blurhash && !BLURHASH.test(blurhash)) throw invalidInput('Invalid blurhash');
  const contentType = sniffImageType(data);
  if (!contentType) throw new HttpError(415, 'unsupported_type', 'Photos must be JPEG, PNG or WebP');
  let image;
  try {
    image = await processImage(data);
  } catch {
    throw invalidInput('The image could not be read');
  }
  return { hash: sha256(data), contentType, size: data.length, data, blurhash, ...image };
}

/** Stores an upload's file and thumbnail (no-op for files already there). Call under lockHash. */
export async function storeImage(ctx: Ctx, upload: ImageUpload): Promise<void> {
  await ctx.photos.put(upload.hash, upload.data);
  await ctx.photos.put(upload.hash, upload.thumb, 'thumb');
}
