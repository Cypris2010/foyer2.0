// Tiles for slides with many rooms: only what is running and what comes next, so it stays
// readable. Not part of the wp-foyer port; up to two rooms keep the cards of legacy.js.

export const COMPACT_FROM_ROOMS = 3;

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

export interface CompactLabels {
  next: string;
  free: string;
  occupied: string;
  cancelled: string;
}

export interface CompactFormat {
  formatRange(start: Date, end: Date): string;
  isGenericType(value: string): boolean;
}

export interface CompactTile {
  room: string;
  occupied: boolean;
  time: string;
  booking: string;
  teachers: string;
  next: { time: string; booking: string } | null;
}

const unique = (values: string[]) => [...new Set(values.filter(Boolean))];

/** The booking a tile names under "Danach". */
export const nextBooking = <T extends { cancelled?: boolean }>(upcoming: T[]): T | undefined => upcoming.find((event) => !event.cancelled);

function booking(event: RoomEvent, format: CompactFormat): string {
  const extra = [
    event.type && !format.isGenericType(event.type) ? event.type : '',
    event.textSubstitute ?? '',
    event.textBooking && !format.isGenericType(event.textBooking) ? event.textBooking : '',
  ];
  return unique([event.title ?? '', ...extra]).join(' • ');
}

/** What a tile says. Several lessons at once share the tile. */
export function compactTiles(rooms: RoomData[], labels: CompactLabels, format: CompactFormat, hideUpcoming: boolean): CompactTile[] {
  return rooms.map((room) => {
    const current = room.current ?? [];
    const active = current.filter((event) => !event.cancelled);
    const shown = active.length ? active : current;
    const bookings = unique(shown.map((event) => booking(event, format))).join(' / ');
    const next = hideUpcoming ? undefined : nextBooking(room.upcoming ?? []);
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
      next: next ? { time: format.formatRange(next.startDate, next.endDate), booking: booking(next, format) } : null,
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

export function renderCompact(grid: HTMLElement, rooms: RoomData[], labels: CompactLabels, format: CompactFormat, hideUpcoming: boolean): void {
  grid.style.setProperty('--foyer-room-columns', '1');
  grid.style.setProperty('--foyer-room-rows', '1');

  const tiles = document.createElement('div');
  tiles.className = 'foyer-webuntis-room-display__tiles';
  const size = tileGrid(rooms.length);
  tiles.style.setProperty('--foyer-tile-columns', String(size.columns));
  tiles.style.setProperty('--foyer-tile-rows', String(size.rows));
  tiles.style.setProperty('--foyer-tile-columns-portrait', String(size.portraitColumns));
  tiles.style.setProperty('--foyer-tile-rows-portrait', String(size.portraitRows));

  for (const room of compactTiles(rooms, labels, format, hideUpcoming)) {
    const tile = document.createElement('section');
    tile.className = `foyer-webuntis-room-display__tile ${room.occupied ? 'is-occupied' : 'is-free'}`;

    const header = document.createElement('header');
    header.className = 'foyer-webuntis-room-display__tile-header';
    const pill = part('status', room.occupied ? labels.occupied : labels.free);
    header.append(part('room', room.room), pill);
    tile.append(header);

    const now = document.createElement('div');
    now.className = 'foyer-webuntis-room-display__tile-now';
    if (room.time) now.append(part('time', room.time));
    if (room.booking) now.append(part('booking', room.booking));
    if (room.teachers) now.append(part('teachers', room.teachers));
    tile.append(now);

    if (room.next) {
      const next = part('next', '');
      const label = document.createElement('strong');
      label.textContent = `${labels.next} ${room.next.time}`;
      next.append(label, ` ${room.next.booking}`);
      tile.append(next);
    }
    tiles.append(tile);
  }
  grid.append(tiles);
}
