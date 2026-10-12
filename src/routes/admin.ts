import { z } from 'zod';
import type { App, Ctx } from '../app.js';
import type { Role } from '../auth.js';
import { HttpError, notFound } from '../errors.js';
import { AllowedEmail, AllowedEmailList, Setting, SettingList } from '../schemas.js';
import { SETTING_KEYS, SETTINGS, type SettingKey } from '../settings.js';

const email = z.email().transform((e) => e.trim().toLowerCase());
const role = z.enum(['member', 'admin']);
const note = z.string().trim().max(200).nullable();
const emailParams = z.object({ email });
const settingParams = z.object({ key: z.enum(SETTING_KEYS as [SettingKey, ...SettingKey[]]) });

interface AllowedRow {
  email: string;
  role: Role;
  note: string | null;
  created_at: Date;
  added_by_id: string | null;
  added_by_name: string | null;
  user_id: string | null;
  user_name: string | null;
  avatar_url: string | null;
  avatar_hash: string | null;
  joined_at: Date | null;
  last_seen_at: Date | null;
  places: number;
  ratings: number;
}

export function adminRoutes(app: App, ctx: Ctx) {
  const { sql, config } = ctx;
  const fromEnvironment = (e: string) => config.ADMIN_EMAILS.includes(e);

  const selectAllowed = (where: ReturnType<typeof sql>) => sql<AllowedRow[]>`
    select a.email, a.role, a.note, a.created_at,
           ab.id as added_by_id, ab.name as added_by_name,
           u.id as user_id, u.name as user_name, u.avatar_url, u.avatar_hash, u.created_at as joined_at, u.last_seen_at,
           (select count(*)::int from places p where p.added_by = u.id) as places,
           (select count(*)::int from ratings r where r.user_id = u.id) as ratings
    from allowed_emails a
    left join users u on u.email = a.email
    left join users ab on ab.id = a.added_by
    where ${where}
    order by a.role, coalesce(u.name, a.email)
  `;

  const toAllowed = (r: AllowedRow) => ({
    email: r.email,
    role: r.role,
    note: r.note,
    from_environment: fromEnvironment(r.email),
    added_by: r.added_by_id ? { id: r.added_by_id, display_name: r.added_by_name! } : null,
    created_at: r.created_at.toISOString(),
    user: r.user_id
      ? {
          id: r.user_id,
          display_name: r.user_name!,
          avatar_url: r.avatar_hash ? ctx.urls.url(r.avatar_hash, 'thumb') : r.avatar_url,
          joined_at: r.joined_at!.toISOString(),
          last_seen_at: r.last_seen_at!.toISOString(),
          places: r.places,
          ratings: r.ratings,
        }
      : null,
  });

  async function loadAllowed(e: string) {
    const [row] = await selectAllowed(sql`a.email = ${e}`);
    if (!row) throw notFound('Whitelist entry');
    return toAllowed(row);
  }

  /** Changes that would lock people out are refused. */
  function guard(target: string, currentUserEmail: string, change: 'remove' | 'demote') {
    if (fromEnvironment(target)) {
      throw new HttpError(409, 'managed_by_environment', `${target} is in ADMIN_EMAILS; change it there`);
    }
    if (target === currentUserEmail) {
      throw new HttpError(409, 'cannot_change_self', `You cannot ${change} yourself`);
    }
  }

  app.get(
    '/admin/allowed',
    {
      preHandler: ctx.admin,
      schema: {
        tags: ['Admin'],
        summary: 'Whitelist',
        description: 'Everyone who may sign in, with their account if they have signed in already.',
        response: { 200: AllowedEmailList },
      },
    },
    async () => {
      const items = (await selectAllowed(sql`true`)).map(toAllowed);
      return {
        items,
        admins: items.filter((i) => i.role === 'admin').length,
        members: items.filter((i) => i.role === 'member').length,
      };
    },
  );

  app.post(
    '/admin/allowed',
    {
      preHandler: ctx.admin,
      schema: {
        tags: ['Admin'],
        summary: 'Add someone to the whitelist',
        description: 'They can sign in with this Google account right away. 409 `already_allowed`.',
        body: z.object({ email, role: role.default('member'), note: note.default(null) }),
        response: { 201: AllowedEmail },
      },
    },
    async (req, reply) => {
      const { email: e, role: r, note: n } = req.body;
      const [inserted] = await sql`
        insert into allowed_emails (email, role, note, added_by) values (${e}, ${r}, ${n || null}, ${req.user.id})
        on conflict (email) do nothing
        returning email
      `;
      if (!inserted) throw new HttpError(409, 'already_allowed', `${e} is already on the list`);
      return reply.status(201).send(await loadAllowed(e));
    },
  );

  app.patch(
    '/admin/allowed/:email',
    {
      preHandler: ctx.admin,
      schema: {
        tags: ['Admin'],
        summary: 'Change role or note',
        description:
          'Admins cannot demote themselves or anyone listed in ADMIN_EMAILS (409 `cannot_change_self`, ' +
          '`managed_by_environment`).',
        params: emailParams,
        body: z.object({ role: role.optional(), note: note.optional() }),
        response: { 200: AllowedEmail },
      },
    },
    async (req) => {
      const e = req.params.email;
      const current = await loadAllowed(e);
      const { role: r, note: n } = req.body;
      if (r === 'member' && current.role === 'admin') guard(e, req.user.email, 'demote');
      await sql`
        update allowed_emails set
          role = coalesce(${r ?? null}, role),
          note = ${n === undefined ? sql`note` : n || null},
          updated_at = now()
        where email = ${e}
      `;
      return loadAllowed(e);
    },
  );

  app.delete(
    '/admin/allowed/:email',
    {
      preHandler: ctx.admin,
      schema: {
        tags: ['Admin'],
        summary: 'Remove someone from the whitelist',
        description:
          'They lose access on their next request. Their places, ratings and comments stay; adding them back ' +
          'restores access to the same account.',
        params: emailParams,
      },
    },
    async (req, reply) => {
      const e = req.params.email;
      await loadAllowed(e);
      guard(e, req.user.email, 'remove');
      await sql`delete from allowed_emails where email = ${e}`;
      return reply.status(204).send();
    },
  );

  async function listSettings() {
    const values = await ctx.settings.all();
    const rows = await sql<{ key: string; updated_at: Date; user_id: string | null; user_name: string | null }[]>`
      select s.key, s.updated_at, u.id as user_id, u.name as user_name
      from settings s left join users u on u.id = s.updated_by
    `;
    const meta = new Map(rows.map((r) => [r.key, r]));
    return SETTING_KEYS.map((key) => {
      const def = SETTINGS[key];
      const row = meta.get(key);
      return {
        key,
        label: def.label,
        description: def.description,
        value: values[key],
        default: def.default,
        min: def.schema.minValue ?? null,
        max: def.schema.maxValue ?? null,
        integer: def.schema.isInt,
        updated_at: row ? row.updated_at.toISOString() : null,
        updated_by: row?.user_id ? { id: row.user_id, display_name: row.user_name! } : null,
      };
    });
  }

  app.get(
    '/admin/settings',
    {
      preHandler: ctx.admin,
      schema: { tags: ['Admin'], summary: 'System settings', response: { 200: SettingList } },
    },
    async () => ({ items: await listSettings() }),
  );

  app.put(
    '/admin/settings/:key',
    {
      preHandler: ctx.admin,
      schema: {
        tags: ['Admin'],
        summary: 'Change a setting',
        description: 'Takes effect within seconds. 422 `invalid_input` when the value is out of range.',
        params: settingParams,
        body: z.object({ value: z.unknown() }),
        response: { 200: Setting },
      },
    },
    async (req) => {
      await ctx.settings.set(req.params.key, req.body.value, req.user.id);
      return (await listSettings()).find((s) => s.key === req.params.key)!;
    },
  );

  app.delete(
    '/admin/settings/:key',
    {
      preHandler: ctx.admin,
      schema: {
        tags: ['Admin'],
        summary: 'Reset a setting to its default',
        params: settingParams,
        response: { 200: Setting },
      },
    },
    async (req) => {
      await ctx.settings.reset(req.params.key);
      return (await listSettings()).find((s) => s.key === req.params.key)!;
    },
  );
}
