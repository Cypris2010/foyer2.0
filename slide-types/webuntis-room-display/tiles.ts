// The tiles of the room display: what is running and what comes next, for any number of rooms.
// Not from wp-foyer; legacy.js reads the data as wp-foyer did and hands it over.

const FEW_ROOMS = 2;
const NEXT_WITH_FEW_ROOMS = 3;

interface RoomEvent {
  startDate: Date;
  endDate: Date;
  title?: string;
  teachers?: string;
  type?: string;
  textSubstitute?: string;
  textBooking?: string;
  cancelled?: boolean;
}

interface RoomData {
  room: string;
  current?: RoomEvent[];
  upcoming?: RoomEvent[];
}

export interface TileLabels {
  next: string;
  noUpcoming: string;
  free: string;
  occupied: string;
  cancelled: string;
}

export interface TileFormat {
  formatRange(start: Date, end: Date): string;
  isGenericType(value: string): boolean;
}

export interface RoomTile {
  room: string;
  occupied: boolean;
  time: string;
  booking: string;
  teachers: string;
  next: { time: string; booking: string }[];
}

const unique = (values: string[]) => [...new Set(values.filter(Boolean))];

/** The next bookings a tile names: a few on a slide with few rooms, otherwise one. */
export function shownUpcoming<T extends RoomEvent>(upcoming: T[], roomCount: number, hideUpcoming: boolean): T[] {
  if (hideUpcoming) return [];
  return upcoming.filter((event) => !event.cancelled).slice(0, roomCount <= FEW_ROOMS ? NEXT_WITH_FEW_ROOMS : 1);
}

function booking(event: RoomEvent, format: TileFormat): string {
  const extra = [
    event.type && !format.isGenericType(event.type) ? event.type : '',
    event.textSubstitute ?? '',
    event.textBooking && !format.isGenericType(event.textBooking) ? event.textBooking : '',
  ];
  return unique([event.title ?? '', ...extra]).join(' • ');
}

/** What a tile says. Several lessons at once share the tile. */
export function roomTiles(rooms: RoomData[], labels: TileLabels, format: TileFormat, roomCount: number, hideUpcoming: boolean): RoomTile[] {
  return rooms.map((room) => {
    const current = room.current ?? [];
    const active = current.filter((event) => !event.cancelled);
    const shown = active.length ? active : current;
    const bookings = unique(shown.map((event) => booking(event, format))).join(' / ');
    return {
      room: room.room,
      occupied: active.length > 0,
      time: shown.length
        ? format.formatRange(
            new Date(Math.min(...shown.map((event) => event.startDate.getTime()))),
            new Date(Math.max(...shown.map((event) => event.endDate.getTime()))),
          )
        : '',
      booking: !active.length && shown.length ? unique([labels.cancelled, bookings]).join(': ') : bookings,
      teachers: unique(shown.flatMap((event) => (event.teachers ?? '').split(/,\s*/))).join(', '),
      next: shownUpcoming(room.upcoming ?? [], roomCount, hideUpcoming).map((event) => ({
        time: format.formatRange(event.startDate, event.endDate),
        booking: booking(event, format),
      })),
    };
  });
}

/** Columns and rows of the tiles, in landscape and in portrait. */
export function tileGrid(count: number): { columns: number; rows: number; portraitColumns: number; portraitRows: number } {
  const columns = Math.ceil(Math.sqrt(count));
  const portraitColumns = count <= 3 ? 1 : 2;
  return { columns, rows: Math.ceil(count / columns), portraitColumns, portraitRows: Math.ceil(count / portraitColumns) };
}

function part(name: string, text: string): HTMLElement {
  const node = document.createElement('div');
  node.className = `foyer-webuntis-room-display__tile-${name}`;
  node.textContent = text;
  return node;
}

function nextRow(time: string, text: string): HTMLElement {
  const row = part('next-row', '');
  const label = document.createElement('strong');
  label.textContent = time;
  row.append(label, ` ${text}`);
  return row;
}

export function renderTiles(grid: HTMLElement, rooms: RoomData[], labels: TileLabels, format: TileFormat, roomCount: number, hideUpcoming: boolean): void {
  grid.style.setProperty('--foyer-room-columns', '1');
  grid.style.setProperty('--foyer-room-rows', '1');

  const tiles = document.createElement('div');
  tiles.className = 'foyer-webuntis-room-display__tiles';
  const size = tileGrid(rooms.length);
  tiles.style.setProperty('--foyer-tile-columns', String(size.columns));
  tiles.style.setProperty('--foyer-tile-rows', String(size.rows));
  tiles.style.setProperty('--foyer-tile-columns-portrait', String(size.portraitColumns));
  tiles.style.setProperty('--foyer-tile-rows-portrait', String(size.portraitRows));

  for (const room of roomTiles(rooms, labels, format, roomCount, hideUpcoming)) {
    const tile = document.createElement('section');
    tile.className = `foyer-webuntis-room-display__tile ${room.occupied ? 'is-occupied' : 'is-free'}`;

    const header = document.createElement('header');
    header.className = 'foyer-webuntis-room-display__tile-header';
    header.append(part('room', room.room), part('status', room.occupied ? labels.occupied : labels.free));
    tile.append(header);

    const now = document.createElement('div');
    now.className = 'foyer-webuntis-room-display__tile-now';
    if (room.time) now.append(part('time', room.time));
    if (room.booking) now.append(part('booking', room.booking));
    if (room.teachers) now.append(part('teachers', room.teachers));
    tile.append(now);

    if (!hideUpcoming) {
      const next = part('next', '');
      room.next.forEach((entry, index) => next.append(nextRow(index ? entry.time : `${labels.next} ${entry.time}`, entry.booking)));
      if (!room.next.length) next.textContent = labels.noUpcoming;
      tile.append(next);
    }
    tiles.append(tile);
  }
  grid.append(tiles);
}
