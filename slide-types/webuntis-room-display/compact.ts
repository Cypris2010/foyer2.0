// Table for slides with many rooms: one line per room, so what is running right now
// stays readable. Not part of the wp-foyer port; up to two rooms keep the cards of legacy.js.

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
  room: string;
  time: string;
  booking: string;
  next: string;
  teachers: string;
  free: string;
  occupied: string;
  cancelled: string;
}

export interface CompactFormat {
  formatRange(start: Date, end: Date): string;
  isGenericType(value: string): boolean;
}

export interface CompactRow {
  room: string;
  occupied: boolean;
  time: string;
  booking: string;
  teachers: string;
  next: { time: string; booking: string } | null;
}

const unique = (values: string[]) => [...new Set(values.filter(Boolean))];

function booking(event: RoomEvent, format: CompactFormat): string {
  const extra = [
    event.type && !format.isGenericType(event.type) ? event.type : '',
    event.textSubstitute ?? '',
    event.textBooking && !format.isGenericType(event.textBooking) ? event.textBooking : '',
  ];
  return unique([event.title ?? '', ...extra]).join(' • ');
}

/** What a line of the table says. Several lessons at once share the line. */
export function compactRows(rooms: RoomData[], labels: CompactLabels, format: CompactFormat, hideUpcoming: boolean): CompactRow[] {
  return rooms.map((room) => {
    const current = room.current ?? [];
    const active = current.filter((event) => !event.cancelled);
    const shown = active.length ? active : current;
    const bookings = unique(shown.map((event) => booking(event, format))).join(' / ');
    const next = hideUpcoming ? undefined : (room.upcoming ?? []).find((event) => !event.cancelled);
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

function cell(name: string, text: string): HTMLElement {
  const node = document.createElement('div');
  node.className = `foyer-webuntis-room-display__cell foyer-webuntis-room-display__cell--${name}`;
  node.textContent = text;
  return node;
}

function lineOf(cells: HTMLElement[], className: string): HTMLElement {
  const line = document.createElement('div');
  line.className = `foyer-webuntis-room-display__line-row ${className}`;
  line.append(...cells);
  return line;
}

export function renderCompact(grid: HTMLElement, rooms: RoomData[], labels: CompactLabels, format: CompactFormat, hideUpcoming: boolean): void {
  grid.style.setProperty('--foyer-room-columns', '1');
  grid.style.setProperty('--foyer-room-rows', '1');

  const table = document.createElement('div');
  table.className = 'foyer-webuntis-room-display__table';
  table.classList.toggle('foyer-webuntis-room-display__table--no-next', hideUpcoming);
  table.style.setProperty('--foyer-compact-rows', String(rooms.length));

  const heads = [cell('room', labels.room), cell('status', ''), cell('time', labels.time), cell('booking', labels.booking), cell('teachers', labels.teachers)];
  if (!hideUpcoming) heads.push(cell('next', labels.next));
  table.append(lineOf(heads, 'foyer-webuntis-room-display__line-row--head'));

  for (const row of compactRows(rooms, labels, format, hideUpcoming)) {
    const status = cell('status', '');
    const pill = document.createElement('span');
    pill.className = `foyer-webuntis-room-display__pill ${row.occupied ? 'is-occupied' : 'is-free'}`;
    pill.textContent = row.occupied ? labels.occupied : labels.free;
    status.append(pill);

    const cells = [cell('room', row.room), status, cell('time', row.time), cell('booking', row.booking), cell('teachers', row.teachers)];
    if (!hideUpcoming) {
      const next = cell('next', '');
      if (row.next) {
        const time = document.createElement('strong');
        time.textContent = row.next.time;
        next.append(time, ` ${row.next.booking}`);
      }
      cells.push(next);
    }
    table.append(lineOf(cells, row.occupied ? 'is-occupied' : 'is-free'));
  }
  grid.append(table);
}
