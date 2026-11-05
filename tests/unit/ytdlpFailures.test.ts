import { describe, expect, it } from 'vitest';
import {
  classifyYtDlpFailure,
  parsePlaylistEntries,
  parseVideoMetadata,
} from '../../src/audio/providers/youtube/failures.js';
import { FailureBreaker } from '../../src/audio/providers/youtube/breaker.js';
import { AppError } from '../../src/utils/errors.js';

describe('classifyYtDlpFailure', () => {
  it.each<[string, string, boolean]>([
    [
      'ERROR: [youtube] abc: Private video. Sign in if you have been granted access',
      'SOURCE_UNAVAILABLE',
      false,
    ],
    [
      'ERROR: [youtube] abc: Video unavailable. This video has been removed by the uploader',
      'SOURCE_UNAVAILABLE',
      false,
    ],
    [
      'ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate',
      'SOURCE_RESTRICTED',
      false,
    ],
    [
      'ERROR: [youtube] abc: The uploader has not made this video available in your country',
      'SOURCE_RESTRICTED',
      false,
    ],
    [
      "ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies-from-browser",
      'SOURCE_RESTRICTED',
      true,
    ],
    [
      'ERROR: unable to download video data: HTTP Error 429: Too Many Requests',
      'SOURCE_UNAVAILABLE',
      true,
    ],
    ['ERROR: [youtube] abc: Unable to extract nsig function', 'SOURCE_UNAVAILABLE', true],
    ['something entirely unexpected happened', 'SOURCE_UNAVAILABLE', true],
  ])('maps %j to %s (systemic=%s)', (stderr, code, systemic) => {
    const result = classifyYtDlpFailure(stderr);

    expect(result.error.code).toBe(code);
    expect(result.systemic).toBe(systemic);
  });

  it('keeps raw yt-dlp output out of the user-facing message', () => {
    const { error } = classifyYtDlpFailure('ERROR: [youtube] abc: Private video');

    expect(error.userMessage).not.toContain('ERROR');
    expect(error.userMessage).not.toContain('abc');
  });
});

describe('parseVideoMetadata', () => {
  const normal = {
    id: 'dQw4w9WgXcQ',
    title: 'Song',
    uploader: 'Band',
    duration: 212,
    thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hq.jpg',
    live_status: 'not_live',
    is_live: false,
    availability: 'public',
  };

  it('accepts a normal video and reports its title and duration', () => {
    const metadata = parseVideoMetadata(JSON.stringify(normal), { maxDurationSec: 900 });

    expect(metadata).toMatchObject({ title: 'Song', artist: 'Band', durationSec: 212 });
  });

  it('rejects live broadcasts', () => {
    const json = JSON.stringify({ ...normal, live_status: 'is_live', is_live: true });

    expect(() => parseVideoMetadata(json, { maxDurationSec: 900 })).toThrow(AppError);
  });

  it('rejects a video longer than the configured maximum', () => {
    const json = JSON.stringify({ ...normal, duration: 7_200 });

    expect(() => parseVideoMetadata(json, { maxDurationSec: 900 })).toThrow(
      expect.objectContaining({ code: 'TRACK_TOO_LONG' }),
    );
  });

  it('rejects a video whose duration is unknown', () => {
    const json = JSON.stringify({ ...normal, duration: null });

    expect(() => parseVideoMetadata(json, { maxDurationSec: 900 })).toThrow(AppError);
  });

  it('rejects videos that need a signed-in account or a subscription', () => {
    const json = JSON.stringify({ ...normal, availability: 'premium_only' });

    expect(() => parseVideoMetadata(json, { maxDurationSec: 900 })).toThrow(
      expect.objectContaining({ code: 'SOURCE_RESTRICTED' }),
    );
  });
});

describe('parsePlaylistEntries', () => {
  it('returns at most the requested number of entries and skips entries without an identifier', () => {
    const json = JSON.stringify({
      entries: [
        { id: 'AAAAAAAAAAA', title: 'One', duration: 60 },
        { title: 'No id' },
        { id: 'BBBBBBBBBBB', title: 'Two', duration: 70 },
        { id: 'CCCCCCCCCCC', title: 'Three', duration: 80 },
      ],
    });

    expect(parsePlaylistEntries(json, 2).map((entry) => entry.id)).toEqual([
      'AAAAAAAAAAA',
      'BBBBBBBBBBB',
    ]);
  });
});

describe('FailureBreaker', () => {
  it('stays closed while consecutive failures are below the threshold', () => {
    const breaker = new FailureBreaker({ threshold: 3, cooldownMs: 1_000 });

    breaker.recordSystemFailure(0);
    breaker.recordSystemFailure(0);

    expect(breaker.isOpen(0)).toBe(false);
  });

  it('opens at the threshold and closes again after the cooldown', () => {
    const breaker = new FailureBreaker({ threshold: 3, cooldownMs: 1_000 });
    breaker.recordSystemFailure(0);
    breaker.recordSystemFailure(0);
    breaker.recordSystemFailure(0);

    expect(breaker.isOpen(500)).toBe(true);
    expect(breaker.isOpen(1_000)).toBe(false);
  });

  it('forgets earlier failures after a success', () => {
    const breaker = new FailureBreaker({ threshold: 3, cooldownMs: 1_000 });
    breaker.recordSystemFailure(0);
    breaker.recordSystemFailure(0);
    breaker.recordSuccess();
    breaker.recordSystemFailure(0);
    breaker.recordSystemFailure(0);

    expect(breaker.isOpen(0)).toBe(false);
  });
});
