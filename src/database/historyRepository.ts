import type { SqliteDatabase } from './db.js';

export interface HistoryEntryInput {
  readonly title: string;
  readonly artist: string | null;
  readonly source: string;
  readonly sourceRef: string;
  readonly requesterId: string;
  readonly playedAt: number;
}

export type HistoryEntry = HistoryEntryInput;

interface HistoryRow {
  readonly title: string;
  readonly artist: string | null;
  readonly source: string;
  readonly source_ref: string;
  readonly requester_id: string;
  readonly played_at: number;
}

/**
 * Recently played tracks per guild. Each guild keeps at most `retention` entries, and older
 * entries are trimmed as new ones arrive. Entries are never shared between guilds.
 */
export class HistoryRepository {
  private readonly insert;
  private readonly trim;
  private readonly selectRecent;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly retention: number,
  ) {
    this.insert = db.prepare(`
      INSERT INTO play_history (guild_id, title, artist, source, source_ref, requester_id, played_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.trim = db.prepare(`
      DELETE FROM play_history
      WHERE guild_id = ? AND id NOT IN (
        SELECT id FROM play_history WHERE guild_id = ? ORDER BY id DESC LIMIT ?
      )
    `);
    this.selectRecent = db.prepare(`
      SELECT title, artist, source, source_ref, requester_id, played_at
      FROM play_history WHERE guild_id = ? ORDER BY id DESC LIMIT ?
    `);
  }

  add(guildId: string, entry: HistoryEntryInput): void {
    const write = this.db.transaction(() => {
      this.insert.run(
        guildId,
        entry.title,
        entry.artist,
        entry.source,
        entry.sourceRef,
        entry.requesterId,
        entry.playedAt,
      );
      this.trim.run(guildId, guildId, this.retention);
    });
    write();
  }

  recent(guildId: string, limit: number): HistoryEntry[] {
    return (this.selectRecent.all(guildId, limit) as HistoryRow[]).map((row) => ({
      title: row.title,
      artist: row.artist,
      source: row.source,
      sourceRef: row.source_ref,
      requesterId: row.requester_id,
      playedAt: row.played_at,
    }));
  }
}
