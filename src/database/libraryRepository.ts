import type { LibraryRow, LibraryStore } from '../audio/library/catalog.js';
import type { SqliteDatabase } from './db.js';

interface LibraryDbRow {
  readonly id: string;
  readonly relative_path: string;
  readonly folder: string;
  readonly title: string;
  readonly artist: string | null;
  readonly duration_sec: number | null;
  readonly size_bytes: number;
  readonly mtime_ms: number;
}

/** Persists the music library index so restarts do not re-probe every file. */
export class LibraryRepository implements LibraryStore {
  private readonly upsert;
  private readonly remove;
  private readonly selectAll;

  constructor(private readonly db: SqliteDatabase) {
    this.upsert = db.prepare(`
      INSERT INTO library_tracks
        (id, relative_path, folder, title, artist, duration_sec, size_bytes, mtime_ms, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT (id) DO UPDATE SET
        relative_path = excluded.relative_path,
        folder = excluded.folder,
        title = excluded.title,
        artist = excluded.artist,
        duration_sec = excluded.duration_sec,
        size_bytes = excluded.size_bytes,
        mtime_ms = excluded.mtime_ms,
        updated_at = excluded.updated_at
    `);
    this.remove = db.prepare('DELETE FROM library_tracks WHERE id = ?');
    this.selectAll = db.prepare(
      'SELECT id, relative_path, folder, title, artist, duration_sec, size_bytes, mtime_ms FROM library_tracks',
    );
  }

  loadAll(): LibraryRow[] {
    return (this.selectAll.all() as LibraryDbRow[]).map((row) => ({
      id: row.id,
      relativePath: row.relative_path,
      folder: row.folder,
      title: row.title,
      artist: row.artist,
      durationSec: row.duration_sec,
      sizeBytes: row.size_bytes,
      mtimeMs: row.mtime_ms,
    }));
  }

  save(rows: readonly LibraryRow[]): void {
    const write = this.db.transaction((items: readonly LibraryRow[]) => {
      for (const row of items) {
        this.upsert.run(
          row.id,
          row.relativePath,
          row.folder,
          row.title,
          row.artist,
          row.durationSec,
          row.sizeBytes,
          row.mtimeMs,
        );
      }
    });
    write(rows);
  }

  deleteIds(ids: readonly string[]): void {
    const write = this.db.transaction((items: readonly string[]) => {
      for (const id of items) {
        this.remove.run(id);
      }
    });
    write(ids);
  }
}
