import { Transform } from 'node:stream';
import type { Track, TrackDraft } from '../../music/models/track.js';
import { Semaphore } from '../../utils/async.js';
import { AppError } from '../../utils/errors.js';
import { startPcmDecoder } from '../pipeline/ffmpeg.js';
import {
  buildMetadataArgs,
  buildPlaylistArgs,
  buildStreamArgs,
  type YtDlpBaseOptions,
} from './youtube/args.js';
import { FailureBreaker } from './youtube/breaker.js';
import {
  classifyYtDlpFailure,
  parsePlaylistEntries,
  parseVideoMetadata,
} from './youtube/failures.js';
import {
  type ProcessExit,
  runJson,
  spawnStreamingProcess,
  type StreamingProcess,
} from './youtube/process.js';
import { parseYouTubeInput } from './youtube/url.js';
import type { AudioProvider, PlaybackEnd, PlayableSource, ResolveContext } from './types.js';

export interface YouTubeProviderOptions {
  /** Off by default. Enable only where the rights and terms for this use are in place. */
  readonly enabled: boolean;
  readonly ytdlpPath: string;
  readonly jsRuntime: 'node' | 'deno';
  /** Directory for yt-dlp's solver cache. It holds no media. */
  readonly cacheDir: string;
  readonly ffmpegPath: string;
  readonly maxDurationSec: number;
  /** Zero disables playlists. */
  readonly playlistMaxItems: number;
  readonly maxConcurrency: number;
  readonly timeoutSec: number;
  readonly breakerThreshold?: number;
  readonly breakerCooldownMs?: number;
  readonly now?: () => number;
}

const DISABLED_MESSAGE = 'Источник YouTube отключён оператором бота.';
const UNAVAILABLE_MESSAGE = 'YouTube сейчас недоступен. Попробуйте позже.';

/**
 * Experimental YouTube source built on yt-dlp. It is disabled by default and isolated from
 * the rest of the bot. Only canonical URLs reach yt-dlp, processes run without a shell, a
 * circuit breaker stops the provider after repeated systemic failures, and every failure
 * becomes a short user-facing message. It never stores media and never bypasses access
 * controls. See docs/youtube.md for the terms and rights this use requires.
 */
