import type { SqliteDatabase } from './db.js';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/**
 * Schema changes in the order they were introduced. Never edit a migration that has shipped.
 * Add a new one instead. CHECK constraints repeat the validation rules, so bad data cannot
 * get in even if a code path forgets to validate it.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'guild_settings',
    sql: `
      CREATE TABLE guild_settings (
        guild_id TEXT PRIMARY KEY NOT NULL,
        text_channel_id TEXT,
        panel_message_id TEXT,
        dj_role_id TEXT,
        control_policy TEXT NOT NULL DEFAULT 'everyone' CHECK (control_policy IN ('everyone', 'dj')),
        idle_timeout_sec INTEGER NOT NULL DEFAULT 300 CHECK (idle_timeout_sec BETWEEN 10 AND 3600),
        empty_timeout_sec INTEGER NOT NULL DEFAULT 60 CHECK (empty_timeout_sec BETWEEN 10 AND 600),
        queue_limit INTEGER NOT NULL DEFAULT 100 CHECK (queue_limit BETWEEN 1 AND 500),
        max_track_sec INTEGER NOT NULL DEFAULT 1800 CHECK (max_track_sec BETWEEN 60 AND 21600),
        default_volume INTEGER NOT NULL DEFAULT 70 CHECK (default_volume BETWEEN 0 AND 100),
        skip_vote_percent INTEGER NOT NULL DEFAULT 0 CHECK (skip_vote_percent BETWEEN 0 AND 100),
        allowed_sources TEXT NOT NULL DEFAULT '["local","stream"]',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `,
  },
  {
    version: 2,
    name: 'play_history',
    sql: `
      CREATE TABLE play_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        title TEXT NOT NULL,
        artist TEXT,
        source TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        requester_id TEXT NOT NULL,
        played_at INTEGER NOT NULL
      );
      CREATE INDEX idx_play_history_guild ON play_history (guild_id, id);
    `,
  },
  {
    version: 3,
    name: 'library_tracks',
    sql: `
      CREATE TABLE library_tracks (
        id TEXT PRIMARY KEY NOT NULL,
        relative_path TEXT NOT NULL UNIQUE,
        folder TEXT NOT NULL,
        title TEXT NOT NULL,
        artist TEXT,
        duration_sec REAL,
        size_bytes INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX idx_library_title ON library_tracks (title COLLATE NOCASE);
    `,
  },
  {
    version: 4,
    name: 'favorites_announce_stay',
    sql: `
      ALTER TABLE guild_settings ADD COLUMN announce_mode TEXT NOT NULL DEFAULT 'all';
      ALTER TABLE guild_settings ADD COLUMN stay_connected INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE favorites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        source TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        title TEXT NOT NULL,
        artist TEXT,
        duration_sec REAL,
        thumbnail_url TEXT,
        original_url TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE (user_id, source, source_ref)
      );
      CREATE INDEX idx_favorites_user ON favorites (user_id, id);
    `,
  },
  {
    version: 5,
    name: 'track_length_unlimited',
    // SQLite cannot change a CHECK constraint, so the table is rebuilt. 0 now means no limit.
    // Servers still on the old 30-minute default lose the limit; other values are kept.
    sql: `
      CREATE TABLE guild_settings_v5 (
        guild_id TEXT PRIMARY KEY NOT NULL,
        text_channel_id TEXT,
        panel_message_id TEXT,
        dj_role_id TEXT,
        control_policy TEXT NOT NULL DEFAULT 'everyone' CHECK (control_policy IN ('everyone', 'dj')),
        idle_timeout_sec INTEGER NOT NULL DEFAULT 300 CHECK (idle_timeout_sec BETWEEN 10 AND 3600),
        empty_timeout_sec INTEGER NOT NULL DEFAULT 60 CHECK (empty_timeout_sec BETWEEN 10 AND 600),
        queue_limit INTEGER NOT NULL DEFAULT 100 CHECK (queue_limit BETWEEN 1 AND 500),
        max_track_sec INTEGER NOT NULL DEFAULT 0
          CHECK (max_track_sec = 0 OR max_track_sec BETWEEN 60 AND 604800),
        default_volume INTEGER NOT NULL DEFAULT 70 CHECK (default_volume BETWEEN 0 AND 100),
        skip_vote_percent INTEGER NOT NULL DEFAULT 0 CHECK (skip_vote_percent BETWEEN 0 AND 100),
        allowed_sources TEXT NOT NULL DEFAULT '["local","stream"]',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        announce_mode TEXT NOT NULL DEFAULT 'all',
        stay_connected INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO guild_settings_v5 (
        guild_id, text_channel_id, panel_message_id, dj_role_id, control_policy,
        idle_timeout_sec, empty_timeout_sec, queue_limit, max_track_sec, default_volume,
        skip_vote_percent, allowed_sources, updated_at, announce_mode, stay_connected
      )
      SELECT
        guild_id, text_channel_id, panel_message_id, dj_role_id, control_policy,
        idle_timeout_sec, empty_timeout_sec, queue_limit,
        CASE WHEN max_track_sec = 1800 THEN 0 ELSE max_track_sec END,
        default_volume, skip_vote_percent, allowed_sources, updated_at, announce_mode, stay_connected
      FROM guild_settings;
      DROP TABLE guild_settings;
      ALTER TABLE guild_settings_v5 RENAME TO guild_settings;
    `,
  },
];

/**
 * Applies pending migrations in version order, each in its own transaction, and records them
 * in `schema_migrations`. Returns the versions applied by this call.
 */
export function migrate(
  db: SqliteDatabase,
  migrations: readonly Migration[] = MIGRATIONS,
): number[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
      (row) => row.version,
    ),
  );
  const pending = migrations
    .filter((migration) => !applied.has(migration.version))
    .sort((a, b) => a.version - b.version);

  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );
  const apply = db.transaction((items: readonly Migration[]) => {
    for (const migration of items) {
      db.exec(migration.sql);
      record.run(migration.version, migration.name, new Date().toISOString());
    }
  });
  apply(pending);

  return pending.map((migration) => migration.version);
}
