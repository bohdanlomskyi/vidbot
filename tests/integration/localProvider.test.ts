import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LibraryCatalog,
  type LibraryRow,
  type LibraryStore,
} from '../../src/audio/library/catalog.js';
import { LocalAudioProvider } from '../../src/audio/providers/localProvider.js';
import { probeAudioFile } from '../../src/audio/pipeline/probe.js';
import type { Track } from '../../src/music/models/track.js';
import { countBytes, createSineFixture } from '../helpers/ffmpeg.js';

const FFMPEG = process.env.MELODY_FFMPEG_PATH ?? 'ffmpeg';
const FFPROBE = process.env.MELODY_FFPROBE_PATH ?? 'ffprobe';
const BYTES_PER_SECOND = 48_000 * 2 * 2;

class MemoryStore implements LibraryStore {
  private rows = new Map<string, LibraryRow>();
  loadAll(): LibraryRow[] {
    return [...this.rows.values()];
  }
  save(rows: readonly LibraryRow[]): void {
    for (const row of rows) this.rows.set(row.id, row);
  }
  deleteIds(ids: readonly string[]): void {
    for (const id of ids) this.rows.delete(id);
  }
}

function trackFor(id: string): Track {
  return {
    id: 'queue-entry-1',
    source: 'local',
    sourceRef: id,
    title: 'Tone One',
    artist: null,
    durationSec: 2,
    thumbnailUrl: null,
    originalUrl: null,
    requesterId: 'user-1',
    createdAt: 0,
    metadata: {},
  };
}

describe('LocalAudioProvider with a real library and FFmpeg', () => {
  let base: string;
  let musicDir: string;
  let catalog: LibraryCatalog;
  let provider: LocalAudioProvider;

  beforeAll(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), 'melody-local-'));
    musicDir = path.join(base, 'music');
    await mkdir(path.join(musicDir, 'Album'), { recursive: true });
    await createSineFixture(FFMPEG, path.join(musicDir, 'Album', 'Tone One.wav'), 2);

    catalog = new LibraryCatalog({
      musicDir,
      store: new MemoryStore(),
      probe: (file) => probeAudioFile(FFPROBE, file),
    });
    provider = new LocalAudioProvider({ catalog, musicDir, ffmpegPath: FFMPEG });
    await catalog.refresh();
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('indexes the file with its name as title and its real duration from ffprobe', () => {
    const [row] = catalog.search('tone one');

    expect(row?.title).toBe('Tone One');
    expect(row?.durationSec).toBeCloseTo(2, 1);
  });

  it('resolves a text query and the internal identifier to the same track', async () => {
    const [byText] = await provider.resolve('tone one', { signal: new AbortController().signal });
    const id = byText?.sourceRef ?? '';
    const [byId] = await provider.resolve(id, { signal: new AbortController().signal });

    expect(id).toMatch(/^lib-[0-9a-f]{12}$/);
    expect(byId?.sourceRef).toBe(id);
  });

  it('reports unknown text and path-like input as not found without touching the file system', async () => {
    const signal = new AbortController().signal;

    await expect(provider.resolve('no such song', { signal })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(provider.resolve('../../etc/passwd', { signal })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('streams the indexed file as PCM of the expected length', async () => {
    const [resolved] = await provider.resolve('tone one', {
      signal: new AbortController().signal,
    });
    const track = trackFor(resolved?.sourceRef ?? '');

    const playable = await provider.getPlayableStream(track, new AbortController().signal);
    const bytes = await countBytes(playable.stream);
    await playable.close();

    expect(Math.abs(bytes - 2 * BYTES_PER_SECOND)).toBeLessThan(BYTES_PER_SECOND / 100);
  });
});
