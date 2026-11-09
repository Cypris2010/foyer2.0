import { describe, expect, it } from 'vitest';
import { roomTiles, shownUpcoming, tileGrid, type TileLabels } from '../slide-types/webuntis-room-display/tiles.ts';
import { config } from '../slide-types/webuntis-room-display/index.ts';

const labels: TileLabels = { next: 'Danach', noUpcoming: 'Keine weiteren Belegungen heute.', free: 'Frei', occupied: 'Belegt', cancelled: 'Unterricht entfällt' };
const clock = (date: Date) => date.toISOString().slice(11, 16);
const format = { formatRange: (start: Date, end: Date) => `${clock(start)} – ${clock(end)}`, isGenericType: (value: string) => value === 'Unterricht' };
const at = (time: string) => new Date(`2026-11-09T${time}:00Z`);
const event = (from: string, to: string, extra: Record<string, unknown> = {}) => ({ startDate: at(from), endDate: at(to), title: 'Mathe • 10A', teachers: 'Mus', type: 'Unterricht', ...extra });
const tile = (room: Parameters<typeof roomTiles>[0][number], roomCount = 6, hideUpcoming = false) => roomTiles([room], labels, format, roomCount, hideUpcoming)[0];

describe('room tiles', () => {
  it('shows the running lesson and what comes next', () => {
    expect(tile({ room: 'T 1.05', current: [event('08:00', '09:00')], upcoming: [event('10:00', '11:00', { title: 'Deutsch • 10B' })] })).toEqual({
      room: 'T 1.05',
      occupied: true,
      time: '08:00 – 09:00',
      booking: 'Mathe • 10A',
      teachers: 'Mus',
      next: [{ time: '10:00 – 11:00', booking: 'Deutsch • 10B' }],
    });
  });

  it('shows a free room with nothing else', () => {
    expect(tile({ room: 'T 1.05' })).toEqual({ room: 'T 1.05', occupied: false, time: '', booking: '', teachers: '', next: [] });
  });

  it('shows bookings without a subject by their text', () => {
    expect(tile({ room: 'Aula I', current: [event('08:00', '20:00', { title: '', teachers: '', type: 'Prüfung', textBooking: 'Dienstversammlung' })] }).booking).toBe('Prüfung • Dienstversammlung');
  });

  it('puts several lessons at once on one tile', () => {
    expect(tile({ room: 'T 1.05', current: [event('08:00', '09:00'), event('08:30', '09:30', { title: 'Deutsch • 10B', teachers: 'Mus, Bei' })] })).toMatchObject({
      time: '08:00 – 09:30',
      booking: 'Mathe • 10A / Deutsch • 10B',
      teachers: 'Mus, Bei',
    });
  });

  it('counts a room with a cancelled lesson as free and says so', () => {
    expect(tile({ room: 'T 1.05', current: [event('08:00', '09:00', { cancelled: true })] })).toMatchObject({ occupied: false, booking: 'Unterricht entfällt: Mathe • 10A' });
  });

  it('prefers the running lesson over a cancelled one', () => {
    expect(tile({ room: 'T 1.05', current: [event('08:00', '09:00', { cancelled: true }), event('08:00', '09:00', { title: 'Deutsch • 10B' })] })).toMatchObject({ occupied: true, booking: 'Deutsch • 10B' });
  });

  it('skips cancelled lessons when naming what comes next', () => {
    expect(tile({ room: 'T 1.05', upcoming: [event('09:00', '10:00', { cancelled: true }), event('10:00', '11:00')] }).next[0].time).toBe('10:00 – 11:00');
  });

  it('leaves out what comes next on request', () => {
    expect(tile({ room: 'T 1.05', upcoming: [event('10:00', '11:00')] }, 6, true).next).toEqual([]);
  });

  it('names up to three next bookings on a slide with few rooms, else one', () => {
    const upcoming = [event('09:00', '10:00'), event('10:00', '11:00'), event('11:00', '12:00'), event('12:00', '13:00')];
    expect(shownUpcoming(upcoming, 1, false)).toHaveLength(3);
    expect(shownUpcoming(upcoming, 2, false)).toHaveLength(3);
    expect(shownUpcoming(upcoming, 3, false)).toHaveLength(1);
    expect(shownUpcoming(upcoming, 2, true)).toEqual([]);
  });

  it('arranges the tiles for landscape and portrait', () => {
    expect(tileGrid(1)).toEqual({ columns: 1, rows: 1, portraitColumns: 1, portraitRows: 1 });
    expect(tileGrid(2)).toEqual({ columns: 2, rows: 1, portraitColumns: 1, portraitRows: 2 });
    expect(tileGrid(3)).toEqual({ columns: 2, rows: 2, portraitColumns: 1, portraitRows: 3 });
    expect(tileGrid(4)).toEqual({ columns: 2, rows: 2, portraitColumns: 2, portraitRows: 2 });
    expect(tileGrid(6)).toEqual({ columns: 3, rows: 2, portraitColumns: 2, portraitRows: 3 });
    expect(tileGrid(10)).toEqual({ columns: 4, rows: 3, portraitColumns: 2, portraitRows: 5 });
  });

  it('accepts slides saved before the heading existed', () => {
    expect(config.parse({ rooms: ['T 1.05'] }).title).toBe('');
  });

  it('accepts slides saved with the old heading option', () => {
    expect(config.parse({ rooms: ['T 1.05'], hideCurrent: true })).not.toHaveProperty('hideCurrent');
  });
});
