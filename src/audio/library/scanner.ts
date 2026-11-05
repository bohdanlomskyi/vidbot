import type { Dirent } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseRelativeLibraryPath } from '../../security/libraryPaths.js';

/** Extensions of files the library accepts. Each one is decodable by FFmpeg. */
export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  '.mp3',
  '.flac',
  '.wav',
  '.ogg',
  '.oga',
  '.opus',
  '.m4a',
  '.aac',
]);

export interface LibraryFileInfo {
  /** Forward-slash path relative to the library root. */
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

export interface ScanResult {
  readonly files: readonly LibraryFileInfo[];
  /** True when the scan stopped at the file limit. */
  readonly truncated: boolean;
}

export interface ScanOptions {
  readonly maxDepth?: number;
  readonly maxFiles?: number;
}

const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_MAX_FILES = 5_000;

/**
 * Walks the library and lists candidate audio files. It skips hidden entries,
 * symlinks, unsafe names and unsupported extensions. Unreadable directories are
 * skipped instead of failing the whole scan. It reads no file contents.
 */
export async function scanLibrary(
  musicDir: string,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const files: LibraryFileInfo[] = [];
  const pending: { absolute: string; relative: string; depth: number }[] = [
    { absolute: musicDir, relative: '', depth: 0 },
  ];
  let truncated = false;

  while (!truncated) {
    const current = pending.pop();
    if (current === undefined) {
      break;
    }

    let entries: Dirent[];
    try {
      entries = await readdir(current.absolute, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) {
        continue;
      }
      const relative = current.relative === '' ? entry.name : `${current.relative}/${entry.name}`;
      const absolute = path.join(current.absolute, entry.name);

      if (entry.isDirectory()) {
        if (current.depth < maxDepth) {
          pending.push({ absolute, relative, depth: current.depth + 1 });
        }
        continue;
      }
      if (!entry.isFile() || !AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }
      if (parseRelativeLibraryPath(relative) === null) {
        continue;
      }
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }

      const info = await lstat(absolute).catch(() => null);
      if (info === null || !info.isFile()) {
        continue;
      }
      files.push({
        relativePath: relative,
        absolutePath: absolute,
        sizeBytes: info.size,
        mtimeMs: info.mtimeMs,
      });
    }
  }

  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { files, truncated };
}
