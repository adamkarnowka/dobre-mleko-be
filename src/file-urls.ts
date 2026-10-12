import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export type FileVariant = 'full' | 'thumb';

/** Signed URLs stay valid 12–24 h and are identical within a 12 h window, so clients can cache images. */
const WINDOW_S = 12 * 3600;

/**
 * Photos and avatars are private: their URLs carry an expiry and an HMAC signature, handed out only to signed-in
 * members. Image components can load them without headers.
 */
export class FileUrls {
  private readonly key: Buffer;

  constructor(
    secret: string,
    private readonly now: () => Date,
  ) {
    this.key = createHash('sha256').update(`file-urls:${secret}`).digest();
  }

  private sign(hash: string, variant: FileVariant, exp: number): string {
    return createHmac('sha256', this.key).update(`${hash}:${variant}:${exp}`).digest('base64url');
  }

  url(hash: string, variant: FileVariant = 'full'): string {
    const exp = (Math.floor(this.now().getTime() / 1000 / WINDOW_S) + 2) * WINDOW_S;
    const path = variant === 'thumb' ? `/files/${hash}/thumb` : `/files/${hash}`;
    return `${path}?exp=${exp}&sig=${this.sign(hash, variant, exp)}`;
  }

  /** Seconds the URL is still valid for, or null when it is expired or forged. */
  verify(hash: string, variant: FileVariant, exp: number, sig: string): number | null {
    const left = exp - Math.floor(this.now().getTime() / 1000);
    if (left <= 0) return null;
    const expected = Buffer.from(this.sign(hash, variant, exp));
    const given = Buffer.from(sig);
    return given.length === expected.length && timingSafeEqual(given, expected) ? left : null;
  }
}
