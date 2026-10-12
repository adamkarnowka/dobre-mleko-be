-- New category: hotel (hotels, guesthouses, hostels).
alter table places drop constraint places_category_check;
alter table places add constraint places_category_check check (category in
  ('food', 'coffee', 'bar', 'club', 'kids', 'culture', 'nature', 'sport', 'shopping', 'hotel', 'other'));
