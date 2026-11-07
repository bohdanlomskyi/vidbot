/**
 * Hot paths that run on the event loop for every command or playback event:
 * guild settings reads, library search (autocomplete runs it on each keystroke), and
 * how long a command waits for the guild while the next track is still loading.
 *
 *   npx tsx bench/hotpaths.bench.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { PassThrough } from 'node:stream';
import { LibraryCatalog, type LibraryRow } from '../src/audio/library/catalog.js';
import type { PlayableSource } from '../src/audio/providers/types.js';
import { openDatabase } from '../src/database/db.js';
import { migrate } from '../src/database/migrations.js';
import { GuildSettingsRepository } from '../src/database/settingsRepository.js';
import { MusicEngine } from '../src/music/engine/musicEngine.js';
import type { AudioPlayerPort, VoiceConnectionPort } from '../src/music/ports.js';

function timeOps(label: string, iterations: number, operation: (index: number) => void): void {
  for (let index = 0; index < Math.min(1_000, iterations); index += 1) {
    operation(index);
  }
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    operation(index);
  }
  const elapsed = performance.now() - started;
  console.log(
    `${label}: ${((elapsed * 1000) / iterations).toFixed(2)} µs per call (${String(iterations)} calls)`,
  );
}

function settingsBench(): void {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'melody-bench-'));
  const db = openDatabase(path.join(dir, 'bench.sqlite'));
  migrate(db);
  const settings = new GuildSettingsRepository(db, {
    queueLimit: 100,
    maxTrackSec: 1800,
    idleTimeoutSec: 300,
    emptyTimeoutSec: 60,
    defaultVolume: 70,
    allowedSources: ['local'],
  });
  const guilds = Array.from({ length: 50 }, (_unused, index) =>
    String(100000000000000000n + BigInt(index)),
  );
  timeOps('settings.get (file database, 50 guilds)', 100_000, (index) => {
    settings.get(guilds[index % guilds.length] ?? '');
  });
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

function catalogBench(): void {
  const rows: LibraryRow[] = Array.from({ length: 20_000 }, (_unused, index) => ({
    id: `lib-${index.toString(16).padStart(12, '0')}`,
    relativePath: `Artist ${String(index % 500)}/Album ${String(index % 40)}/Track ${String(index)}.mp3`,
    folder: `Artist ${String(index % 500)}/Album ${String(index % 40)}`,
    title: `Track number ${String(index)} — Song`,
    artist: `Artist ${String(index % 500)}`,
    durationSec: 200,
    sizeBytes: 1,
    mtimeMs: 1,
  }));
  const catalog = new LibraryCatalog({
    musicDir: '/nonexistent',
    store: { loadAll: () => rows, save: () => undefined, deleteIds: () => undefined },
    probe: () => Promise.reject(new Error('unused')),
  });
  const queries = ['track number 1', 'artist 42', 'song', 'zzz', 't'];
  timeOps('catalog.search (20 000 tracks, mixed queries)', 500, (index) => {
    catalog.search(queries[index % queries.length] ?? '', 15);
  });
}

/** Measures how long pause waits while the guild's next track takes `loadMs` to start. */
async function lockBench(loadMs: number): Promise<void> {
  const player: AudioPlayerPort = {
    play: () => undefined,
    stop: () => undefined,
    pause: () => undefined,
    resume: () => undefined,
    setVolume: () => undefined,
    destroy: () => undefined,
  };
  const connection: VoiceConnectionPort = {
    channelId: 'c1',
    subscribe: () => undefined,
    onLost: () => undefined,
    destroy: () => undefined,
  };
  let opened = 0;
  const engine = new MusicEngine({
    voice: { connect: () => Promise.resolve(connection) },
    createPlayer: () => player,
    providers: () => ({
      kind: 'local',
      enabled: true,
      canHandle: () => true,
      resolve: () => Promise.resolve([]),
      validate: () => Promise.resolve(),
      getPlayableStream: async (): Promise<PlayableSource> => {
        opened += 1;
        if (opened > 1) {
          await new Promise((resolve) => setTimeout(resolve, loadMs));
        }
        return {
          stream: new PassThrough(),
          ended: new Promise(() => undefined),
          close: () => Promise.resolve(),
        };
      },
      dispose: () => Promise.resolve(),
    }),
    listeners: () => 1,
    settings: () => ({
      queueLimit: 100,
      maxTrackSec: 1800,
      idleTimeoutSec: 300,
      emptyTimeoutSec: 60,
      defaultVolume: 70,
      skipVotePercent: 0,
      stayConnected: false,
    }),
    onChange: () => undefined,
  });
  const track = (title: string) => ({
    source: 'local' as const,
    sourceRef: title,
    title,
    artist: null,
    durationSec: 100,
    thumbnailUrl: null,
    originalUrl: null,
    metadata: {},
  });
  await engine.enqueue({
    guildId: 'g',
    voiceChannelId: 'c1',
    requesterId: 'u',
    tracks: [track('A'), track('B')],
  });
  // Skip to B, whose source takes loadMs to open, then ask for the queue length change.
  const skipping = engine.skip('g');
  await new Promise((resolve) => setImmediate(resolve));
  const started = performance.now();
  await engine.setVolume('g', 50);
  const waited = performance.now() - started;
  await skipping;
  console.log(
    `/volume while the next track loads for ${String(loadMs)} ms: answered after ${waited.toFixed(0)} ms`,
  );
  await engine.shutdown();
}

settingsBench();
catalogBench();
await lockBench(3_000);
