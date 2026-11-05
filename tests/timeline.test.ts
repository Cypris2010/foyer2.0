import { describe, expect, it } from 'vitest';
import { catchUpRate, slotAt, videoTarget } from '../apps/player/src/timeline.ts';
import { bestOffset } from '../apps/player/src/clock.ts';

describe('Fester Zeitplan', () => {
  const durations = [10, 5, 15]; // Schleife: 30 s
  const loop = Date.parse('2026-11-05T10:00:00Z'); // durch 30 s teilbar

  it('leitet die Folie allein aus der Uhrzeit ab', () => {
    expect(slotAt(durations, loop)).toEqual({ index: 0, start: loop, end: loop + 10_000 });
    expect(slotAt(durations, loop + 9_999)?.index).toBe(0);
    expect(slotAt(durations, loop + 10_000)).toEqual({ index: 1, start: loop + 10_000, end: loop + 15_000 });
    expect(slotAt(durations, loop + 29_000)).toEqual({ index: 2, start: loop + 15_000, end: loop + 30_000 });
    expect(slotAt(durations, loop + 30_000)?.index).toBe(0);
  });

  it('zeigt auf zwei Displays mit derselben Uhr dieselbe Folie', () => {
    for (const t of [loop + 1, loop + 12_345, loop + 86_400_000 + 17_000]) {
      expect(slotAt([...durations], t)).toEqual(slotAt(durations, t));
    }
  });

  it('kommt ohne Folien und mit Kurzfolien zurecht', () => {
    expect(slotAt([], loop)).toBeNull();
    // Mindestens 1 s pro Folie, sonst wechselt der Player im Millisekundentakt.
    expect(slotAt([0, 0], loop + 1_500)).toEqual({ index: 1, start: loop + 1_000, end: loop + 2_000 });
    // Bruchteile von Sekunden (Videolänge)
    const video = slotAt([12.4], loop)!;
    expect(video.start % 12_400).toBe(0);
    expect(video.end - video.start).toBe(12_400);
  });
});

describe('Videos an der Uhr', () => {
  it('rechnet die Sollposition aus', () => {
    expect(videoTarget(3, 10, false)).toBe(3);
    expect(videoTarget(12, 10, false)).toBeNull();
    expect(videoTarget(23, 10, true)).toBe(3);
    expect(videoTarget(4, NaN, false)).toBe(4);
  });

  it('holt kleine Abstände über die Geschwindigkeit auf', () => {
    expect(catchUpRate(0.02)).toBe(1);
    expect(catchUpRate(0.1)).toBeCloseTo(0.95);
    expect(catchUpRate(-0.06)).toBeCloseTo(1.03);
    // nie mehr als 5 % schneller oder langsamer
    expect(catchUpRate(0.8)).toBeCloseTo(0.95);
    expect(catchUpRate(-0.8)).toBeCloseTo(1.05);
  });
});

describe('Server-Uhr', () => {
  it('nimmt die Messung mit der kürzesten Laufzeit', () => {
    // Gerät 5 s hinter dem Server; die zweite Antwort kam schnell zurück.
    const samples = [
      { sentAt: 1_000, receivedAt: 1_400, serverNow: 6_100 },
      { sentAt: 2_000, receivedAt: 2_020, serverNow: 7_010 },
      { sentAt: 3_000, receivedAt: 3_300, serverNow: 8_050 },
    ];
    expect(bestOffset(samples)).toBe(5_000);
    expect(bestOffset([])).toBeNull();
  });
});
