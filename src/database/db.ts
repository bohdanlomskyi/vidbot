import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type SqliteDatabase = Database.Database;

const MEMORY = ':memory:';

/**
 * Opens a SQLite database with the settings the bot relies on: write-ahead logging for
 * file databases, enforced foreign keys, and a busy timeout so brief lock contention does
 * not fail a command. The parent directory of a file database is created if missing.
 */
export function openDatabase(file: string): SqliteDatabase {
  if (file !== MEMORY) {
    mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new Database(file);
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  if (file !== MEMORY) {
    db.pragma('journal_mode = WAL');
  }
  return db;
}

export interface DatabaseCheck {
  readonly ok: boolean;
  readonly detail: string;
}

/** Runs SQLite's quick integrity check. It reads the whole file, so use it at startup and in diagnostics. */
export function checkDatabase(db: SqliteDatabase): DatabaseCheck {
  const detail = String(db.pragma('quick_check', { simple: true }));
  return { ok: detail === 'ok', detail };
}
