import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Ordered, append-only migrations. Never edit an applied entry; add a new one.
const migrations: string[] = [
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
      db.exec(migrations[i]);
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
