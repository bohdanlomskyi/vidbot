import { describe, expect, it } from 'vitest';
import {
  buildMetadataArgs,
  buildPlaylistArgs,
  buildStreamArgs,
  type YtDlpBaseOptions,
} from '../../src/audio/providers/youtube/args.js';

const BASE: YtDlpBaseOptions = { jsRuntime: 'node', cacheDir: '/var/cache/melody' };
const VIDEO = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const PLAYLIST = 'https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf';

// Flags that read credentials, route traffic, run commands or write arbitrary files.
const FORBIDDEN =
  /^--(cookies|cookies-from-browser|proxy|exec|config-location|downloader|external-downloader|batch-file|load-info|username|password|netrc|add-header|source-address|output-na)/;

describe('yt-dlp argument builders', () => {
  it('never passes flags that read credentials, route traffic or run commands', () => {
    const everything = [
      buildMetadataArgs(VIDEO, BASE),
      buildStreamArgs(VIDEO, BASE),
      buildPlaylistArgs(PLAYLIST, 10, BASE),
    ];

    for (const args of everything) {
      expect(args.filter((arg) => FORBIDDEN.test(arg))).toEqual([]);
    }
  });

  it('ignores user configuration files and disables self-update', () => {
    expect(buildMetadataArgs(VIDEO, BASE)).toEqual(
      expect.arrayContaining(['--ignore-config', '--no-update']),
    );
  });

  it('selects the configured JavaScript runtime explicitly', () => {
    const args = buildStreamArgs(VIDEO, BASE);

    expect(args[args.indexOf('--js-runtimes') + 1]).toBe('node');
  });

  it('places the canonical URL after the end-of-options marker', () => {
    const args = buildStreamArgs(VIDEO, BASE);

    expect(args.at(-2)).toBe('--');
    expect(args.at(-1)).toBe(VIDEO);
  });

  it('streams the best audio to standard output', () => {
    const args = buildStreamArgs(VIDEO, BASE);

    expect(args[args.indexOf('-o') + 1]).toBe('-');
    expect(args[args.indexOf('-f') + 1]).toMatch(/bestaudio/);
  });

  it('limits playlist expansion to the requested number of items', () => {
    const args = buildPlaylistArgs(PLAYLIST, 10, BASE);

    expect(args[args.indexOf('--playlist-end') + 1]).toBe('10');
  });

  it('refuses a URL that is not a canonical YouTube address', () => {
    expect(() => buildMetadataArgs('--cookies=/etc/passwd', BASE)).toThrow(RangeError);
    expect(() => buildStreamArgs('https://example.com/video', BASE)).toThrow(RangeError);
  });
});
