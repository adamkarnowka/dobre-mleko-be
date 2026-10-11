import { z } from 'zod';
import type { Sql } from './db.js';
import { HttpError } from './errors.js';

/** Settings admins can change at runtime. Secrets and infrastructure stay in environment variables. */
export const SETTINGS = {
  starsPerMonth: {
    label: 'Złote gwiazdki na miesiąc',
    description: 'Ile złotych gwiazdek każdy może przyznać w miesiącu kalendarzowym.',
    schema: z.number().int().min(0).max(31),
    default: 3,
  },
  sessionTtlDays: {
    label: 'Ważność logowania (dni)',
    description: 'Po ilu dniach aplikacja musi ponownie zalogować się przez Google. Dotyczy nowych logowań.',
    schema: z.number().int().min(1).max(365),
    default: 30,
  },
  maxPhotoBytes: {
    label: 'Maks. rozmiar zdjęcia (bajty)',
    description: 'Największe zdjęcie, jakie można wgrać.',
    schema: z
      .number()
      .int()
      .min(100 * 1024)
      .max(25 * 1024 * 1024),
    default: 8 * 1024 * 1024,
  },
  maxPhotosPerPlace: {
    label: 'Maks. zdjęć na miejsce',
    description: 'Ile zdjęć może mieć jedno miejsce.',
    schema: z.number().int().min(1).max(50),
    default: 12,
  },
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValues = { [K in SettingKey]: z.infer<(typeof SETTINGS)[K]['schema']> };
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

/** Hard ceiling for the multipart parser; the effective limit is the maxPhotoBytes setting. */
export const PHOTO_BYTES_CEILING = SETTINGS.maxPhotoBytes.schema.maxValue!;

const DEFAULTS = Object.fromEntries(SETTING_KEYS.map((k) => [k, SETTINGS[k].default])) as SettingValues;

/** Reads settings from the database, cached briefly; writes invalidate the cache. */
export class Settings {
  private cache: { values: SettingValues; at: number } | null = null;

  constructor(
    private readonly sql: Sql,
    private readonly ttlMs = 10_000,
  ) {}

  async all(): Promise<SettingValues> {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.values;
    const rows = await this.sql<{ key: string; value: unknown }[]>`select key, value from settings`;
    const values = { ...DEFAULTS };
    for (const row of rows) {
      const def = SETTINGS[row.key as SettingKey];
      const parsed = def?.schema.safeParse(row.value);
      // Unknown keys or values that no longer validate fall back to the default.
      if (parsed?.success) (values as Record<string, unknown>)[row.key] = parsed.data;
    }
    this.cache = { values, at: Date.now() };
    return values;
  }

  async get<K extends SettingKey>(key: K): Promise<SettingValues[K]> {
    return (await this.all())[key];
  }

  async set(key: SettingKey, value: unknown, userId: string): Promise<void> {
    const def = SETTINGS[key];
    const parsed = def.schema.safeParse(value);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_setting', `${key}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    }
    await this.sql`
      insert into settings (key, value, updated_by) values (${key}, ${this.sql.json(parsed.data)}, ${userId})
      on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()
    `;
    this.cache = null;
  }

  async reset(key: SettingKey): Promise<void> {
    await this.sql`delete from settings where key = ${key}`;
    this.cache = null;
  }
}
