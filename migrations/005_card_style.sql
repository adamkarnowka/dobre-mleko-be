-- How the place is presented in the app, chosen by its author: card layout, photo filter and its strength.
alter table places
  add column card_layout text not null default 'auto' check (card_layout in ('auto', 'a', 'b', 'c')),
  add column photo_filter text not null default 'none'
    check (photo_filter in ('none', 'duotone', 'halftone', 'engraving', 'riso')),
  add column filter_intensity smallint not null default 100 check (filter_intensity between 0 and 100);
