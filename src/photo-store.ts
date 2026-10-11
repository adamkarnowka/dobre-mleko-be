import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TransactionSql } from 'postgres';
import type { Sql } from './db.js';

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

/**
 * Content-addressed files on a volume: <dir>/<first two hex chars>/<sha256>.
 * The database keeps only the hash; identical uploads share one file.
 */
export class PhotoStore {
  constructor(readonly dir: string) {}

  path(hash: string): string {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('invalid hash');
    return join(this.dir, hash.slice(0, 2), hash);
  }

  async exists(hash: string): Promise<boolean> {
    return stat(this.path(hash)).then(
      () => true,
      () => false,
    );
  }

  /** Writes the file unless it is already there. Atomic: readers never see a partial file. */
  async put(hash: string, data: Buffer): Promise<void> {
    if (await this.exists(hash)) return;
    const target = this.path(hash);
    await mkdir(join(this.dir, hash.slice(0, 2)), { recursive: true });
    const tmp = `${target}.${randomUUID()}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, target);
  }

  read(hash: string): ReadStream {
    return createReadStream(this.path(hash));
  }

  async remove(hash: string): Promise<void> {
    await rm(this.path(hash), { force: true });
  }
}

type Tx = Sql | TransactionSql;

/** Serialises writes and deletes of one file across requests (and replicas sharing the volume). */
export async function lockHash(tx: Tx, hash: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended(${hash}, 0))`;
}

/** Deletes the files of hashes that no photo row references any more. Call inside the deleting transaction. */
export async function releaseFiles(tx: Tx, store: PhotoStore, hashes: string[]): Promise<void> {
  for (const hash of new Set(hashes)) {
    await lockHash(tx, hash);
    const [inUse] = await tx`select 1 from place_photos where hash = ${hash} limit 1`;
    if (!inUse) await store.remove(hash);
  }
}
