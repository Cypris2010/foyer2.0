import { describe, expect, it } from 'vitest';
import { compactTiles, COMPACT_FROM_ROOMS, tileGrid, type CompactLabels } from '../slide-types/webuntis-room-display/compact.ts';
import { config } from '../slide-types/webuntis-room-display/index.ts';

const labels: CompactLabels = { next: 'Danach', free: 'Frei', occupied: 'Belegt', cancelled: 'Unterricht entfällt' };
const clock = (date: Date) => date.toISOString().slice(11, 16);
const format = { formatRange: (start: Date, end: Date) => `${clock(start)} – ${clock(end)}`, isGenericType: (value: string) => value === 'Unterricht' };
const at = (time: string) => new Date(`2026-11-09T${time}:00Z`);
const event = (from: string, to: string, extra: Record<string, unknown> = {}) => ({ startDate: at(from), endDate: at(to), title: 'Mathe • 10A', teachers: 'Mus', type: 'Unterricht', ...extra });

describe('tiles for many rooms', () => {
  it('shows the running lesson and what comes next', () => {
    const [tile] = compactTiles([{ room: 'T 1.05', current: [event('08:00', '09:00')], upcoming: [event('10:00', '11:00', { title: 'Deutsch • 10B' })] }], labels, format, false);
    expect(tile).toEqual({ room: 'T 1.05', occupied: true, time: '08:00 – 09:00', booking: 'Mathe • 10A', teachers: 'Mus', next: { time: '10:00 – 11:00', booking: 'Deutsch • 10B' } });
  });

  it('shows a free room with nothing else', () => {
    expect(compactTiles([{ room: 'T 1.05' }], labels, format, false)[0]).toEqual({ room: 'T 1.05', occupied: false, time: '', booking: '', teachers: '', next: null });
  });

  it('shows bookings without a subject by their text', () => {
    const [tile] = compactTiles([{ room: 'Aula I', current: [event('08:00', '20:00', { title: '', teachers: '', type: 'Prüfung', textBooking: 'Dienstversammlung' })] }], labels, format, false);
    expect(tile.booking).toBe('Prüfung • Dienstversammlung');
  });

  it('puts several lessons at once on one tile', () => {
    const [tile] = compactTiles([{ room: 'T 1.05', current: [event('08:00', '09:00'), event('08:30', '09:30', { title: 'Deutsch • 10B', teachers: 'Mus, Bei' })] }], labels, format, false);
    expect(tile).toMatchObject({ time: '08:00 – 09:30', booking: 'Mathe • 10A / Deutsch • 10B', teachers: 'Mus, Bei' });
  });

  it('counts a room with a cancelled lesson as free and says so', () => {
    const [tile] = compactTiles([{ room: 'T 1.05', current: [event('08:00', '09:00', { cancelled: true })] }], labels, format, false);
    expect(tile).toMatchObject({ occupied: false, booking: 'Unterricht entfällt: Mathe • 10A' });
  });

  it('prefers the running lesson over a cancelled one', () => {
    const [tile] = compactTiles([{ room: 'T 1.05', current: [event('08:00', '09:00', { cancelled: true }), event('08:00', '09:00', { title: 'Deutsch • 10B' })] }], labels, format, false);
    expect(tile).toMatchObject({ occupied: true, booking: 'Deutsch • 10B' });
  });

  it('skips cancelled lessons when naming what comes next', () => {
    const [tile] = compactTiles([{ room: 'T 1.05', upcoming: [event('09:00', '10:00', { cancelled: true }), event('10:00', '11:00')] }], labels, format, false);
    expect(tile.next?.time).toBe('10:00 – 11:00');
  });

  it('leaves out what comes next on request', () => {
    expect(compactTiles([{ room: 'T 1.05', upcoming: [event('10:00', '11:00')] }], labels, format, true)[0].next).toBeNull();
  });

  it('arranges the tiles for landscape and portrait', () => {
    expect(tileGrid(3)).toEqual({ columns: 2, rows: 2, portraitColumns: 1, portraitRows: 3 });
    expect(tileGrid(4)).toEqual({ columns: 2, rows: 2, portraitColumns: 2, portraitRows: 2 });
    expect(tileGrid(6)).toEqual({ columns: 3, rows: 2, portraitColumns: 2, portraitRows: 3 });
    expect(tileGrid(10)).toEqual({ columns: 4, rows: 3, portraitColumns: 2, portraitRows: 5 });
  });

  it('keeps the cards for up to two rooms', () => {
    expect(COMPACT_FROM_ROOMS).toBe(3);
  });

  it('accepts slides saved before the heading existed', () => {
    expect(config.parse({ rooms: ['T 1.05'] }).title).toBe('');
  });
});
