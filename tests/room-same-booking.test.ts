import { describe, expect, it } from 'vitest';
import { mergeSameBookings } from '../slide-types/webuntis-room-display/same-booking.ts';

const at = (time: string) => new Date(`2026-11-09T${time}:00Z`);
const event = (from: string, to: string, extra: Record<string, unknown> = {}) => ({ startDate: at(from), endDate: at(to), title: '', teachers: '', type: 'Prüfung', textBooking: 'Dienstversammlung', ...extra });
const all = (upcoming: unknown[]) => upcoming as never[];
const names = (rooms: { room: string }[]) => rooms.map((room) => room.room);

describe('rooms with the same bookings', () => {
  it('share one entry when they show the same', () => {
    const rooms = [
      { room: 'Aula I', current: [event('07:45', '20:30')], upcoming: [] },
      { room: 'Aula II', current: [event('07:45', '20:30')], upcoming: [] },
    ];
    expect(names(mergeSameBookings(rooms, all))).toEqual(['Aula I + Aula II']);
  });

  it('stay apart when the time differs', () => {
    const rooms = [
      { room: 'Aula I', current: [event('07:45', '20:30')] },
      { room: 'Aula II', current: [event('07:45', '12:00')] },
    ];
    expect(names(mergeSameBookings(rooms, all))).toEqual(['Aula I', 'Aula II']);
  });

  it('stay apart when the booking differs', () => {
    const rooms = [
      { room: 'Konf I', current: [event('08:00', '09:00')] },
      { room: 'Konf II', current: [event('08:00', '09:00', { textBooking: 'Elternabend' })] },
    ];
    expect(names(mergeSameBookings(rooms, all))).toEqual(['Konf I', 'Konf II']);
  });

  it('stay apart when what comes next differs', () => {
    const rooms = [
      { room: 'Aula I', current: [event('08:00', '09:00')], upcoming: [event('10:00', '11:00')] },
      { room: 'Aula II', current: [event('08:00', '09:00')] },
    ];
    expect(names(mergeSameBookings(rooms, all))).toEqual(['Aula I', 'Aula II']);
  });

  it('ignore later bookings the display does not show', () => {
    const rooms = [
      { room: 'Aula I', current: [event('08:00', '09:00')], upcoming: [event('10:00', '11:00')] },
      { room: 'Aula II', current: [event('08:00', '09:00')] },
    ];
    expect(names(mergeSameBookings(rooms, () => []))).toEqual(['Aula I + Aula II']);
  });

  it('share one entry when both are free now but booked together later', () => {
    const rooms = [
      { room: 'Aula I', upcoming: [event('10:00', '11:00')] },
      { room: 'Aula II', upcoming: [event('10:00', '11:00')] },
    ];
    expect(names(mergeSameBookings(rooms, all))).toEqual(['Aula I + Aula II']);
  });

  it('stay apart when both are simply free', () => {
    expect(names(mergeSameBookings([{ room: 'Konf I' }, { room: 'Konf II' }], all))).toEqual(['Konf I', 'Konf II']);
  });

  it('do not care about the order of the teachers', () => {
    const rooms = [
      { room: 'T 1.05', current: [event('08:00', '09:00', { teachers: 'Mus, Bei' })] },
      { room: 'T 1.06', current: [event('08:00', '09:00', { teachers: 'Bei, Mus' })] },
    ];
    expect(names(mergeSameBookings(rooms, all))).toEqual(['T 1.05 + T 1.06']);
  });

  it('keep the order and merge at the place of the first room', () => {
    const rooms = [
      { room: 'A', current: [event('08:00', '09:00')] },
      { room: 'B' },
      { room: 'C', current: [event('08:00', '09:00')] },
      { room: 'D', current: [event('09:00', '10:00')] },
    ];
    expect(names(mergeSameBookings(rooms, all))).toEqual(['A + C', 'B', 'D']);
  });

  it('leave the rooms passed in untouched, the next refresh needs their names', () => {
    const rooms = [{ room: 'A', current: [event('08:00', '09:00')] }, { room: 'B', current: [event('08:00', '09:00')] }];
    mergeSameBookings(rooms, all);
    expect(names(rooms)).toEqual(['A', 'B']);
  });
});
