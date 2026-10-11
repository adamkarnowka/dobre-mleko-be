create extension if not exists pgcrypto;

create table users (
  id           uuid primary key default gen_random_uuid(),
  email        text not null unique,
  google_sub   text unique,
  name         text not null,
  avatar_url   text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table places (
  id               uuid primary key default gen_random_uuid(),
  name             text not null check (length(name) between 1 and 120),
  category         text not null check (category in
                     ('food', 'coffee', 'bar', 'club', 'kids', 'culture', 'nature', 'sport', 'shopping', 'other')),
  price_level      smallint check (price_level between 1 and 4),
  address          text,
  lat              double precision not null check (lat between -90 and 90),
  lng              double precision not null check (lng between -180 and 180),
  description      text,
  tags             text[] not null default '{}',
  opening_hours    jsonb,
  google_place_id  text unique,
  added_by         uuid not null references users (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index places_category_idx on places (category);
create index places_name_idx on places (lower(name));

-- The image files live on a volume, named by their SHA-256 (see src/photo-store.ts); only the hash is stored here.
create table place_photos (
  id            uuid primary key default gen_random_uuid(),
  place_id      uuid not null references places (id) on delete cascade,
  uploaded_by   uuid not null references users (id),
  hash          char(64) not null check (hash ~ '^[0-9a-f]{64}$'),
  content_type  text not null,
  size_bytes    integer not null,
  created_at    timestamptz not null default now(),
  unique (place_id, hash)
);
create index place_photos_place_idx on place_photos (place_id, created_at);
create index place_photos_hash_idx on place_photos (hash);

-- One rating per person per place. Criteria are 1–5; service and value are optional ("nie dotyczy").
-- Overall is the average of the criteria that were given.
create table ratings (
  user_id     uuid not null references users (id) on delete cascade,
  place_id    uuid not null references places (id) on delete cascade,
  vibe        smallint not null check (vibe between 1 and 5),
  offer       smallint not null check (offer between 1 and 5),
  service     smallint check (service between 1 and 5),
  value       smallint check (value between 1 and 5),
  overall     numeric(3, 2) generated always as (
                (vibe + offer + coalesce(service, 0) + coalesce(value, 0))::numeric
                / (2 + (service is not null)::int + (value is not null)::int)
              ) stored,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (user_id, place_id)
);
create index ratings_place_idx on ratings (place_id);

-- Golden stars ("musisz tam iść"): a monthly quota per person, at most one per place per month.
-- month is the first day of the month in the app's time zone.
create table stars (
  user_id     uuid not null references users (id) on delete cascade,
  place_id    uuid not null references places (id) on delete cascade,
  month       date not null,
  created_at  timestamptz not null default now(),
  primary key (user_id, place_id, month)
);
create index stars_place_month_idx on stars (place_id, month);
create index stars_month_idx on stars (month);

create table comments (
  id          uuid primary key default gen_random_uuid(),
  place_id    uuid not null references places (id) on delete cascade,
  user_id     uuid not null references users (id) on delete cascade,
  body        text not null check (length(body) between 1 and 2000),
  created_at  timestamptz not null default now()
);
create index comments_place_idx on comments (place_id, created_at desc);

create table saved_places (
  user_id     uuid not null references users (id) on delete cascade,
  place_id    uuid not null references places (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, place_id)
);

-- Great-circle distance in kilometres.
create function distance_km(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns double precision language sql immutable parallel safe as $$
  select 2 * 6371 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)
  ))
$$;
