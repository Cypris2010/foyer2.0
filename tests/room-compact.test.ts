import { describe, expect, it } from 'vitest';
import { compactRows, COMPACT_FROM_ROOMS, type CompactLabels } from '../slide-types/webuntis-room-display/compact.ts';
import { config } from '../slide-types/webuntis-room-display/index.ts';

const labels: CompactLabels = { room: 'Raum', time: 'Zeit', booking: 'Belegung', next: 'Danach', teachers: 'Lehrperson(en)', free: 'Frei', occupied: 'Belegt', cancelled: 'Unterricht entfällt' };
const clock = (date: Date) => date.toISOString().slice(11, 16);
const format = { formatRange: (start: Date, end: Date) => `${clock(start)} – ${clock(end)}`, isGenericType: (value: string) => value === 'Lesson' };
const at = (time: string) => new Date(`2026-11-09T${time}:00Z`);
const event = (from: string, to: string, extra: Record<string, unknown> = {}) => ({ startDate: at(from), endDate: at(to), title: 'Mathe • 10A', teachers: 'Mus', type: 'Lesson', ...extra });

describe('table for many rooms', () => {
  it('shows the running lesson and what comes next', () => {
    const [row] = compactRows([{ room: 'T 1.05', current: [event('08:00', '09:00')], upcoming: [event('10:00', '11:00', { title: 'Deutsch • 10B' })] }], labels, format, false);
    expect(row).toEqual({ room: 'T 1.05', occupied: true, time: '08:00 – 09:00', booking: 'Mathe • 10A', teachers: 'Mus', next: { time: '10:00 – 11:00', booking: 'Deutsch • 10B' } });
  });

  it('shows a free room with nothing else', () => {
    expect(compactRows([{ room: 'T 1.05' }], labels, format, false)[0]).toEqual({ room: 'T 1.05', occupied: false, time: '', booking: '', teachers: '', next: null });
  });

  it('shows bookings without a subject by their text', () => {
    const [row] = compactRows([{ room: 'Aula I', current: [event('08:00', '20:00', { title: '', teachers: '', type: 'Prüfung', textBooking: 'Dienstversammlung' })] }], labels, format, false);
    expect(row.booking).toBe('Prüfung • Dienstversammlung');
  });

  it('puts several lessons at once on one line', () => {
    const [row] = compactRows([{ room: 'T 1.05', current: [event('08:00', '09:00'), event('08:30', '09:30', { title: 'Deutsch • 10B', teachers: 'Mus, Bei' })] }], labels, format, false);
    expect(row).toMatchObject({ time: '08:00 – 09:30', booking: 'Mathe • 10A / Deutsch • 10B', teachers: 'Mus, Bei' });
  });

  it('counts a room with a cancelled lesson as free and says so', () => {
    const [row] = compactRows([{ room: 'T 1.05', current: [event('08:00', '09:00', { cancelled: true })] }], labels, format, false);
    expect(row).toMatchObject({ occupied: false, booking: 'Unterricht entfällt: Mathe • 10A' });
  });

  it('prefers the running lesson over a cancelled one', () => {
    const [row] = compactRows([{ room: 'T 1.05', current: [event('08:00', '09:00', { cancelled: true }), event('08:00', '09:00', { title: 'Deutsch • 10B' })] }], labels, format, false);
    expect(row).toMatchObject({ occupied: true, booking: 'Deutsch • 10B' });
  });

  it('skips cancelled lessons when naming what comes next', () => {
    const [row] = compactRows([{ room: 'T 1.05', upcoming: [event('09:00', '10:00', { cancelled: true }), event('10:00', '11:00')] }], labels, format, false);
    expect(row.next?.time).toBe('10:00 – 11:00');
  });

  it('leaves out what comes next on request', () => {
    expect(compactRows([{ room: 'T 1.05', upcoming: [event('10:00', '11:00')] }], labels, format, true)[0].next).toBeNull();
  });

  it('keeps the cards for up to two rooms', () => {
    expect(COMPACT_FROM_ROOMS).toBe(3);
  });

  it('accepts slides saved before the heading existed', () => {
    expect(config.parse({ rooms: ['T 1.05'] }).title).toBe('');
  });
});
