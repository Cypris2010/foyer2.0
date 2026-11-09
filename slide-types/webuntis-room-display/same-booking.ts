// Rooms that show exactly the same bookings share one card or tile, e.g. Aula I and Aula II
// during an assembly. Not part of the wp-foyer port.

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

/** Which of a room's upcoming bookings its card or tile shows. */
export type ShownUpcoming = (upcoming: RoomEvent[]) => RoomEvent[];

const signature = (event: RoomEvent) =>
  JSON.stringify([
    event.startDate.getTime(),
    event.endDate.getTime(),
    event.title ?? '',
    (event.teachers ?? '').split(/,\s*/).sort(),
    event.type ?? '',
    event.textSubstitute ?? '',
    event.textBooking ?? '',
    Boolean(event.cancelled),
  ]);

/**
 * Merges rooms whose card would say the same, at the place of the first of them. Rooms with
 * nothing to show stay apart: being free together is not a shared booking.
 */
export function mergeSameBookings<T extends RoomData>(rooms: T[], shownUpcoming: ShownUpcoming): T[] {
  const merged: T[] = [];
  const byBookings = new Map<string, T>();
  for (const room of rooms) {
    const current = (room.current ?? []).map(signature);
    const upcoming = shownUpcoming(room.upcoming ?? []).map(signature);
    if (!current.length && !upcoming.length) {
      merged.push(room);
      continue;
    }
    const key = JSON.stringify([current, upcoming]);
    const first = byBookings.get(key);
    if (first) {
      first.room = `${first.room} + ${room.room}`;
    } else {
      const copy = { ...room };
      byBookings.set(key, copy);
      merged.push(copy);
    }
  }
  return merged;
}
