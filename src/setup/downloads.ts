import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** FFmpeg for Windows: the "essentials" release build from gyan.dev, linked from ffmpeg.org. */
export const FFMPEG_WINDOWS = {
  url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
  checksumUrl: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip.sha256',
} as const;

const YTDLP_RELEASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';

/** The standalone yt-dlp build for a platform. None of them needs Python. */
export function ytDlpAsset(platform: NodeJS.Platform, arch: string): string {
  if (platform === 'win32') {
    return 'yt-dlp.exe';
  }
  if (platform === 'darwin') {
    return 'yt-dlp_macos';
  }
  return arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
}

export function ytDlpUrls(asset: string): { readonly url: string; readonly checksumUrl: string } {
  return { url: `${YTDLP_RELEASE}/${asset}`, checksumUrl: `${YTDLP_RELEASE}/SHA2-256SUMS` };
}

/**
 * Reads a checksum list ("<sha256>  <file>" per line, as sha256sum writes it). A file that
 * holds only a hash is stored under the empty name.
 */
export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/u)) {
    const match = /^([0-9a-fA-F]{64})(?:\s+\*?(.+))?$/u.exec(line.trim());
    if (match?.[1] !== undefined) {
      sums.set(match[2]?.trim() ?? '', match[1].toLowerCase());
    }
  }
  return sums;
}

export async function fetchText(url: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`Сервер ответил ${String(response.status)} для ${url}`);
  }
  return response.text();
}

export interface VerifiedDownload {
  readonly url: string;
  /** Expected SHA-256 of the file, in hex. */
  readonly sha256: string;
  readonly target: string;
  /** Called with the number of bytes received so far. */
  readonly onProgress?: (bytes: number) => void;
}

/**
 * Downloads to a temporary file, checks its SHA-256, and only then moves it into place.
 * A failed or tampered download leaves nothing behind.
 */
export async function downloadVerified(
  options: VerifiedDownload,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const partial = `${options.target}.part`;
  await mkdir(path.dirname(options.target), { recursive: true });
  try {
    const response = await fetchImpl(options.url);
    if (!response.ok || response.body === null) {
      throw new Error(`Сервер ответил ${String(response.status)} для ${options.url}`);
    }
    const hash = createHash('sha256');
    let received = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        received += chunk.length;
        options.onProgress?.(received);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(partial));
    if (hash.digest('hex') !== options.sha256.toLowerCase()) {
      throw new Error('Файл повреждён: контрольная сумма не совпала. Попробуйте ещё раз.');
    }
    await rename(partial, options.target);
  } finally {
    await rm(partial, { force: true });
  }
}
