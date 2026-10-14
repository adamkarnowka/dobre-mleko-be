-- More card layouts (diagonal, ribbon, arch, wedge) and photo filters (xerox, hatch, mosaic, sunset) to choose from.
alter table places drop constraint places_card_layout_check;
alter table places
  add constraint places_card_layout_check
    check (card_layout in ('auto', 'a', 'b', 'c', 'diagonal', 'ribbon', 'arch', 'wedge'));
alter table places drop constraint places_photo_filter_check;
alter table places
  add constraint places_photo_filter_check
    check (photo_filter in ('none', 'duotone', 'halftone', 'engraving', 'riso', 'xerox', 'hatch', 'mosaic', 'sunset'));
