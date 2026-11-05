import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LibraryCatalog,
  type LibraryRow,
  type LibraryStore,
} from '../../src/audio/library/catalog.js';
import type { ProbeResult } from '../../src/audio/pipeline/probe.js';

class MemoryStore implements LibraryStore {
  rows = new Map<string, LibraryRow>();
  deleted: string[] = [];

  loadAll(): LibraryRow[] {
    return [...this.rows.values()];
  }
  save(rows: readonly LibraryRow[]): void {
    for (const row of rows) {
      this.rows.set(row.id, row);
    }
  }
  deleteIds(ids: readonly string[]): void {
    for (const id of ids) {
      this.rows.delete(id);
      this.deleted.push(id);
    }
  }
}

const PROBE: ProbeResult = { durationSec: 60, title: null, artist: null, hasAudio: true };

describe('LibraryCatalog', () => {
  let base: string;
  let musicDir: string;
  let store: MemoryStore;
  let probeCalls: string[];

  beforeEach(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), 'melody-catalog-'));
    musicDir = path.join(base, 'music');
    await mkdir(path.join(musicDir, 'Album'), { recursive: true });
    store = new MemoryStore();
    probeCalls = [];
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  function catalog(): LibraryCatalog {
    return new LibraryCatalog({
      musicDir,
      store,
      probe: (absolutePath) => {
        probeCalls.push(absolutePath);
        return Promise.resolve(PROBE);
      },
    });
  }

  it('indexes supported audio files and ignores other files and hidden entries', async () => {
    await writeFile(path.join(musicDir, 'a.mp3'), 'x');
    await writeFile(path.join(musicDir, 'Album', 'b.flac'), 'xx');
    await writeFile(path.join(musicDir, 'notes.txt'), 'x');
    await writeFile(path.join(musicDir, '.hidden.mp3'), 'x');

    const summary = await catalog().refresh();

    expect(summary.total).toBe(2);
    expect([...store.rows.values()].map((row) => row.relativePath).sort()).toEqual([
      'Album/b.flac',
      'a.mp3',
    ]);
  });

  it('probes a file only when its size or modification time changes', async () => {
    const file = path.join(musicDir, 'a.mp3');
    await writeFile(file, 'short');
    const library = catalog();

    await library.refresh();
    await library.refresh();
    expect(probeCalls).toHaveLength(1);

    await writeFile(file, 'a considerably longer payload than before');
    await library.refresh();
    expect(probeCalls).toHaveLength(2);
  });

  it('drops index entries for files that were deleted', async () => {
    await writeFile(path.join(musicDir, 'a.mp3'), 'x');
    await writeFile(path.join(musicDir, 'Album', 'b.flac'), 'xx');
    const library = catalog();
    await library.refresh();

    await rm(path.join(musicDir, 'Album', 'b.flac'));
    const summary = await library.refresh();

    expect(summary.removed).toBe(1);
    expect(summary.total).toBe(1);
    expect(store.deleted).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')(
    'does not index symlinks that lead outside the library',
    async () => {
      const outside = path.join(base, 'outside');
      await mkdir(outside, { recursive: true });
      await writeFile(path.join(outside, 'secret.mp3'), 'x');
      await symlink(path.join(outside, 'secret.mp3'), path.join(musicDir, 'linked.mp3'));

      const summary = await catalog().refresh();

      expect(summary.total).toBe(0);
    },
  );

  it('searches titles case-insensitively and ranks exact matches before partial ones', async () => {
    await writeFile(path.join(musicDir, 'Nightdream.mp3'), 'x');
    await writeFile(path.join(musicDir, 'Dream On.mp3'), 'x');
    await writeFile(path.join(musicDir, 'DREAM.mp3'), 'x');
    const library = catalog();
    await library.refresh();

    const titles = library.search('dream').map((row) => row.title);

    expect(titles).toEqual(['DREAM', 'Dream On', 'Nightdream']);
  });

  it('returns no results for an empty query', async () => {
    await writeFile(path.join(musicDir, 'a.mp3'), 'x');
    const library = catalog();
    await library.refresh();

    expect(library.search('   ')).toEqual([]);
  });
});
