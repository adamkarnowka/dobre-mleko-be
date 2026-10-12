create extension if not exists postgis;

-- lat/lng stay the source of truth; geom follows them automatically.
alter table places
  add column geom geometry(Point, 4326)
  generated always as (ST_SetSRID(ST_MakePoint(lng, lat), 4326)) stored;

-- Map viewport queries: geom && ST_MakeEnvelope(...)
create index places_geom_idx on places using gist (geom);
-- Distances in metres on the sphere: ST_DWithin / ST_Distance / <-> on geom::geography
create index places_geog_idx on places using gist ((geom::geography));

drop function distance_km(double precision, double precision, double precision, double precision);
