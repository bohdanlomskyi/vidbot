/**
 * Argument builders for yt-dlp. Every call uses an allowlisted flag set, ignores the user's
 * configuration files, never updates itself, and receives only a canonical YouTube URL after
 * the end-of-options marker. Flags that read cookies, route traffic, run commands or write
 * arbitrary files are never added here.
 */

export interface YtDlpBaseOptions {
  readonly jsRuntime: 'node' | 'deno';
  /** Cache for yt-dlp's own solver scripts. It holds no media. */
  readonly cacheDir: string;
}

const CANONICAL_URL =
  /^https:\/\/www\.youtube\.com\/(?:watch\?v=[A-Za-z0-9_-]{11}|playlist\?list=[A-Za-z0-9_-]{10,64})$/;

function assertCanonical(url: string): void {
  if (!CANONICAL_URL.test(url)) {
    throw new RangeError('yt-dlp may only receive canonical YouTube URLs');
  }
}

function baseFlags(options: YtDlpBaseOptions): string[] {
  return [
    '--ignore-config',
    '--no-update',
    '--no-warnings',
    '--no-progress',
    '--js-runtimes',
    options.jsRuntime,
    '--cache-dir',
    options.cacheDir,
    '--socket-timeout',
    '20',
  ];
}

/** Metadata for a single video, printed as one JSON object. Nothing is downloaded. */
export function buildMetadataArgs(url: string, options: YtDlpBaseOptions): string[] {
  assertCanonical(url);
  return [
    ...baseFlags(options),
    '--no-playlist',
    '--skip-download',
    '--dump-single-json',
    '--',
    url,
  ];
}

/** Best audio of a single video, written to standard output for FFmpeg to read. */
export function buildStreamArgs(url: string, options: YtDlpBaseOptions): string[] {
  assertCanonical(url);
  return [...baseFlags(options), '--no-playlist', '-f', 'bestaudio/best', '-o', '-', '--', url];
}

/** Flat listing of a playlist, limited to its first `maxItems` entries. */
export function buildPlaylistArgs(
  url: string,
  maxItems: number,
  options: YtDlpBaseOptions,
): string[] {
  assertCanonical(url);
  return [
    ...baseFlags(options),
    '--flat-playlist',
    '--yes-playlist',
    '--playlist-end',
    String(maxItems),
    '--dump-single-json',
    '--',
    url,
  ];
}
