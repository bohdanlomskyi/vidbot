import type { AudioProvider, ResolveContext } from '../audio/providers/types.js';
import { AppError } from '../utils/errors.js';
import type { TrackDraft, SourceKind } from './models/track.js';

const MAX_INPUT_LENGTH = 500;
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;

export interface SourceRouterDeps {
  readonly local: AudioProvider;
  readonly streams: AudioProvider;
  readonly youtube: AudioProvider;
}

/**
 * Decides which provider handles a user's input. Links to YouTube go to the experimental
 * provider. Catalog identifiers go to the stream provider. Everything else is a library
 * search. Other links are refused, so users can never point the bot at an arbitrary URL.
 * Each source must also be allowed for the guild.
 */
export class SourceRouter {
  constructor(private readonly deps: SourceRouterDeps) {}

  async resolve(
    rawInput: string,
    allowed: readonly SourceKind[],
    context: ResolveContext,
  ): Promise<TrackDraft[]> {
    const input = normalize(rawInput);

    if (this.deps.youtube.canHandle(input)) {
      return this.run(this.deps.youtube, 'youtube', input, allowed, context);
    }
    if (URL_LIKE.test(input)) {
      throw new AppError(
        'INVALID_INPUT',
        'Прямые ссылки не поддерживаются. Используйте ссылку YouTube или название трека.',
      );
    }
    if (this.deps.streams.canHandle(input)) {
      return this.run(this.deps.streams, 'stream', input, allowed, context);
    }
    return this.run(this.deps.local, 'local', input, allowed, context);
  }

  private async run(
    provider: AudioProvider,
    kind: SourceKind,
    input: string,
    allowed: readonly SourceKind[],
    context: ResolveContext,
  ): Promise<TrackDraft[]> {
    if (!allowed.includes(kind)) {
      throw new AppError('SOURCE_DISABLED', 'Этот источник отключён на сервере.');
    }
    return [...(await provider.resolve(input, context))];
  }
}

/** Trims input, collapses whitespace and rejects control characters and oversized text. */
export function normalize(rawInput: string): string {
  const collapsed = rawInput.trim().replace(/\s+/g, ' ');
  if (collapsed === '' || collapsed.length > MAX_INPUT_LENGTH) {
    throw new AppError('INVALID_INPUT', `Введите название, идентификатор или ссылку (до ${String(MAX_INPUT_LENGTH)} символов).`);
  }
  for (const character of collapsed) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      throw new AppError('INVALID_INPUT', 'Ввод содержит недопустимые символы.');
    }
  }
  return collapsed;
}
