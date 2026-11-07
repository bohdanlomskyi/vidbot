import { describe, expect, it } from 'vitest';
import type { AudioProvider } from '../../src/audio/providers/types.js';
import { SourceRouter } from '../../src/music/sourceRouter.js';
import type { SourceKind } from '../../src/music/models/track.js';

function provider(
  kind: SourceKind,
  options: { enabled?: boolean; handles?: (input: string) => boolean } = {},
): AudioProvider {
  return {
    kind,
    enabled: options.enabled ?? true,
    canHandle: options.handles ?? (() => false),
    resolve: () => Promise.resolve([]),
    validate: () => Promise.resolve(),
    getPlayableStream: () => Promise.reject(new Error('not used')),
    dispose: () => Promise.resolve(),
  };
}

function router(overrides: { youtubeEnabled?: boolean; libraryTitles?: string[] } = {}) {
  return new SourceRouter({
    local: provider('local'),
    streams: provider('stream', { handles: (input) => input === 'radio-one' }),
    youtube: provider('youtube', {
      enabled: overrides.youtubeEnabled ?? true,
      handles: (input) => input.startsWith('https://www.youtube.com/watch?v='),
    }),
    libraryHasTitle: (title) =>
      (overrides.libraryTitles ?? []).some((known) => known.toLowerCase() === title.toLowerCase()),
  });
}

const ALL: readonly SourceKind[] = ['local', 'stream', 'youtube'];

describe('SourceRouter.wantsSearch', () => {
  it('searches YouTube for plain text', () => {
    expect(router().wantsSearch('lord verity master of humanity', ALL)).toBe(true);
  });

  it('does not search for a YouTube link, another link, a catalog id or a library id', () => {
    const r = router();

    expect(r.wantsSearch('https://www.youtube.com/watch?v=lhCPiauHI-g', ALL)).toBe(false);
    expect(r.wantsSearch('https://example.com/song.mp3', ALL)).toBe(false);
    expect(r.wantsSearch('radio-one', ALL)).toBe(false);
    expect(r.wantsSearch('lib-0123456789ab', ALL)).toBe(false);
  });

  it('plays a track from the library by its exact title instead of searching', () => {
    const r = router({ libraryTitles: ['Test Tone'] });

    expect(r.wantsSearch('test tone', ALL)).toBe(false);
    expect(r.wantsSearch('test tone remix', ALL)).toBe(true);
  });

  it('does not search when YouTube is off for the server or switched off by the operator', () => {
    expect(router().wantsSearch('anything', ['local', 'stream'])).toBe(false);
    expect(router({ youtubeEnabled: false }).wantsSearch('anything', ALL)).toBe(false);
  });

  it('ignores empty and oversized input instead of throwing', () => {
    expect(router().wantsSearch('   ', ALL)).toBe(false);
    expect(router().wantsSearch('x'.repeat(600), ALL)).toBe(false);
  });
});
