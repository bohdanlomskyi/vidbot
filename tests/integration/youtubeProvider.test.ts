import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Track } from '../../src/music/models/track.js';
import {
  YouTubeExperimentalProvider,
  type YouTubeProviderOptions,
} from '../../src/audio/providers/youtubeProvider.js';
import { MusicEngine } from '../../src/music/engine/musicEngine.js';
import { countBytes, createSineFixture, isProcessRunning } from '../helpers/ffmpeg.js';
import { DEFAULT_SETTINGS, FakePlayer, FakeVoice } from '../helpers/fakeMusic.js';

const FFMPEG = process.env.MELODY_FFMPEG_PATH ?? 'ffmpeg';
const BYTES_PER_SECOND = 48_000 * 2 * 2;

// A stand-in for yt-dlp. It records every invocation (arguments and PID), prints JSON and
// stderr the way yt-dlp does, and streams a local WAV for playback. It never touches the
// network, so the provider's real process handling, argument handling and error paths run
// without any YouTube traffic.
const FAKE_YTDLP = `#!/usr/bin/env node
import { appendFileSync, createReadStream } from 'node:fs';

const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_YTDLP_LOG, JSON.stringify({ pid: process.pid, args }) + '\\n');

const target = args.at(-1) ?? '';
const videoId = (/[?&]v=([^&]+)/.exec(target) ?? [])[1] ?? '';
const streaming = args.includes('-o');
const fail = (message) => { process.stderr.write('ERROR: ' + message + '\\n'); process.exit(1); };
process.stdout.on('error', () => process.exit(0));

if (videoId.startsWith('PRIVATE')) fail('[youtube] ' + videoId + ': Private video. Sign in if you have been granted access');
else if (videoId.startsWith('RATE')) fail('unable to download video data: HTTP Error 429: Too Many Requests');
else if (videoId.startsWith('SLOW')) setTimeout(() => {}, 60000);
else if (args.includes('--flat-playlist')) {
  process.stdout.write(JSON.stringify({ _type: 'playlist', entries: [
    { id: 'AAAAAAAAAAA', title: 'One', duration: 60 },
    { id: 'BBBBBBBBBBB', title: 'Two', duration: 70 },
  ] }));
} else if (streaming && videoId.startsWith('LATE')) {
  setTimeout(() => createReadStream(process.env.FAKE_YTDLP_AUDIO).pipe(process.stdout), 2500);
} else if (streaming) {
  createReadStream(process.env.FAKE_YTDLP_AUDIO).pipe(process.stdout);
} else {
  const live = videoId.startsWith('LIVE');
  const duration = videoId.startsWith('LONG') ? 7200 : 212;
  process.stdout.write(JSON.stringify({ id: videoId, title: 'Fake ' + videoId, uploader: 'Fake Channel',
    duration: live ? null : duration, live_status: live ? 'is_live' : 'not_live', is_live: live,
    availability: 'public', thumbnail: null }));
}
`;

interface Invocation {
  readonly pid: number;
  readonly args: readonly string[];
}

