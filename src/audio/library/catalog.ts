import path from 'node:path';
import { libraryTrackId, parseRelativeLibraryPath } from '../../security/libraryPaths.js';
import { Semaphore } from '../../utils/async.js';
import type { ProbeResult } from '../pipeline/probe.js';
import { type LibraryFileInfo, scanLibrary } from './scanner.js';

export interface LibraryRow {
  readonly id: string;
  readonly relativePath: string;
  readonly folder: string;
  readonly title: string;
  readonly artist: string | null;
  readonly durationSec: number | null;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

/** Persistence port for the catalog. The SQLite implementation lives in src/database. */
export interface LibraryStore {
  loadAll(): LibraryRow[];
  save(rows: readonly LibraryRow[]): void;
  deleteIds(ids: readonly string[]): void;
}

export type LibraryProber = (absolutePath: string) => Promise<ProbeResult>;

export interface RefreshSummary {
  readonly scanned: number;
  readonly updated: number;
  readonly removed: number;
  readonly total: number;
  readonly truncated: boolean;
}

export interface LibraryCatalogOptions {
  readonly musicDir: string;
  readonly store: LibraryStore;
  readonly probe: LibraryProber;
  readonly probeConcurrency?: number;
}

/** A row with its search text lowered once, instead of on every keystroke of autocomplete. */
interface IndexedRow {
  readonly row: LibraryRow;
  readonly title: string;
  readonly text: string;
}

const collator = new Intl.Collator();

function indexed(row: LibraryRow): IndexedRow {
  const title = row.title.toLowerCase();
  const text = [title, row.artist?.toLowerCase() ?? '', row.relativePath.toLowerCase()].join('\n');
  return { row, title, text };
}

/**
 * The in-memory index of the music library, kept in step with the store. A file is
 * probed again only when its size or modification time changes. Concurrent refreshes
 * share one run.
 */
export class LibraryCatalog {
  private readonly index = new Map<string, IndexedRow>();
  /** The index in title order, rebuilt lazily after the index changes. */
  private byTitle: IndexedRow[] | null = null;
  private running: Promise<RefreshSummary> | undefined;

  constructor(private readonly options: LibraryCatalogOptions) {
    for (const row of options.store.loadAll()) {
      this.index.set(row.id, indexed(row));
    }
  }

  get size(): number {
    return this.index.size;
  }

  get(id: string): LibraryRow | undefined {
    return this.index.get(id)?.row;
  }

  /**
   * Finds tracks whose title, artist or path contains the query. Results are ranked:
   * exact title, then title prefix, then any other match, alphabetically within a rank.
   * One pass over the index in title order fills the ranks, so nothing is sorted per query.
   */
  search(query: string, limit = 10): LibraryRow[] {
    const needle = query.trim().toLowerCase().replace(/\s+/g, ' ');
    if (needle === '' || limit <= 0) {
      return [];
    }

    const exact: LibraryRow[] = [];
    const prefix: LibraryRow[] = [];
    const other: LibraryRow[] = [];
    for (const entry of this.sortedByTitle()) {
      if (entry.title === needle) {
        exact.push(entry.row);
      } else if (entry.title.startsWith(needle)) {
        if (prefix.length < limit) {
          prefix.push(entry.row);
        }
      } else if (other.length < limit && entry.text.includes(needle)) {
        other.push(entry.row);
      }
    }
    return [...exact, ...prefix, ...other].slice(0, limit);
  }

  private sortedByTitle(): readonly IndexedRow[] {
    this.byTitle ??= [...this.index.values()].sort((a, b) =>
      collator.compare(a.row.title, b.row.title),
    );
    return this.byTitle;
  }

  refresh(): Promise<RefreshSummary> {
    this.running ??= this.runRefresh().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async runRefresh(): Promise<RefreshSummary> {
    const { files, truncated } = await scanLibrary(this.options.musicDir);
    const seen = new Set<string>();
    const changed: LibraryRow[] = [];
    const limiter = new Semaphore(this.options.probeConcurrency ?? 2);

    await Promise.all(
      files.map((file) =>
        limiter.use(async () => {
          const id = libraryTrackId(file.relativePath);
          seen.add(id);

          const existing = this.index.get(id);
          if (
            existing !== undefined &&
            existing.row.sizeBytes === file.sizeBytes &&
            existing.row.mtimeMs === file.mtimeMs
          ) {
            return;
          }
          const row = await this.buildRow(file, id).catch(() => null);
          if (row !== null) {
            this.index.set(id, indexed(row));
            this.byTitle = null;
            changed.push(row);
          }
        }),
      ),
    );

    const removedIds = [...this.index.keys()].filter((id) => !seen.has(id));
    for (const id of removedIds) {
      this.index.delete(id);
      this.byTitle = null;
    }
    if (removedIds.length > 0) {
      this.options.store.deleteIds(removedIds);
    }
    if (changed.length > 0) {
      this.options.store.save(changed);
    }

    return {
      scanned: files.length,
      updated: changed.length,
      removed: removedIds.length,
      total: this.index.size,
      truncated,
    };
  }

  private async buildRow(file: LibraryFileInfo, id: string): Promise<LibraryRow> {
    const probe = await this.options.probe(file.absolutePath);
    if (!probe.hasAudio) {
      throw new Error('File has no audio stream');
    }
    const relative = parseRelativeLibraryPath(file.relativePath);
    if (relative === null) {
      throw new Error('Unsafe library path');
    }

    const stem = path.posix.basename(relative, path.posix.extname(relative));
    const folder = path.posix.dirname(relative);
    return {
      id,
      relativePath: relative,
      folder: folder === '.' ? '' : folder,
      title: probe.title ?? (stem.replace(/_+/g, ' ').trim() || relative),
      artist: probe.artist,
      durationSec: probe.durationSec,
      sizeBytes: file.sizeBytes,
      mtimeMs: file.mtimeMs,
    };
  }
}
