import type { Track, TrackDraft } from '../../music/models/track.js';
import { AppError } from '../../utils/errors.js';
import { startPcmDecoder } from '../pipeline/ffmpeg.js';
import type { StreamCatalogEntry } from './streamCatalog.js';
import { type AddressGuard, openStream, type StreamTimeouts } from './streamFetcher.js';
import type { AudioProvider, PlaybackEnd, PlayableSource, ResolveContext } from './types.js';

export interface AuthorizedStreamProviderOptions {
  readonly entries: readonly StreamCatalogEntry[];
  readonly enabled: boolean;
  readonly ffmpegPath: string;
  /** Byte cap for finite entries. Live entries are not capped. */
  readonly maxBytes: number;
  readonly timeouts: StreamTimeouts;
  /** Injected only by tests that use a loopback server. Production uses the default guard. */
  readonly addressGuard?: AddressGuard;
}

/**
 * Plays audio from streams the operator has allowlisted in the catalog. Users choose a
 * catalog identifier and never supply URLs. Bytes are fetched by Node under the URL and
 * address policies, then piped into FFmpeg, so FFmpeg never receives a network URL.
 */
export class AuthorizedStreamProvider implements AudioProvider {
  readonly kind = 'stream' as const;
  readonly enabled: boolean;
  private readonly byId: ReadonlyMap<string, StreamCatalogEntry>;

  constructor(private readonly options: AuthorizedStreamProviderOptions) {
    this.enabled = options.enabled;
    this.byId = new Map(options.entries.map((entry) => [entry.id, entry]));
  }

  canHandle(input: string): boolean {
    return this.byId.has(input.trim());
  }

  /** Catalog entries whose title contains the query. Used for autocomplete only. */
  suggest(query: string, limit: number): { readonly id: string; readonly title: string }[] {
    const needle = query.trim().toLowerCase();
    if (!this.enabled || needle === '') {
      return [];
    }
    return [...this.byId.values()]
      .filter((entry) => entry.title.toLowerCase().includes(needle))
      .slice(0, limit)
      .map((entry) => ({ id: entry.id, title: entry.title }));
  }

  resolve(input: string, context: ResolveContext): Promise<readonly TrackDraft[]> {
    return new Promise((resolve, reject) => {
      if (context.signal.aborted) {
        reject(new AppError('CANCELLED', 'Запрос отменён.'));
        return;
      }
      if (!this.enabled) {
        reject(new AppError('SOURCE_DISABLED', 'Потоковые источники отключены.'));
        return;
      }
      const entry = this.byId.get(input.trim());
      if (entry === undefined) {
        reject(new AppError('NOT_FOUND', 'Поток не найден в каталоге.'));
        return;
      }
      resolve([toDraft(entry)]);
    });
  }

  validate(track: Track): Promise<void> {
    return new Promise((resolve) => {
      this.entryFor(track);
      resolve();
    });
  }

  async getPlayableStream(track: Track, signal: AbortSignal): Promise<PlayableSource> {
    // Live and remote streams cannot be sought, so no start offset is accepted here.
    const entry = this.entryFor(track);
    if (signal.aborted) {
      throw new AppError('CANCELLED', 'Воспроизведение отменено.');
    }

    const opened = await openStream({
      url: entry.url,
      policy: entry.policy,
      signal,
      maxBytes: entry.live ? null : this.options.maxBytes,
      timeouts: this.options.timeouts,
      addressGuard: this.options.addressGuard,
    });

    let sourceFailure: AppError | null = null;
    opened.body.once('error', (error: unknown) => {
      sourceFailure = error instanceof AppError ? error : null;
    });

    const decoder = startPcmDecoder({
      ffmpegPath: this.options.ffmpegPath,
      input: { kind: 'pipe' },
      source: opened.body,
    });

    let stopped = false;
    const close = async (): Promise<void> => {
      stopped = true;
      signal.removeEventListener('abort', abort);
      opened.close();
      await decoder.close();
    };
    const abort = (): void => {
      void close();
    };
    signal.addEventListener('abort', abort, { once: true });

    const ended = decoder.done.then((exit): PlaybackEnd => {
      if (stopped) {
        return { status: 'stopped' };
      }
      if (sourceFailure !== null) {
        return { status: 'failed', message: sourceFailure.userMessage };
      }
      if (exit.code === 0 && exit.spawnError === null) {
        return { status: 'completed' };
      }
      return { status: 'failed', message: 'Декодер остановился с ошибкой.' };
    });

    return { stream: decoder.stream, ended, close };
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }

  private entryFor(track: Track): StreamCatalogEntry {
    const entry = this.byId.get(track.sourceRef);
    if (entry === undefined) {
      throw new AppError('NOT_FOUND', 'Поток больше не находится в каталоге.');
    }
    if (!this.enabled) {
      throw new AppError('SOURCE_DISABLED', 'Потоковые источники отключены.');
    }
    return entry;
  }
}

function toDraft(entry: StreamCatalogEntry): TrackDraft {
  return {
    source: 'stream',
    sourceRef: entry.id,
    title: entry.title,
    artist: entry.artist,
    durationSec: entry.durationSec,
    thumbnailUrl: entry.thumbnailUrl,
    originalUrl: null,
    metadata: { live: entry.live },
  };
}
