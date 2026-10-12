-- How the place is presented in the app, chosen by its author: card layout, photo filter and its strength,
-- and the card's main colour (one of the app's 16 card colours; null = the category's colour).
alter table places
  add column card_layout text not null default 'auto' check (card_layout in ('auto', 'a', 'b', 'c')),
  add column photo_filter text not null default 'none'
    check (photo_filter in ('none', 'duotone', 'halftone', 'engraving', 'riso')),
  add column filter_intensity smallint not null default 100 check (filter_intensity between 0 and 100),
  add column card_color text check (card_color in ('red', 'blue', 'yellow', 'ink', 'orange', 'pink', 'green', 'teal', 'sky', 'navy', 'violet', 'ochre', 'brick', 'olive', 'sand', 'stone'));
