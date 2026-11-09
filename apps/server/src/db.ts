import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
import { utcToLocal } from './schedule-engine.ts';

// Ordered, append-only migrations (SQL or a function for data changes).
// Never edit an applied entry; add a new one.
const migrations: Array<string | ((db: DatabaseSync) => void)> = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    transition TEXT NOT NULL DEFAULT 'fade' CHECK (transition IN ('fade', 'slide', 'none')),
    default_duration INTEGER NOT NULL DEFAULT 10,
    is_favorite INTEGER NOT NULL DEFAULT 0,
    published INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE slides (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    type TEXT NOT NULL,
    config_json TEXT NOT NULL,
    background_json TEXT,
    duration INTEGER,
    published INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE channel_slides (
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    slide_id TEXT NOT NULL REFERENCES slides(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    window_start INTEGER,
    window_end INTEGER,
    PRIMARY KEY (channel_id, position)
  );
  CREATE TABLE displays (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    default_channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
    show_progress INTEGER NOT NULL DEFAULT 1,
    orientation TEXT NOT NULL DEFAULT 'landscape' CHECK (orientation IN ('landscape', 'portrait')),
    networks TEXT NOT NULL DEFAULT '',
    last_seen_at INTEGER,
    status_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT,
    detail_json TEXT,
    at INTEGER NOT NULL
  );
  `,
  // Display tokens stay retrievable for admins: AES-GCM encrypted with a key
  // kept outside the database (token_hash remains the lookup key).
  `ALTER TABLE displays ADD COLUMN token_enc TEXT;`,
  // Calendar entries. scope "display": a channel or a single slide on displays
  // (schedule_displays); scope "channel": a slide inside its channel. Times are
  // school wall time, see schedule-engine.ts. content_id is polymorphic and
  // cleaned up by the delete endpoints.
  `
  CREATE TABLE schedules (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK (scope IN ('display', 'channel')),
    channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE,
    content_kind TEXT NOT NULL CHECK (content_kind IN ('channel', 'slide')),
    content_id TEXT NOT NULL,
    start_local TEXT NOT NULL,
    end_local TEXT,
    rrule TEXT,
    exdates_json TEXT NOT NULL DEFAULT '[]',
    overrides_json TEXT NOT NULL DEFAULT '{}',
    exclusive INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX schedules_scope ON schedules (scope, channel_id);
  CREATE INDEX schedules_content ON schedules (content_kind, content_id);
  CREATE TABLE schedule_displays (
    schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
    display_id TEXT NOT NULL REFERENCES displays(id) ON DELETE CASCADE,
    PRIMARY KEY (schedule_id, display_id)
  );
  `,
  // Slides in channels now run only by calendar. Keep what existed running:
  // every channel slide gets an entry (its old time window, or open-ended).
  (db) => {
    const rows = db.prepare('SELECT channel_id, slide_id, window_start, window_end FROM channel_slides').all() as Array<{
      channel_id: string;
      slide_id: string;
      window_start: number | null;
      window_end: number | null;
    }>;
    const insert = db.prepare(
      `INSERT INTO schedules (id, scope, channel_id, content_kind, content_id, start_local, end_local, created_at, updated_at)
       VALUES (?, 'channel', ?, 'slide', ?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    for (const row of rows) {
      const start = row.window_start ? utcToLocal(row.window_start, config.timeZone) : '2000-01-01T00:00';
      const end = row.window_end ? utcToLocal(row.window_end, config.timeZone) : null;
      insert.run(crypto.randomUUID(), row.channel_id, row.slide_id, start, end, now, now);
    }
  },
  // Media library (KONZEPT 6.2). Files live in <dataDir>/media, see media.ts;
  // sha256 is the uploaded original's and deduplicates uploads.
  `
  CREATE TABLE media (
    id TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
    name TEXT NOT NULL,
    original_ext TEXT NOT NULL,
    size INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    duration_s REAL,
    variants_json TEXT NOT NULL DEFAULT '{}',
    poster TEXT,
    thumb TEXT,
    status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'ready', 'failed')),
    error TEXT,
    uploaded_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX media_created ON media (created_at);
  `,
  // Sound only on displays that allow it, e.g. the hall, not the corridors (KONZEPT 6.2).
  `ALTER TABLE displays ADD COLUMN sound_allowed INTEGER NOT NULL DEFAULT 0;`,
  // Imports from image databases: author, source and license (media-sources.ts),
  // and whether displays show the credit line.
  `
  ALTER TABLE media ADD COLUMN source_json TEXT;
  ALTER TABLE media ADD COLUMN show_credit INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX media_source ON media (json_extract(source_json, '$.provider'), json_extract(source_json, '$.id')) WHERE source_json IS NOT NULL;
  `,
  // Display walls: a display of kind "wall" has channel and calendar like any
  // other, but no device of its own; normal displays fill the cells of its grid
  // (wall_id/row/col) and each shows its part of the wall. bezel: px between
  // the picture areas of neighbouring screens (hidden behind the frames).
  `
  ALTER TABLE displays ADD COLUMN kind TEXT NOT NULL DEFAULT 'screen' CHECK (kind IN ('screen', 'wall'));
  ALTER TABLE displays ADD COLUMN wall_rows INTEGER;
  ALTER TABLE displays ADD COLUMN wall_cols INTEGER;
  ALTER TABLE displays ADD COLUMN wall_bezel INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE displays ADD COLUMN wall_id TEXT REFERENCES displays(id) ON DELETE SET NULL;
  ALTER TABLE displays ADD COLUMN wall_row INTEGER;
  ALTER TABLE displays ADD COLUMN wall_col INTEGER;
  CREATE UNIQUE INDEX displays_wall_cell ON displays (wall_id, wall_row, wall_col) WHERE wall_id IS NOT NULL;
  `,
  // Wall modes: "span" shows one big picture across all screens; "stack" shows
  // one slide per screen, and on every change each slide moves on to the next screen.
  `
  ALTER TABLE displays ADD COLUMN wall_mode TEXT NOT NULL DEFAULT 'span' CHECK (wall_mode IN ('span', 'stack'));
  `,
  // Personal API keys (api-keys.ts), e.g. for AI assistants over MCP (mcp.ts).
  // They act with the rights of their user; only the hash is stored.
  `
  CREATE TABLE api_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    hint TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
  CREATE INDEX api_keys_user ON api_keys (user_id);
  `,
  // Which video variant a display plays: "sd" (720p) for devices that stutter at 1080p.
  `
  ALTER TABLE displays ADD COLUMN video_quality TEXT NOT NULL DEFAULT 'main' CHECK (video_quality IN ('main', 'sd'));
  `,
];

export type Db = DatabaseSync;

export function openDb(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true });
  return openDbAt(join(dataDir, 'foyer.sqlite'));
}

export function openDbAt(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: Db) {
  const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  for (let i = version; i < migrations.length; i++) {
    db.exec('BEGIN');
    try {
      const migration = migrations[i];
      if (typeof migration === 'string') db.exec(migration);
      else migration(db);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getSetting(db: Db, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(db: Db, key: string, value: string) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function audit(db: Db, userId: string | null, action: string, entity: string, entityId: string | null, detail?: unknown) {
  db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, detail_json, at) VALUES (?, ?, ?, ?, ?, ?)').run(
    userId,
    action,
    entity,
    entityId,
    detail === undefined ? null : JSON.stringify(detail),
    Date.now(),
  );
}
