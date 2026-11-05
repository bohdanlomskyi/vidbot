import { describe, expect, it } from 'vitest';
import { parseYouTubeInput } from '../../src/audio/providers/youtube/url.js';

describe('parseYouTubeInput recognises supported links', () => {
  it.each<[string, 'video' | 'playlist', string]>([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'video', 'dQw4w9WgXcQ'],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'video', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?si=abc123', 'video', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'video', 'dQw4w9WgXcQ'],
    [
      'https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDAMVMdQw4w9WgXcQ',
      'video',
      'dQw4w9WgXcQ',
    ],
    [
      'https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf',
      'playlist',
      'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf',
    ],
  ])('%s is a %s with id %s', (input, kind, id) => {
    expect(parseYouTubeInput(input)).toMatchObject({ kind, id });
  });

  it('builds a canonical URL so raw user input never reaches yt-dlp', () => {
    expect(parseYouTubeInput('https://youtu.be/dQw4w9WgXcQ?si=x&t=10')?.canonicalUrl).toBe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    );
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(parseYouTubeInput('  https://youtu.be/dQw4w9WgXcQ  ')).toMatchObject({ kind: 'video' });
  });
});

describe('parseYouTubeInput rejects everything else', () => {
  it.each<string>([
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/watch?v=dQw4w9WgXc!',
    'https://example.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com.evil.test/watch?v=dQw4w9WgXcQ',
    'https://user:pass@www.youtube.com/watch?v=dQw4w9WgXcQ',
    'ftp://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/channel/UC1234567890',
    'dQw4w9WgXcQ',
    '--cookies-from-browser=chrome',
  ])('rejects %j', (input) => {
    expect(parseYouTubeInput(input)).toBeNull();
  });
});
