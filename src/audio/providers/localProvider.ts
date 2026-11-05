import type { TrackDraft, Track } from '../../music/models/track.js';
import { resolveInsideRoot } from '../../security/libraryPaths.js';
import { AppError } from '../../utils/errors.js';
import { type LibraryCatalog, type LibraryRow } from '../library/catalog.js';
import { startPcmDecoder } from '../pipeline/ffmpeg.js';
import type { AudioProvider, PlaybackEnd, PlayableSource, ResolveContext } from './types.js';

const LIBRARY_ID = /^lib-[0-9a-f]{12}$/;
const URL_PREFIX = /^https?:\/\//i;
const SEARCH_LIMIT = 5;

export interface LocalAudioProviderOptions {
  readonly catalog: LibraryCatalog;
  readonly musicDir: string;
  readonly ffmpegPath: string;
}

/**
 * Plays files from the operator's music library. Users refer to tracks by internal
 * identifier or by a text search over the catalog. They never supply file paths.
 */
export class LocalAudioProvider implements AudioProvider {
  readonly kind = 'local' as const;
  readonly enabled = true;

  constructor(private readonly options: LocalAudioProviderOptions) {}

  canHandle(input: string): boolean {
    return !URL_PREFIX.test(input.trim());
  }

  resolve(input: string, context: ResolveContext): Promise<readonly TrackDraft[]> {
    return new Promise((resolve, reject) => {
      if (context.signal.aborted) {
        reject(new AppError('CANCELLED', 'Запрос отменён.'));
        return;
      }
      resolve(this.findDrafts(input.trim()));
    });
  }

  async validate(track: Track): Promise<void> {
    await this.locate(track);
  }

  async getPlayableStream(
    track: Track,
    signal: AbortSignal,
    startSec?: number,
  ): Promise<PlayableSource> {
    if (signal.aborted) {
      throw new AppError('CANCELLED', 'Воспроизведение отменено.');
    }

    const file = await this.locate(track);
    const decoder = startPcmDecoder({
      ffmpegPath: this.options.ffmpegPath,
      input: { kind: 'file', path: file, startSec },
    });

    let stopped = false;
    const close = async (): Promise<void> => {
      stopped = true;
      signal.removeEventListener('abort', abort);
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
      if (exit.code === 0 && exit.spawnError === null) {
        return { status: 'completed' };
      }
      return { status: 'failed', message: 'Не удалось декодировать трек.' };
    });

    return { stream: decoder.stream, ended, close };
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }

  private findDrafts(query: string): TrackDraft[] {
    if (LIBRARY_ID.test(query)) {
      const row = this.options.catalog.get(query);
      if (row === undefined) {
        throw new AppError('NOT_FOUND', 'Трек не найден в библиотеке.');
      }
      return [toDraft(row)];
    }

    const matches = this.options.catalog.search(query, SEARCH_LIMIT);
    if (matches.length === 0) {
      throw new AppError('NOT_FOUND', 'В библиотеке ничего не найдено.');
    }

    const exact = matches.find((row) => row.title.toLowerCase() === query.toLowerCase());
    if (exact !== undefined) {
      return [toDraft(exact)];
    }
    if (matches.length > 1) {
      throw new AppError(
        'INVALID_INPUT',
        'Найдено несколько треков. Уточните название или выберите вариант из подсказок.',
      );
    }
    const [only] = matches;
    return only === undefined ? [] : [toDraft(only)];
  }

  private async locate(track: Track): Promise<string> {
    const row = this.options.catalog.get(track.sourceRef);
    if (row === undefined) {
      throw new AppError('NOT_FOUND', 'Трек больше не находится в библиотеке.');
    }
    return resolveInsideRoot(this.options.musicDir, row.relativePath);
  }
}

function toDraft(row: LibraryRow): TrackDraft {
  return {
    source: 'local',
    sourceRef: row.id,
    title: row.title,
    artist: row.artist,
    durationSec: row.durationSec,
    thumbnailUrl: null,
    originalUrl: null,
    metadata: { folder: row.folder },
  };
}
