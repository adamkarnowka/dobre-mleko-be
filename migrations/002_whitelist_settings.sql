-- Who may sign in, managed from the admin dashboard. An entry can exist before the person first signs in.
create table allowed_emails (
  email       text primary key check (email = lower(email) and position('@' in email) > 1),
  role        text not null default 'member' check (role in ('member', 'admin')),
  note        text check (length(note) <= 200),
  added_by    uuid references users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Runtime settings editable by admins. Keys and defaults are defined in src/settings.ts;
-- a row exists only once a setting has been changed from its default.
create table settings (
  key         text primary key,
  value       jsonb not null,
  updated_by  uuid references users (id) on delete set null,
  updated_at  timestamptz not null default now()
);
