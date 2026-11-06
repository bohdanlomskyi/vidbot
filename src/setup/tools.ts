import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { readToolVersion } from '../app/tools.js';
import {
  downloadVerified,
  FFMPEG_WINDOWS,
  fetchText,
  parseChecksums,
  ytDlpAsset,
  ytDlpUrls,
} from './downloads.js';

const EXE = process.platform === 'win32' ? '.exe' : '';
const YTDLP_CHECK_MS = 60_000;

export interface FfmpegPaths {
  readonly ffmpeg: string;
  readonly ffprobe: string;
}

function progress(label: string): (bytes: number) => void {
  let shown = -1;
  return (bytes) => {
    const megabytes = Math.floor(bytes / 1_048_576);
    if (megabytes !== shown && process.stdout.isTTY) {
      shown = megabytes;
      process.stdout.write(`\r  ${label}: ${String(megabytes)} МБ`);
    }
  };
}

async function works(
  binary: string,
  args: readonly string[],
  timeoutMs?: number,
): Promise<boolean> {
  return (await readToolVersion(binary, args, timeoutMs)) !== null;
}

/** The bin folder of an FFmpeg that the wizard unpacked into .tools/ffmpeg earlier. */
async function bundledFfmpeg(toolsDir: string): Promise<FfmpegPaths | null> {
  const base = path.join(toolsDir, 'ffmpeg');
  if (!existsSync(base)) {
    return null;
  }
  for (const entry of await readdir(base, { withFileTypes: true })) {
    const bin = path.join(base, entry.name, 'bin');
    const ffmpeg = path.join(bin, `ffmpeg${EXE}`);
    const ffprobe = path.join(bin, `ffprobe${EXE}`);
    if (entry.isDirectory() && existsSync(ffmpeg) && existsSync(ffprobe)) {
      return { ffmpeg, ffprobe };
    }
  }
  return null;
}

/**
 * Finds a working FFmpeg: the configured one, one unpacked by an earlier run, or one on PATH.
 * Returns null when there is none.
 */
export async function findFfmpeg(
  toolsDir: string,
  configured: FfmpegPaths,
): Promise<FfmpegPaths | null> {
  const candidates: FfmpegPaths[] = [configured];
  const bundled = await bundledFfmpeg(toolsDir);
  if (bundled !== null) {
    candidates.push(bundled);
  }
  candidates.push({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' });
  for (const candidate of candidates) {
    if (
      (await works(candidate.ffmpeg, ['-version'])) &&
      (await works(candidate.ffprobe, ['-version']))
    ) {
      return candidate;
    }
  }
  return null;
}

function unzip(archive: string, destination: string): Promise<void> {
  // Windows 10 and 11 ship bsdtar, which reads zip files. PowerShell is the fallback.
  const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  const run = (command: string, args: readonly string[]): Promise<void> =>
    new Promise((resolve, reject) => {
      execFile(command, args, { windowsHide: true, timeout: 600_000 }, (error: Error | null) => {
        if (error === null) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
  return run(tar, ['-xf', archive, '-C', destination]).catch(() =>
    run('powershell', [
      '-NoProfile',
      '-Command',
      '& { Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force }',
      archive,
      destination,
    ]),
  );
}

/** Windows only: downloads the FFmpeg essentials build into .tools/ffmpeg, checking its SHA-256. */
export async function downloadFfmpeg(toolsDir: string): Promise<FfmpegPaths> {
  const sha256 = parseChecksums(await fetchText(FFMPEG_WINDOWS.checksumUrl)).get('');
  if (sha256 === undefined) {
    throw new Error('Не удалось получить контрольную сумму FFmpeg.');
  }
  const archive = path.join(toolsDir, 'ffmpeg.zip');
  const staging = path.join(toolsDir, 'ffmpeg.unpacking');
  const target = path.join(toolsDir, 'ffmpeg');
  await downloadVerified({
    url: FFMPEG_WINDOWS.url,
    sha256,
    target: archive,
    onProgress: progress('FFmpeg'),
  });
  process.stdout.write('\n  Распаковка…\n');
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    await unzip(archive, staging);
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
  } finally {
    await rm(archive, { force: true });
    await rm(staging, { recursive: true, force: true });
  }
  const found = await bundledFfmpeg(toolsDir);
  if (found === null) {
    throw new Error('В архиве FFmpeg не нашлось ffmpeg и ffprobe.');
  }
  return found;
}

/** Finds a working yt-dlp: the configured one, one downloaded earlier, or one on PATH. */
export async function findYtDlp(toolsDir: string, configured: string): Promise<string | null> {
  const bundled = path.join(toolsDir, `yt-dlp${EXE}`);
  const candidates = [configured, ...(existsSync(bundled) ? [bundled] : []), 'yt-dlp'];
  for (const candidate of [...new Set(candidates)]) {
    if (await works(candidate, ['--version'], YTDLP_CHECK_MS)) {
      return candidate;
    }
  }
  return null;
}

/** Downloads the standalone yt-dlp for this platform into .tools, checking its SHA-256. */
export async function downloadYtDlp(toolsDir: string): Promise<string> {
  const asset = ytDlpAsset(process.platform, process.arch);
  const urls = ytDlpUrls(asset);
  const sha256 = parseChecksums(await fetchText(urls.checksumUrl)).get(asset);
  if (sha256 === undefined) {
    throw new Error(`Не удалось получить контрольную сумму ${asset}.`);
  }
  const target = path.join(toolsDir, `yt-dlp${EXE}`);
  await downloadVerified({ url: urls.url, sha256, target, onProgress: progress('yt-dlp') });
  process.stdout.write('\n');
  if (process.platform !== 'win32') {
    await chmod(target, 0o755);
  }
  return target;
}
