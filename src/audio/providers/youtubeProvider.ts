import { Transform } from 'node:stream';
import type { Track, TrackDraft } from '../../music/models/track.js';
import { Semaphore } from '../../utils/async.js';
import { AppError } from '../../utils/errors.js';
import { startPcmDecoder } from '../pipeline/ffmpeg.js';
import {
  buildMetadataArgs,
  buildPlaylistArgs,
  buildSearchArgs,
  buildStreamArgs,
  type YtDlpBaseOptions,
} from './youtube/args.js';
import { FailureBreaker } from './youtube/breaker.js';
import {
  classifyYtDlpFailure,
  parsePlaylistEntries,
  parseSearchResults,
  parseVideoMetadata,
  type SearchResult,
  type VideoMetadata,
} from './youtube/failures.js';
import {
  type ProcessExit,
  runJson,
  spawnStreamingProcess,
  type StreamingProcess,
} from './youtube/process.js';
import { parseYouTubeInput, type YouTubeLink } from './youtube/url.js';
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
  /** How long a stream opened during resolve waits for the player. Defaults to 45 seconds. */
  readonly preparedTtlMs?: number;
  readonly now?: () => number;
}

/** How long a stream opened during resolve waits for the player before it is closed. */
const PREPARED_TTL_MS = 45_000;
const SEARCH_CACHE_TTL_MS = 300_000;
const SEARCH_CACHE_MAX = 50;
/** Asked for in addition to the wanted count, because unplayable entries are filtered out. */
const SEARCH_EXTRA = 3;

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
  /** Held for the whole playback, so the limit covers concurrent yt-dlp downloads. */
  private readonly streamSlots: Semaphore;
  /** Short lookups have their own slots, so links still resolve while streams play. */
  private readonly metadataSlots: Semaphore;
  private readonly base: YtDlpBaseOptions;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  /** Streams already opened while their link was resolved, by video id. They hold a stream slot. */
  private readonly prepared = new Map<string, PreparedStream>();
  private readonly searchCache = new Map<
    string,
    { readonly at: number; readonly results: SearchResult[] }
  >();

  constructor(private readonly options: YouTubeProviderOptions) {
    this.enabled = options.enabled;
    this.breaker = new FailureBreaker({
      threshold: options.breakerThreshold ?? 5,
      cooldownMs: options.breakerCooldownMs ?? 600_000,
    });
    this.streamSlots = new Semaphore(options.maxConcurrency);
    this.metadataSlots = new Semaphore(options.maxConcurrency);
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

    if (context.willPlayNow === true) {
      // One yt-dlp run gives the metadata now and keeps the audio ready for the player.
      const draft = await this.prepare(link, context.signal);
      if (draft !== null) {
        return [draft];
      }
    }

    const stdout = await this.runMetadata(
      buildMetadataArgs(link.canonicalUrl, this.base),
      context.signal,
    );
    return [
      toVideoDraft(
        link,
        parseVideoMetadata(stdout, { maxDurationSec: this.options.maxDurationSec }),
      ),
    ];
  }

  /**
   * Finds videos by text. Results are cached for a few minutes. Live streams and videos that
   * are too long are left out, so every result can be played.
   */
  async search(query: string, limit: number, signal: AbortSignal): Promise<SearchResult[]> {
    this.assertAvailable();
    const key = `${String(limit)}:${query.trim().toLowerCase()}`;
    const cached = this.searchCache.get(key);
    if (cached !== undefined && this.now() - cached.at < SEARCH_CACHE_TTL_MS) {
      return cached.results;
    }

    let args: string[];
    try {
      args = buildSearchArgs(query, Math.min(10, limit + SEARCH_EXTRA), this.base);
    } catch (error) {
      throw new AppError('INVALID_INPUT', 'Введите запрос длиной до 200 символов.', {
        cause: error,
      });
    }
    const stdout = await this.runMetadata(args, signal);
    const results = parseSearchResults(stdout, {
      maxDurationSec: this.options.maxDurationSec,
      limit,
    });
    if (this.searchCache.size >= SEARCH_CACHE_MAX) {
      const oldest = this.searchCache.keys().next().value;
      if (oldest !== undefined) {
        this.searchCache.delete(oldest);
      }
    }
    this.searchCache.set(key, { at: this.now(), results });
    return results;
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

    // A stream opened while the link was resolved already holds its slot and may have audio waiting.
    let opened = this.takePrepared(track.sourceRef);
    if (opened === null) {
      // The slot is held for the whole playback. Waiting for it ends when the track is cancelled.
      const release = (await this.freeSlot()) ?? (await this.streamSlots.acquire(signal));
      opened = this.openProcess(url, release, false);
    }
    try {
      await this.awaitStart(opened.child, opened.firstBytes, signal);
      return this.startPlayback(opened.child, opened.probe, opened.release, signal);
    } catch (error) {
      await this.discard(opened);
      throw error;
    }
  }

  /**
   * Starts the audio of a track that will play soon, so the switch to it has no gap. It uses a
   * free stream slot only; with none free, or with the provider off, it does nothing. An unused
   * stream is closed after a while and its slot freed.
   */
  preload(track: Track): boolean {
    if (this.prepared.has(track.sourceRef)) {
      return true;
    }
    if (!this.enabled || this.breaker.isOpen(this.now())) {
      return false;
    }
    let url: string;
    try {
      url = this.canonicalFor(track);
    } catch {
      return false;
    }
    const release = this.streamSlots.tryAcquire();
    if (release === null) {
      return false;
    }
    this.keepPrepared(track.sourceRef, this.openProcess(url, release, false), track, true);
    return true;
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.prepared.keys()].map((id) => this.dropPrepared(id)));
  }

  /** Starts yt-dlp for one video: audio on standard output, one metadata line on standard error. */
  private openProcess(url: string, release: () => void, printMetadata: boolean): OpenedStream {
    const metadata = Promise.withResolvers<string>();
    const child = spawnStreamingProcess(
      this.options.ytdlpPath,
      buildStreamArgs(url, this.base, { printMetadata }),
      {
        onStderrLine: (line) => {
          if (line.startsWith('{') && line.endsWith('}')) {
            metadata.resolve(line);
          }
        },
      },
    );
    const firstBytes = Promise.withResolvers<undefined>();
    const probe = createProbe(() => {
      firstBytes.resolve(undefined);
    });
    child.stdout.pipe(probe);
    return {
      child,
      probe,
      release,
      firstBytes: firstBytes.promise,
      metadataLine: metadata.promise,
    };
  }

  /** Stops a stream that will not be played and frees its slot. */
  private async discard(opened: OpenedStream): Promise<void> {
    opened.release();
    await opened.child.stop();
    opened.probe.destroy();
  }

  /**
   * Opens the audio together with the lookup. Returns null when no stream slot is free right
   * now; the caller then looks the video up the usual way, so a busy bot never waits here.
   */
  private async prepare(link: YouTubeLink, signal: AbortSignal): Promise<TrackDraft | null> {
    const existing = this.prepared.get(link.id);
    if (existing !== undefined) {
      return existing.draft;
    }
    const release = await this.freeSlot();
    if (release === null) {
      return null;
    }
    const opened = this.openProcess(link.canonicalUrl, release, true);
    try {
      const line = await this.awaitStart(opened.child, opened.metadataLine, signal);
      const draft = toVideoDraft(
        link,
        parseVideoMetadata(line, { maxDurationSec: this.options.maxDurationSec }),
      );
      this.breaker.recordSuccess();
      this.keepPrepared(link.id, opened, draft);
      return draft;
    } catch (error) {
      await this.discard(opened);
      throw error;
    }
  }

  /**
   * A stream slot for a track someone asked for: a free one, or else one taken back from a track
   * that was only opened early in case it plays next. Null when every slot plays something.
   */
  private async freeSlot(): Promise<(() => void) | null> {
    const free = this.streamSlots.tryAcquire();
    if (free !== null) {
      return free;
    }
    const speculative = [...this.prepared].find(([, entry]) => entry.speculative);
    if (speculative === undefined) {
      return null;
    }
    await this.dropPrepared(speculative[0]);
    return this.streamSlots.tryAcquire();
  }

  private keepPrepared(
    id: string,
    opened: OpenedStream,
    draft: TrackDraft,
    speculative = false,
  ): void {
    const timer = setTimeout(() => {
      void this.dropPrepared(id);
    }, this.options.preparedTtlMs ?? PREPARED_TTL_MS);
    timer.unref();
    this.prepared.set(id, { opened, draft, timer, speculative });
    // A process that dies while it waits is of no use to the player.
    void opened.child.exit.then((exit) => {
      if (
        this.prepared.get(id)?.opened === opened &&
        (exit.code !== 0 || exit.spawnError !== null)
      ) {
        void this.dropPrepared(id);
      }
    });
  }

  private takePrepared(id: string): OpenedStream | null {
    const entry = this.prepared.get(id);
    if (entry === undefined) {
      return null;
    }
    clearTimeout(entry.timer);
    this.prepared.delete(id);
    return entry.opened;
  }

  private async dropPrepared(id: string): Promise<void> {
    const opened = this.takePrepared(id);
    if (opened !== null) {
      await this.discard(opened);
    }
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

  /**
   * Waits until the process has produced `ready` (the first audio, or the metadata line). A bad
   * link fails here, before the track is shown as playing. The process is stopped on timeout
   * and on cancellation; a process that exits first is classified from its error output.
   */
  private async awaitStart<T>(
    child: StreamingProcess,
    ready: Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    type Outcome =
      | { readonly kind: 'ready'; readonly value: T }
      | { readonly kind: 'exit'; readonly exit: ProcessExit }
      | { readonly kind: 'timeout' }
      | { readonly kind: 'aborted' };

    let timer: NodeJS.Timeout | undefined;
    let onAbort: () => void = () => undefined;
    const outcome = await Promise.race<Outcome>([
      ready.then((value): Outcome => ({ kind: 'ready', value })),
      child.exit.then((exit): Outcome => ({ kind: 'exit', exit })),
      new Promise<Outcome>((resolve) => {
        timer = setTimeout(() => {
          resolve({ kind: 'timeout' });
        }, this.timeoutMs);
      }),
      new Promise<Outcome>((resolve) => {
        onAbort = () => {
          resolve({ kind: 'aborted' });
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    });

    switch (outcome.kind) {
      case 'ready':
        return outcome.value;
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
    const release = await this.metadataSlots.acquire(signal);
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

interface OpenedStream {
  readonly child: StreamingProcess;
  /** Passes the audio on and reports the first chunk. */
  readonly probe: Transform;
  readonly release: () => void;
  readonly firstBytes: Promise<undefined>;
  /** The JSON line yt-dlp printed to standard error, when metadata was requested. */
  readonly metadataLine: Promise<string>;
}

interface PreparedStream {
  readonly opened: OpenedStream;
  readonly draft: TrackDraft;
  readonly timer: NodeJS.Timeout;
  /** Opened early in case it plays next. Its slot is given up when a requested track needs one. */
  readonly speculative: boolean;
}

function toVideoDraft(link: YouTubeLink, metadata: VideoMetadata): TrackDraft {
  return {
    source: 'youtube',
    sourceRef: link.id,
    title: metadata.title,
    artist: metadata.artist,
    durationSec: metadata.durationSec,
    thumbnailUrl: metadata.thumbnailUrl,
    originalUrl: link.canonicalUrl,
    metadata: {},
  };
}

/** A search result as a queueable track. The metadata is already known, so no lookup follows. */
export function searchResultToDraft(result: SearchResult): TrackDraft {
  return {
    source: 'youtube',
    sourceRef: result.id,
    title: result.title,
    artist: result.channel,
    durationSec: result.durationSec,
    thumbnailUrl: result.thumbnailUrl,
    originalUrl: `https://www.youtube.com/watch?v=${result.id}`,
    metadata: {},
  };
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
