import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TransactionSql } from 'postgres';
import sharp from 'sharp';
import type { Sql } from './db.js';
import type { FileVariant } from './file-urls.js';

/** Detects the image type from its first bytes; the client's content-type is not trusted. */
export function sniffImageType(data: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (data.length >= 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

export const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

export const THUMB_SIZE = 400;
export const THUMB_TYPE = 'image/jpeg';

/** Dimensions (after EXIF rotation) and a 400 px JPEG thumbnail. Throws on images sharp cannot decode. */
export async function processImage(data: Buffer): Promise<{ width: number; height: number; thumb: Buffer }> {
  const image = sharp(data, { failOn: 'error' }).rotate();
  const meta = await image.metadata();
  const swap = (meta.orientation ?? 1) >= 5; // EXIF orientations 5–8 rotate by 90°
  const thumb = await image
    .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
  return { width: (swap ? meta.height : meta.width) ?? 0, height: (swap ? meta.width : meta.height) ?? 0, thumb };
}

/**
 * Content-addressed files on a volume: <dir>/<first two hex chars>/<sha256>, plus <sha256>.thumb.
 * The database keeps only the hash; identical uploads share one file.
 */
export class PhotoStore {
  constructor(readonly dir: string) {}

  path(hash: string, variant: FileVariant = 'full'): string {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('invalid hash');
    return join(this.dir, hash.slice(0, 2), variant === 'thumb' ? `${hash}.thumb` : hash);
  }

  async exists(hash: string, variant: FileVariant = 'full'): Promise<boolean> {
    return stat(this.path(hash, variant)).then(
      () => true,
      () => false,
    );
  }

  /** Writes the file unless it is already there. Atomic: readers never see a partial file. */
  async put(hash: string, data: Buffer, variant: FileVariant = 'full'): Promise<void> {
    if (await this.exists(hash, variant)) return;
    const target = this.path(hash, variant);
    await mkdir(join(this.dir, hash.slice(0, 2)), { recursive: true });
    const tmp = `${target}.${randomUUID()}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, target);
  }

  /** The stored original's image type, from its first bytes. */
  async sniff(hash: string): Promise<ReturnType<typeof sniffImageType>> {
    const file = await open(this.path(hash));
    try {
      const head = Buffer.alloc(12);
      const { bytesRead } = await file.read(head, 0, 12, 0);
      return sniffImageType(head.subarray(0, bytesRead));
    } finally {
      await file.close();
    }
  }

  read(hash: string, variant: FileVariant = 'full'): ReadStream {
    return createReadStream(this.path(hash, variant));
  }

  async remove(hash: string): Promise<void> {
    await rm(this.path(hash), { force: true });
    await rm(this.path(hash, 'thumb'), { force: true });
  }
}

type Tx = Sql | TransactionSql;

/** Serialises writes and deletes of one file across requests (and replicas sharing the volume). */
export async function lockHash(tx: Tx, hash: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended(${hash}, 0))`;
}

/** Is the file still used by a photo or an avatar? */
export async function fileInUse(tx: Tx, hash: string): Promise<boolean> {
  const [row] = await tx`
    select 1 from place_photos where hash = ${hash}
    union all
    select 1 from users where avatar_hash = ${hash}
    limit 1
  `;
  return !!row;
}

/** Deletes the files of hashes that nothing references any more. Call inside the deleting transaction. */
export async function releaseFiles(tx: Tx, store: PhotoStore, hashes: string[]): Promise<void> {
  for (const hash of new Set(hashes)) {
    await lockHash(tx, hash);
    if (!(await fileInUse(tx, hash))) await store.remove(hash);
  }
}

/** Removes uploads that were never attached to a rating. Returns how many were removed. */
export async function cleanupUnattached(sql: Sql, store: PhotoStore, olderThan: Date): Promise<number> {
  return sql.begin(async (tx) => {
    const gone = await tx<{ hash: string }[]>`
      delete from place_photos where place_id is null and created_at < ${olderThan} returning hash
    `;
    await releaseFiles(
      tx,
      store,
      gone.map((g) => g.hash),
    );
    return gone.length;
  });
}