export class YouTubeExperimentalProvider implements AudioProvider {
  readonly kind = 'youtube' as const;
  readonly enabled: boolean;
  private readonly breaker: FailureBreaker;
  private readonly slots: Semaphore;
  private readonly base: YtDlpBaseOptions;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly options: YouTubeProviderOptions) {
    this.enabled = options.enabled;
    this.breaker = new FailureBreaker({
      threshold: options.breakerThreshold ?? 5,
      cooldownMs: options.breakerCooldownMs ?? 600_000,
    });
    this.slots = new Semaphore(options.maxConcurrency);
    this.base = { jsRuntime: options.jsRuntime, cacheDir: options.cacheDir };
    this.timeoutMs = options.timeoutSec * 1000;
    this.now = options.now ?? Date.now;
  }

  canHandle(input: string): boolean {
    return parseYouTubeInput(input) !== null;
  }

  async resolve(input: string, context: ResolveContext): Promise<readonly TrackDraft[]> {
    const link = parseYouTubeInput(input);
    if (link === null) {
      throw new AppError('INVALID_INPUT', 'Это не ссылка на видео или плейлист YouTube.');
    }
    this.assertAvailable();

    if (link.kind === 'playlist') {
      if (this.options.playlistMaxItems === 0) {
        throw new AppError('SOURCE_DISABLED', 'Плейлисты YouTube отключены оператором бота.');
      }
      const stdout = await this.runMetadata(
        buildPlaylistArgs(link.canonicalUrl, this.options.playlistMaxItems, this.base),
        context.signal,
      );
      return parsePlaylistEntries(stdout, this.options.playlistMaxItems)
        .filter(
          (entry) => entry.durationSec !== null && entry.durationSec <= this.options.maxDurationSec,
        )
        .map((entry) => ({
          source: 'youtube' as const,
          sourceRef: entry.id,
          title: entry.title,
          artist: null,
          durationSec: entry.durationSec,
          thumbnailUrl: null,
          originalUrl: `https://www.youtube.com/watch?v=${entry.id}`,
          metadata: {},
        }));
    }

    const stdout = await this.runMetadata(
      buildMetadataArgs(link.canonicalUrl, this.base),
      context.signal,
    );
    const metadata = parseVideoMetadata(stdout, { maxDurationSec: this.options.maxDurationSec });
    return [
      {
        source: 'youtube',
        sourceRef: link.id,
        title: metadata.title,
        artist: metadata.artist,
        durationSec: metadata.durationSec,
        thumbnailUrl: metadata.thumbnailUrl,
        originalUrl: link.canonicalUrl,
        metadata: {},
      },
    ];
  }

  validate(track: Track): Promise<void> {
    return new Promise((resolve) => {
      this.assertAvailable();
      this.canonicalFor(track);
      resolve();
    });
  }

  async getPlayableStream(track: Track, signal: AbortSignal): Promise<PlayableSource> {
    this.assertAvailable();
    const url = this.canonicalFor(track);
    if (signal.aborted) {
      throw new AppError('CANCELLED', 'Воспроизведение отменено.');
    }

    // The slot is held for the whole playback, so the concurrency limit covers streams too.
    const release = await this.slots.acquire();
    let child: StreamingProcess | undefined;
    try {
      child = spawnStreamingProcess(this.options.ytdlpPath, buildStreamArgs(url, this.base));
      let onFirstChunk: () => void = () => undefined;
      const firstBytes = new Promise<void>((resolve) => {
        onFirstChunk = resolve;
      });
      const probe = createProbe(() => {
        onFirstChunk();
      });
      child.stdout.pipe(probe);

      await this.awaitFirstBytes(child, firstBytes, signal);
      return this.startPlayback(child, probe, release, signal);
    } catch (error) {
      release();
      if (child !== undefined) {
        await child.stop();
      }
      throw error;
    }
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }

  private startPlayback(
    child: StreamingProcess,
    probe: Transform,
    release: () => void,
    signal: AbortSignal,
  ): PlayableSource {
    const decoder = startPcmDecoder({
      ffmpegPath: this.options.ffmpegPath,
      input: { kind: 'pipe' },
      source: probe,
    });

    let stopped = false;
    const close = async (): Promise<void> => {
      stopped = true;
      signal.removeEventListener('abort', abort);
      await decoder.close();
      await child.stop();
      probe.destroy();
      release();
    };
    const abort = (): void => {
      void close();
    };
    signal.addEventListener('abort', abort, { once: true });

    const ended = Promise.all([decoder.done, child.exit]).then(
      ([decoderExit, processExit]): PlaybackEnd => {
        release();
        signal.removeEventListener('abort', abort);
        if (stopped) {
          return { status: 'stopped' };
        }
        if (processExit.code === 0 && decoderExit.code === 0 && decoderExit.spawnError === null) {
          this.breaker.recordSuccess();
          return { status: 'completed' };
        }
        if (processExit.code !== null && processExit.code !== 0) {
          const failure = classifyYtDlpFailure(processExit.stderr);
          if (failure.systemic) {
            this.recordSystemFailure();
          }
          return { status: 'failed', message: failure.error.userMessage };
        }
        return { status: 'failed', message: 'Декодер остановился с ошибкой.' };
      },
    );

    return { stream: decoder.stream, ended, close };
  }

  /** Waits until audio actually flows, so a bad link fails before the track is shown as playing. */
  private async awaitFirstBytes(
    child: StreamingProcess,
    firstBytes: Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    type Outcome =
      | { readonly kind: 'data' }
      | { readonly kind: 'exit'; readonly exit: ProcessExit }
      | { readonly kind: 'timeout' }
      | { readonly kind: 'aborted' };

    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race<Outcome>([
      firstBytes.then((): Outcome => ({ kind: 'data' })),
      child.exit.then((exit): Outcome => ({ kind: 'exit', exit })),
      new Promise<Outcome>((resolve) => {
        timer = setTimeout(() => {
          resolve({ kind: 'timeout' });
        }, this.timeoutMs);
      }),
      new Promise<Outcome>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            resolve({ kind: 'aborted' });
          },
          { once: true },
        );
      }),
    ]).finally(() => {
      clearTimeout(timer);
    });

    switch (outcome.kind) {
      case 'data':
        return;
      case 'aborted':
        await child.stop();
        throw new AppError('CANCELLED', 'Воспроизведение отменено.');
      case 'timeout':
        this.recordSystemFailure();
        await child.stop();
        throw new AppError('TIMEOUT', 'YouTube не ответил вовремя.');
      case 'exit': {
        if (outcome.exit.spawnError !== null) {
          this.recordSystemFailure();
          throw new AppError('SOURCE_UNAVAILABLE', UNAVAILABLE_MESSAGE, {
            cause: outcome.exit.spawnError,
          });
        }
        const failure = classifyYtDlpFailure(outcome.exit.stderr);
        if (failure.systemic) {
          this.recordSystemFailure();
        }
        throw failure.error;
      }
    }
  }

  private async runMetadata(args: readonly string[], signal: AbortSignal): Promise<string> {
    const release = await this.slots.acquire();
    try {
      const run = await runJson(this.options.ytdlpPath, args, {
        timeoutMs: this.timeoutMs,
        signal,
      });
      if (signal.aborted) {
        throw new AppError('CANCELLED', 'Запрос отменён.');
      }
      if (run.spawnError !== null) {
        this.recordSystemFailure();
        throw new AppError('SOURCE_UNAVAILABLE', UNAVAILABLE_MESSAGE, { cause: run.spawnError });
      }
      if (run.timedOut) {
        this.recordSystemFailure();
        throw new AppError('TIMEOUT', 'YouTube не ответил вовремя.');
      }
      if (run.code !== 0) {
        const failure = classifyYtDlpFailure(run.stderr);
        if (failure.systemic) {
          this.recordSystemFailure();
        }
        throw failure.error;
      }
      this.breaker.recordSuccess();
      return run.stdout;
    } finally {
      release();
    }
  }

  private assertAvailable(): void {
    if (!this.enabled) {
      throw new AppError('SOURCE_DISABLED', DISABLED_MESSAGE);
    }
    if (this.breaker.isOpen(this.now())) {
      throw new AppError(
        'SOURCE_DISABLED',
        'YouTube временно отключён после ошибок. Попробуйте позже.',
      );
    }
  }

  private canonicalFor(track: Track): string {
    const link = parseYouTubeInput(`https://www.youtube.com/watch?v=${track.sourceRef}`);
    if (link === null || link.kind !== 'video') {
      throw new AppError('INVALID_INPUT', 'Некорректный идентификатор видео YouTube.');
    }
    return link.canonicalUrl;
  }

  private recordSystemFailure(): void {
    this.breaker.recordSystemFailure(this.now());
  }
}

/** A pass-through stream that reports its first chunk, so the caller knows audio is flowing. */
function createProbe(onFirstChunk: () => void): Transform {
  let seen = false;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (!seen) {
        seen = true;
        onFirstChunk();
      }
      callback(null, chunk);
    },
  });
}
