// Test patterns a display shows on request from the admin (player testpattern.ts).
// One list for all: the server steps through it, the player draws by id.
export const TEST_PATTERNS = [
  { id: 'grid', name: 'Gitter', hint: 'Linien laufen gerade über die Nähte, Kreise sind rund' },
  { id: 'edges', name: 'Rand und Pixel', hint: 'Weißer Rahmen ganz sichtbar, Pixelfelder gleichmäßig ohne Flimmern' },
  { id: 'white', name: 'Weiß', hint: 'Pixelfehler, gleichmäßige Helligkeit, gleicher Farbton auf allen Bildschirmen' },
  { id: 'black', name: 'Schwarz', hint: 'Leuchtende Pixel, Lichthöfe an den Rändern' },
  { id: 'red', name: 'Rot', hint: 'Pixelfehler, gleiche Farbe auf allen Bildschirmen' },
  { id: 'green', name: 'Grün', hint: 'Pixelfehler, gleiche Farbe auf allen Bildschirmen' },
  { id: 'blue', name: 'Blau', hint: 'Pixelfehler, gleiche Farbe auf allen Bildschirmen' },
  { id: 'bars', name: 'Farbbalken und Graustufen', hint: 'Alle Stufen unterscheidbar, auch die dunkelsten und hellsten' },
  { id: 'motion', name: 'Bewegung', hint: 'Balken läuft gleichmäßig; Zähler auf allen Bildschirmen gleich (Foto machen)' },
  { id: 'info', name: 'Info', hint: 'Name, Feld, Auflösung, Player-Version, Uhr' },
] as const;

export type TestPatternId = (typeof TEST_PATTERNS)[number]['id'];

/** What a display shows while testing; until: server time when it ends by itself. */
export interface TestPatternState {
  index: number;
  until: number;
}
