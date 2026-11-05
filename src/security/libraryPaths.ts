import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../utils/errors.js';

const MAX_RELATIVE_LENGTH = 512;

/**
 * Validates a path relative to the music library and returns it in canonical
 * form with forward slashes. Returns null for absolute paths, drive letters,
 * dot segments, empty segments, backslashes and control characters.
 */
export function parseRelativeLibraryPath(input: string): string | null {
  if (input.length === 0 || input.length > MAX_RELATIVE_LENGTH) {
    return null;
  }
  if (hasControlCharacter(input) || input.includes('\\')) {
    return null;
  }
  if (input.startsWith('/') || /^[A-Za-z]:/.test(input)) {
    return null;
  }

  const segments = input.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return null;
  }
  return segments.join('/');
}

/**
 * Derives the internal track identifier from the relative path. The identifier
 * is opaque, stable across restarts, and contains no path characters.
 */
export function libraryTrackId(relativePath: string): string {
  const digest = createHash('sha256').update(relativePath, 'utf8').digest('hex');
  return `lib-${digest.slice(0, 12)}`;
}

/**
 * Resolves a library file to its real location. The file must exist, must not
 * be a symlink, and must resolve to a location inside `root`.
 */
export async function resolveInsideRoot(root: string, relativePath: string): Promise<string> {
  const normalized = parseRelativeLibraryPath(relativePath);
  if (normalized === null) {
    throw new AppError('INVALID_INPUT', 'Недопустимый путь к файлу библиотеки.');
  }

  const rootReal = await realpath(root);
  const candidate = path.join(root, ...normalized.split('/'));

  let info;
  try {
    info = await lstat(candidate);
  } catch (error) {
    throw new AppError('NOT_FOUND', 'Файл не найден в библиотеке.', { cause: error });
  }
  if (info.isSymbolicLink()) {
    throw new AppError('NOT_ALLOWED', 'Символические ссылки в библиотеке не поддерживаются.');
  }

  const real = await realpath(candidate);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    throw new AppError('NOT_ALLOWED', 'Файл находится за пределами библиотеки.');
  }
  if (!info.isFile()) {
    throw new AppError('NOT_FOUND', 'Файл не найден в библиотеке.');
  }
  return real;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}
