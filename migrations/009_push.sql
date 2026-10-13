-- Push notifications: the devices people allow notifications on, what they want to hear about, and a log of what
-- was sent (new places, new comments, messages from admins).
create table devices (
  -- APNs device token (hex) or FCM registration token.
  token        text primary key check (length(token) between 16 and 512),
  user_id      uuid not null references users (id) on delete cascade,
  platform     text not null check (platform in ('ios', 'android')),
  -- APNs: `sandbox` for development-signed builds (Xcode), `production` for TestFlight and the App Store.
  environment  text not null check (environment in ('sandbox', 'production')),
  -- Bundle id / package name: the APNs topic.
  app_id       text not null check (length(app_id) between 1 and 200),
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index devices_user_idx on devices (user_id);

-- New places: `all`, `favorites` (only in my favourite categories) or `none`. Comments: on places I added,
-- commented on or saved.
alter table users
  add column notify_new_places text not null default 'favorites'
    check (notify_new_places in ('all', 'favorites', 'none')),
  add column notify_comments boolean not null default true;

create table push_log (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  kind        text not null check (kind in ('new_place', 'new_comment', 'admin')),
  title       text not null,
  body        text not null,
  place_id    uuid references places (id) on delete set null,
  -- Who sent it (admin messages); no foreign key, like categories.updated_by.
  sent_by     uuid,
  -- How the recipients were chosen, e.g. {"kind": "categories", "categories": ["coffee"]}.
  audience    jsonb not null,
  recipients  integer not null,
  devices     integer not null,
  delivered   integer not null,
  failed      integer not null
);

create index push_log_created_idx on push_log (created_at desc);