describe.skipIf(process.platform === 'win32')(
  'YouTubeExperimentalProvider with a stand-in yt-dlp',
  () => {
    let dir: string;
    let fakeBinary: string;
    let logFile: string;
    let audioFile: string;
    let previousLog: string | undefined;
    let previousAudio: string | undefined;

    beforeAll(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'melody-youtube-'));
      fakeBinary = path.join(dir, 'fake-yt-dlp.mjs');
      logFile = path.join(dir, 'invocations.log');
      audioFile = path.join(dir, 'tone.wav');
      await writeFile(fakeBinary, FAKE_YTDLP);
      await chmod(fakeBinary, 0o755);
      await createSineFixture(FFMPEG, audioFile, 2);
      previousLog = process.env.FAKE_YTDLP_LOG;
      previousAudio = process.env.FAKE_YTDLP_AUDIO;
      process.env.FAKE_YTDLP_LOG = logFile;
      process.env.FAKE_YTDLP_AUDIO = audioFile;
    });

    afterAll(async () => {
      restoreEnv('FAKE_YTDLP_LOG', previousLog);
      restoreEnv('FAKE_YTDLP_AUDIO', previousAudio);
      await rm(dir, { recursive: true, force: true });
    });

    async function invocations(): Promise<Invocation[]> {
      const text = await readFile(logFile, 'utf8').catch(() => '');
      return text
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Invocation);
    }

    function providerWith(
      overrides: Partial<YouTubeProviderOptions> = {},
    ): YouTubeExperimentalProvider {
      return new YouTubeExperimentalProvider({
        enabled: true,
        ytdlpPath: fakeBinary,
        jsRuntime: 'node',
        cacheDir: path.join(dir, 'cache'),
        ffmpegPath: FFMPEG,
        maxDurationSec: 900,
        playlistMaxItems: 25,
        maxConcurrency: 2,
        timeoutSec: 1,
        breakerThreshold: 2,
        breakerCooldownMs: 60_000,
        ...overrides,
      });
    }

    function trackFor(id: string): Track {
      return {
        id: `queue-${id}`,
        source: 'youtube',
        sourceRef: id,
        title: id,
        artist: null,
        durationSec: 212,
        thumbnailUrl: null,
        originalUrl: `https://www.youtube.com/watch?v=${id}`,
        requesterId: 'user-1',
        createdAt: 0,
        metadata: {},
      };
    }

    const signal = (): AbortSignal => new AbortController().signal;

    it('resolves a video link into a track with the canonical URL and parsed metadata', async () => {
      const [draft] = await providerWith().resolve('https://youtu.be/AAAAAAAAAAA', {
        signal: signal(),
      });

      expect(draft).toMatchObject({
        source: 'youtube',
        sourceRef: 'AAAAAAAAAAA',
        title: 'Fake AAAAAAAAAAA',
        artist: 'Fake Channel',
        durationSec: 212,
        originalUrl: 'https://www.youtube.com/watch?v=AAAAAAAAAAA',
      });
    });

    it('expands a playlist and honours the configured item limit', async () => {
      const playlist = 'https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf';

      const all = await providerWith().resolve(playlist, { signal: signal() });
      const limited = await providerWith({ playlistMaxItems: 1 }).resolve(playlist, {
        signal: signal(),
      });

      expect(all.map((draft) => draft.sourceRef)).toEqual(['AAAAAAAAAAA', 'BBBBBBBBBBB']);
      expect(limited.map((draft) => draft.sourceRef)).toEqual(['AAAAAAAAAAA']);
    });

    it('reports a private video without letting it switch the whole provider off', async () => {
      const provider = providerWith({ breakerThreshold: 1 });

      await expect(
        provider.resolve('https://www.youtube.com/watch?v=PRIVATE0001', { signal: signal() }),
      ).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
      await expect(
        provider.resolve('https://www.youtube.com/watch?v=AAAAAAAAAAA', { signal: signal() }),
      ).resolves.toHaveLength(1);
    });

    it('refuses videos longer than the configured limit and live broadcasts', async () => {
      const provider = providerWith();

      await expect(
        provider.resolve('https://www.youtube.com/watch?v=LONG0000001', { signal: signal() }),
      ).rejects.toMatchObject({ code: 'TRACK_TOO_LONG' });
      await expect(
        provider.resolve('https://www.youtube.com/watch?v=LIVE0000001', { signal: signal() }),
      ).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    });

    it('plays the audio through FFmpeg, reports completion, and passes only canonical URLs to yt-dlp', async () => {
      const provider = providerWith();
      const playable = await provider.getPlayableStream(trackFor('AAAAAAAAAAA'), signal());
      const bytes = await countBytes(playable.stream);

      expect(await playable.ended).toEqual({ status: 'completed' });
      expect(Math.abs(bytes - 2 * BYTES_PER_SECOND)).toBeLessThan(BYTES_PER_SECOND / 100);

      const streamCall = (await invocations()).findLast((call) => call.args.includes('-o'));
      expect(streamCall?.args.at(-1)).toBe('https://www.youtube.com/watch?v=AAAAAAAAAAA');
      expect(streamCall?.args).toEqual(expect.arrayContaining(['--ignore-config', '--no-update']));
    });

    it('stops yt-dlp when playback is closed, leaving no process behind', async () => {
      const playable = await providerWith().getPlayableStream(trackFor('AAAAAAAAAAA'), signal());
      const pid = (await invocations()).findLast((call) => call.args.includes('-o'))?.pid;
      expect(pid).toBeDefined();

      await playable.close();
      await playable.ended;

      expect(pid !== undefined && isProcessRunning(pid)).toBe(false);
    });

    it('opens the circuit after repeated rate limits and refuses without starting yt-dlp', async () => {
      const provider = providerWith({ breakerThreshold: 2 });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(
          provider.resolve('https://www.youtube.com/watch?v=RATE0000001', { signal: signal() }),
        ).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
      }
      const before = (await invocations()).length;

      await expect(
        provider.resolve('https://www.youtube.com/watch?v=AAAAAAAAAAA', { signal: signal() }),
      ).rejects.toMatchObject({ code: 'SOURCE_DISABLED' });
      expect((await invocations()).length).toBe(before);
    });

    it('kills yt-dlp when a metadata request exceeds the timeout', async () => {
      const started = Date.now();

      await expect(
        providerWith({ timeoutSec: 1 }).resolve('https://www.youtube.com/watch?v=SLOW0000001', {
          signal: signal(),
        }),
      ).rejects.toMatchObject({ code: 'TIMEOUT' });

      const elapsed = Date.now() - started;
      const pid = (await invocations()).findLast(
        (call) => call.args.includes('SLOW0000001') || call.args.at(-1)?.includes('SLOW0000001'),
      )?.pid;
      expect(elapsed).toBeLessThan(10_000);
      expect(pid !== undefined && isProcessRunning(pid)).toBe(false);
    });

    it('never starts yt-dlp when the provider is disabled', async () => {
      const before = (await invocations()).length;

      await expect(
        providerWith({ enabled: false }).resolve('https://www.youtube.com/watch?v=AAAAAAAAAAA', {
          signal: signal(),
        }),
      ).rejects.toMatchObject({ code: 'SOURCE_DISABLED' });
      expect((await invocations()).length).toBe(before);
    });

    it('frees the concurrency slot when a stream finishes, even if the caller never closes it', async () => {
      const provider = providerWith({ maxConcurrency: 1 });
      const finished = await provider.getPlayableStream(trackFor('AAAAAAAAAAA'), signal());
      await countBytes(finished.stream);
      expect(await finished.ended).toEqual({ status: 'completed' });

      const next = await provider.getPlayableStream(trackFor('BBBBBBBBBBB'), signal());
      await countBytes(next.stream);
      await next.close();
    });

    it('waits for a free slot before starting a second stream', async () => {
      const provider = providerWith({ maxConcurrency: 1 });
      const first = await provider.getPlayableStream(trackFor('AAAAAAAAAAA'), signal());

      let secondOpened = false;
      const second = provider
        .getPlayableStream(trackFor('BBBBBBBBBBB'), signal())
        .then((playable) => {
          secondOpened = true;
          return playable;
        });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(secondOpened).toBe(false);

      await first.close();
      const playable = await second;
      expect(secondOpened).toBe(true);
      await playable.close();
    });

    it('stops waiting for a stream slot when the track is cancelled, and never starts yt-dlp for it', async () => {
      const provider = providerWith({ maxConcurrency: 1 });
      const first = await provider.getPlayableStream(trackFor('AAAAAAAAAAA'), signal());
      const controller = new AbortController();

      const waiting = provider.getPlayableStream(trackFor('CCCCCCCCCCC'), controller.signal);
      controller.abort();
      await expect(waiting).rejects.toMatchObject({ code: 'CANCELLED' });
      await first.close();
      await new Promise((resolve) => setTimeout(resolve, 200));

      const started = (await invocations()).filter((call) => call.args.includes('-o'));
      expect(started.some((call) => call.args.at(-1)?.includes('CCCCCCCCCCC'))).toBe(false);
    });

    it('leaves no process behind and frees the slot when the engine gives up on a slow start', async () => {
      const provider = providerWith({ maxConcurrency: 1, timeoutSec: 30 });
      const engine = new MusicEngine({
        voice: new FakeVoice(),
        createPlayer: () => new FakePlayer(),
        providers: (kind) => (kind === 'youtube' ? provider : undefined),
        listeners: () => 1,
        settings: () => DEFAULT_SETTINGS,
        onChange: () => undefined,
        bufferTimeoutMs: 500,
      });
      const late = trackFor('LATE0000001');
      const draft = {
        source: late.source,
        sourceRef: late.sourceRef,
        title: late.title,
        artist: late.artist,
        durationSec: late.durationSec,
        thumbnailUrl: late.thumbnailUrl,
        originalUrl: late.originalUrl,
        metadata: late.metadata,
      };

      const result = await engine.enqueue({
        guildId: 'g1',
        voiceChannelId: 'c1',
        requesterId: 'user-1',
        tracks: [draft],
      });
      expect(result.failure).toContain('вовремя');
      await new Promise((resolve) => setTimeout(resolve, 3_000));

      const pid = (await invocations()).findLast((call) =>
        call.args.at(-1)?.includes('LATE0000001'),
      )?.pid;
      expect(pid !== undefined && isProcessRunning(pid)).toBe(false);
      const next = await provider.getPlayableStream(trackFor('AAAAAAAAAAA'), signal());
      await next.close();
      await engine.shutdown();
    });

    it('still looks up links while every stream slot is busy playing', async () => {
      const provider = providerWith({ maxConcurrency: 1 });
      const playing = await provider.getPlayableStream(trackFor('AAAAAAAAAAA'), signal());

      const lookup = provider.resolve('https://www.youtube.com/watch?v=BBBBBBBBBBB', {
        signal: signal(),
      });
      const outcome = await Promise.race([
        lookup.then(() => 'resolved'),
        new Promise((resolve) => {
          setTimeout(() => {
            resolve('blocked');
          }, 3_000);
        }),
      ]);

      expect(outcome).toBe('resolved');
      await playing.close();
    });
  },
);

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
  } else {
    process.env[name] = value;
  }
}
