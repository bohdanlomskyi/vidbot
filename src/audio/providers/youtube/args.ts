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

/** The fields printed with the stream, so one yt-dlp run gives both the audio and the metadata. */
const PRINTED_FIELDS =
  '%(.{id,title,duration,channel,uploader,thumbnail,is_live,live_status,availability})j';

export interface StreamArgsOptions {
  /**
   * Also print one JSON line of metadata. With `-o -` yt-dlp writes it to standard error, and
   * `--no-simulate` keeps the download going (a plain `--print` would switch it off).
   */
  readonly printMetadata?: boolean;
}

/** Best audio of a single video, written to standard output for FFmpeg to read. */
export function buildStreamArgs(
  url: string,
  options: YtDlpBaseOptions,
  extra: StreamArgsOptions = {},
): string[] {
  assertCanonical(url);
  const print = extra.printMetadata === true ? ['--print', PRINTED_FIELDS, '--no-simulate'] : [];
  return [
    ...baseFlags(options),
    '--no-playlist',
    '-f',
    'bestaudio/best',
    ...print,
    '-o',
    '-',
    '--',
    url,
  ];
}

const MAX_SEARCH_QUERY = 200;
const MAX_SEARCH_COUNT = 10;

/** Collapses whitespace and refuses control characters. Throws RangeError for a bad query. */
export function normalizeSearchQuery(query: string): string {
  const collapsed = query.trim().replace(/\s+/g, ' ');
  for (const character of collapsed) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      throw new RangeError('The search query contains control characters');
    }
  }
  return collapsed;
}

/**
 * A YouTube text search: the first results as a flat listing. The query follows the end-of-options
 * marker and the `ytsearchN:` prefix, so it is always read as search text and never as a flag.
 */
export function buildSearchArgs(query: string, count: number, options: YtDlpBaseOptions): string[] {
  const text = normalizeSearchQuery(query);
  if (text === '' || text.length > MAX_SEARCH_QUERY) {
    throw new RangeError('The search query must be 1 to 200 characters');
  }
  if (!Number.isInteger(count) || count < 1 || count > MAX_SEARCH_COUNT) {
    throw new RangeError('The search result count must be 1 to 10');
  }
  return [
    ...baseFlags(options),
    '--flat-playlist',
    '--dump-single-json',
    '--',
    `ytsearch${String(count)}:${text}`,
  ];
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
