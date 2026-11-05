// Display walls: a grid of normal displays that together show one picture.
// The wall is a display of kind "wall" (channel, calendar, settings); its
// screens point to it via wall_id/row/col. See manifest.ts and player wall.ts.
import { transaction, type Db } from './db.ts';

export const MAX_WALL_SIDE = 4;

export interface Cell {
  displayId: string;
  row: number;
  col: number;
}

interface WallRow {
  id: string;
  kind: string;
  wall_rows: number | null;
  wall_cols: number | null;
}

/** The screens of a wall. */
export function wallScreens(db: Db, wallId: string): Array<{ id: string; name: string; row: number; col: number }> {
  return db
    .prepare('SELECT id, name, wall_row AS row, wall_col AS col FROM displays WHERE wall_id = ? ORDER BY wall_row, wall_col')
    .all(wallId) as Array<{ id: string; name: string; row: number; col: number }>;
}

/** Who has to hear about a change to this display: itself and, for a wall, its screens. */
export function affectedDisplays(db: Db, displayId: string): string[] {
  return [displayId, ...wallScreens(db, displayId).map((screen) => screen.id)];
}

/**
 * Replaces the screens of a wall. Throws a message for the admin when a cell
 * is outside the grid or taken twice, or a display is a wall or already in
 * another wall. Returns every display whose manifest changed.
 */
export function setWallCells(db: Db, wallId: string, cells: Cell[], now: number): string[] {
  const wall = db.prepare('SELECT id, kind, wall_rows, wall_cols FROM displays WHERE id = ?').get(wallId) as WallRow | undefined;
  if (!wall || wall.kind !== 'wall') throw new WallError('Wand nicht gefunden', 404);
  const rows = wall.wall_rows ?? 1;
  const cols = wall.wall_cols ?? 1;
  const taken = new Set<string>();
  const ids = new Set<string>();
  const lookup = db.prepare('SELECT id, name, kind, wall_id FROM displays WHERE id = ?');
  for (const cell of cells) {
    if (cell.row < 0 || cell.row >= rows || cell.col < 0 || cell.col >= cols) throw new WallError('Feld liegt außerhalb des Rasters');
    const key = `${cell.row}:${cell.col}`;
    if (taken.has(key)) throw new WallError('Ein Feld ist doppelt belegt');
    if (ids.has(cell.displayId)) throw new WallError('Ein Display kann nur ein Feld belegen');
    taken.add(key);
    ids.add(cell.displayId);
    const display = lookup.get(cell.displayId) as { id: string; name: string; kind: string; wall_id: string | null } | undefined;
    if (!display) throw new WallError('Display nicht gefunden');
    if (display.kind === 'wall') throw new WallError('Eine Wand kann nicht Teil einer Wand sein');
    if (display.wall_id && display.wall_id !== wallId) throw new WallError(`„${display.name}“ ist schon Teil einer anderen Wand`);
  }

  const before = wallScreens(db, wallId);
  transaction(db, () => {
    // Cleared first: the unique (wall, row, col) index would trip over swaps.
    db.prepare('UPDATE displays SET wall_id = NULL, wall_row = NULL, wall_col = NULL, updated_at = ? WHERE wall_id = ?').run(now, wallId);
    const place = db.prepare('UPDATE displays SET wall_id = ?, wall_row = ?, wall_col = ?, updated_at = ? WHERE id = ?');
    for (const cell of cells) place.run(wallId, cell.row, cell.col, now, cell.displayId);
  });
  return [...new Set([...before.map((screen) => screen.id), ...ids])];
}

/** Screens outside a smaller grid leave the wall; returns them. */
export function trimWall(db: Db, wallId: string, rows: number, cols: number, now: number): string[] {
  const outside = wallScreens(db, wallId).filter((screen) => screen.row >= rows || screen.col >= cols);
  const leave = db.prepare('UPDATE displays SET wall_id = NULL, wall_row = NULL, wall_col = NULL, updated_at = ? WHERE id = ?');
  for (const screen of outside) leave.run(now, screen.id);
  return outside.map((screen) => screen.id);
}

export class WallError extends Error {
  status: 400 | 404;
  constructor(message: string, status: 400 | 404 = 400) {
    super(message);
    this.status = status;
  }
}
