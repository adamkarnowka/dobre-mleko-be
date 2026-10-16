-- The Google Maps link a place was added from (or later given), so the apps can open that exact place there.
alter table places add column google_maps_url text check (length(google_maps_url) <= 500);
