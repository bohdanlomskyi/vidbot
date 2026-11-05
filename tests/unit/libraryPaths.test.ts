import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  libraryTrackId,
  parseRelativeLibraryPath,
  resolveInsideRoot,
} from '../../src/security/libraryPaths.js';

describe('parseRelativeLibraryPath', () => {
  it.each<[string, string]>([
    ['Album/Track 01.mp3', 'Album/Track 01.mp3'],
    ['track.flac', 'track.flac'],
  ])('accepts the plain relative path %s', (input, expected) => {
    expect(parseRelativeLibraryPath(input)).toBe(expected);
  });

  it.each<string>([
    '',
    '/etc/passwd',
    '../secret.mp3',
    'Album/../../secret.mp3',
    'C:/music/x.mp3',
    'Album\\track.mp3',
    'a\u0000b.mp3',
    'Album//track.mp3',
    './track.mp3',
  ])('rejects the unsafe path %j', (input) => {
    expect(parseRelativeLibraryPath(input)).toBeNull();
  });
});

describe('libraryTrackId', () => {
  it('derives a stable opaque identifier with no path characters', () => {
    const id = libraryTrackId('Album/Track 01.mp3');

    expect(id).toMatch(/^lib-[0-9a-f]{12}$/);
    expect(libraryTrackId('Album/Track 01.mp3')).toBe(id);
    expect(libraryTrackId('Album/Track 02.mp3')).not.toBe(id);
  });
});

describe('resolveInsideRoot', () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeEach(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), 'melody-library-'));
    root = path.join(base, 'music');
    outside = path.join(base, 'outside');
    await mkdir(path.join(root, 'Album'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(root, 'Album', 'track.mp3'), 'audio');
    await writeFile(path.join(outside, 'secret.mp3'), 'secret');
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('resolves a relative path to the file inside the library', async () => {
    const resolved = await resolveInsideRoot(root, 'Album/track.mp3');

    expect(resolved).toBe(await realpath(path.join(root, 'Album', 'track.mp3')));
  });

  it('rejects traversal out of the library with an invalid-input error', async () => {
    await expect(resolveInsideRoot(root, '../outside/secret.mp3')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('rejects a missing file with a not-found error', async () => {
    await expect(resolveInsideRoot(root, 'Album/missing.mp3')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a symlink that points outside the library',
    async () => {
      await symlink(path.join(outside, 'secret.mp3'), path.join(root, 'linked.mp3'));

      await expect(resolveInsideRoot(root, 'linked.mp3')).rejects.toMatchObject({
        code: 'NOT_ALLOWED',
      });
    },
  );
});
