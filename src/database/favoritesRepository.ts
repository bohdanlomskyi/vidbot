import type { SourceKind, TrackDraft } from '../music/models/track.js';
import type { SqliteDatabase } from './db.js';

export type FavoriteAddResult = 'added' | 'exists' | 'full';

export interface FavoriteEntry {
  readonly id: number;
  readonly draft: TrackDraft;
}

interface FavoriteRow {
  readonly id: number;
  readonly source: string;
  readonly source_ref: string;
  readonly title: string;
  readonly artist: string | null;
  readonly duration_sec: number | null;
  readonly thumbnail_url: string | null;
  readonly original_url: string | null;
}

const SOURCES: ReadonlySet<string> = new Set<SourceKind>(['local', 'stream', 'youtube']);

/**
 * Each user's saved tracks. A favorite belongs to the user, not to a server, so it follows them
 * everywhere. It stores only what is needed to queue the track again: the source reference and
 * its display details. Never a stream address or a file path.
 */
export class FavoritesRepository {
  private readonly insert;
  private readonly count;
  private readonly selectAll;
  private readonly deleteOne;

  constructor(
    db: SqliteDatabase,
    private readonly limitPerUser: number,
  ) {
    this.insert = db.prepare(`
      INSERT OR IGNORE INTO favorites
        (user_id, source, source_ref, title, artist, duration_sec, thumbnail_url, original_url, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.count = db.prepare('SELECT COUNT(*) AS total FROM favorites WHERE user_id = ?');
    this.selectAll = db.prepare(
      `SELECT id, source, source_ref, title, artist, duration_sec, thumbnail_url, original_url
       FROM favorites WHERE user_id = ? ORDER BY id DESC`,
    );
    this.deleteOne = db.prepare('DELETE FROM favorites WHERE id = ? AND user_id = ?');
  }

  add(userId: string, draft: TrackDraft, now: number = Date.now()): FavoriteAddResult {
    const existing = this.list(userId).some(
      (item) => item.draft.source === draft.source && item.draft.sourceRef === draft.sourceRef,
    );
    if (existing) {
      return 'exists';
    }
    const { total } = this.count.get(userId) as { total: number };
    if (total >= this.limitPerUser) {
      return 'full';
    }
    this.insert.run(
      userId,
      draft.source,
      draft.sourceRef,
      draft.title,
      draft.artist,
      draft.durationSec,
      draft.thumbnailUrl,
      draft.originalUrl,
      now,
    );
    return 'added';
  }

  /** Newest first, the order the user sees and counts from. */
  list(userId: string): FavoriteEntry[] {
    return (this.selectAll.all(userId) as FavoriteRow[]).flatMap((row) =>
      SOURCES.has(row.source)
        ? [
            {
              id: row.id,
              draft: {
                source: row.source as SourceKind,
                sourceRef: row.source_ref,
                title: row.title,
                artist: row.artist,
                durationSec: row.duration_sec,
                thumbnailUrl: row.thumbnail_url,
                originalUrl: row.original_url,
                metadata: {},
              },
            },
          ]
        : [],
    );
  }

  /** Removes the favorite at a 1-based position of the list. Returns it, or null when none matches. */
  removeAt(userId: string, position: number): TrackDraft | null {
    const entry = this.list(userId)[position - 1];
    if (entry === undefined) {
      return null;
    }
    this.deleteOne.run(entry.id, userId);
    return entry.draft;
  }
}
