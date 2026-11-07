import { describe, expect, it } from 'vitest';
import {
  buildSearchArgs,
  buildStreamArgs,
  normalizeSearchQuery,
  type YtDlpBaseOptions,
} from '../../src/audio/providers/youtube/args.js';
import { parseSearchResults } from '../../src/audio/providers/youtube/failures.js';

const BASE: YtDlpBaseOptions = { jsRuntime: 'node', cacheDir: '/tmp/cache' };

describe('buildSearchArgs', () => {
  it('puts the whole query behind the end-of-options marker, after the search prefix', () => {
    const args = buildSearchArgs('lord verity', 8, BASE);

    expect(args.slice(-2)).toEqual(['--', 'ytsearch8:lord verity']);
    expect(args).toContain('--flat-playlist');
    expect(args).toContain('--dump-single-json');
    expect(args).toContain('--ignore-config');
  });

  it('keeps option-looking text inside the query, never as a flag', () => {
    const args = buildSearchArgs('--exec rm -rf /', 5, BASE);

    expect(args.at(-1)).toBe('ytsearch5:--exec rm -rf /');
    expect(args.at(-2)).toBe('--');
    expect(args.filter((arg) => arg === '--exec')).toHaveLength(0);
  });

  it('rejects an empty or oversized query and an out-of-range count', () => {
    expect(() => buildSearchArgs('', 5, BASE)).toThrow(RangeError);
    expect(() => buildSearchArgs('x'.repeat(201), 5, BASE)).toThrow(RangeError);
    expect(() => buildSearchArgs('abc', 0, BASE)).toThrow(RangeError);
    expect(() => buildSearchArgs('abc', 11, BASE)).toThrow(RangeError);
  });
});

describe('normalizeSearchQuery', () => {
  it('collapses whitespace and rejects control characters', () => {
    expect(normalizeSearchQuery('  lord   verity \n')).toBe('lord verity');
    expect(() => normalizeSearchQuery('a\u0000b')).toThrow(RangeError);
  });
});

describe('buildStreamArgs with metadata', () => {
  const URL = 'https://www.youtube.com/watch?v=lhCPiauHI-g';

  it('asks for one JSON line on stderr and still downloads', () => {
    const args = buildStreamArgs(URL, BASE, { printMetadata: true });

    expect(args).toContain('--print');
    expect(args).toContain('--no-simulate');
    expect(args).toContain('-o');
    expect(args.slice(-2)).toEqual(['--', URL]);
  });

  it('is unchanged without the option', () => {
    expect(buildStreamArgs(URL, BASE)).not.toContain('--print');
  });
});

describe('parseSearchResults', () => {
  const listing = JSON.stringify({
    entries: [
      {
        id: 'lhCPiauHI-g',
        title: 'Lord Verity - Master of Humanity (song)',
        duration: 141,
        channel: 'Horror Skunx',
        thumbnails: [
          { url: 'https://i.ytimg.com/vi/lhCPiauHI-g/small.jpg' },
          { url: 'https://i.ytimg.com/vi/lhCPiauHI-g/hq720.jpg' },
        ],
      },
      { id: 'LIVELIVELIV', title: 'Live', duration: null, live_status: 'is_live' },
      { id: 'LONGLONGLON', title: 'Ten hours', duration: 36_000 },
      { id: 'bad id', title: 'Broken', duration: 100 },
      { id: 'b4iZR0G_sxc', title: 'Lyrics', duration: 141, uploader: 'VibesOnly' },
    ],
  });

  it('keeps playable videos with their channel and the largest HTTPS thumbnail', () => {
    const results = parseSearchResults(listing, { maxDurationSec: 900, limit: 5 });

    expect(results).toEqual([
      {
        id: 'lhCPiauHI-g',
        title: 'Lord Verity - Master of Humanity (song)',
        channel: 'Horror Skunx',
        durationSec: 141,
        thumbnailUrl: 'https://i.ytimg.com/vi/lhCPiauHI-g/hq720.jpg',
      },
      {
        id: 'b4iZR0G_sxc',
        title: 'Lyrics',
        channel: 'VibesOnly',
        durationSec: 141,
        thumbnailUrl: null,
      },
    ]);
  });

  it('keeps a ten-hour video when there is no length limit', () => {
    const results = parseSearchResults(listing, { maxDurationSec: 0, limit: 5 });

    expect(results.map((item) => item.id)).toContain('LONGLONGLON');
  });

  it('stops at the limit', () => {
    const results = parseSearchResults(listing, { maxDurationSec: 100_000, limit: 1 });

    expect(results.map((item) => item.id)).toEqual(['lhCPiauHI-g']);
  });

  it('drops a listing that is not JSON with a user-facing error', () => {
    expect(() => parseSearchResults('nope', { maxDurationSec: 900, limit: 5 })).toThrow(
      /прочитать ответ/u,
    );
  });
});
