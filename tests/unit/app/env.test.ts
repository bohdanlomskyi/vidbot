import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDotEnv } from '../../../src/app/env.js';

describe('loadDotEnv', () => {
  let dir: string | undefined;
  const keys = ['MAX_TRACK_DURATION_SEC', 'YOUTUBE_MAX_DURATION_SEC', 'MELODY_ENV_TEST'];

  afterEach(async () => {
    for (const key of keys) {
      Reflect.deleteProperty(process.env, key);
    }
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('lifts the old length limits in the file once, then loads it', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'melody-env-'));
    const file = path.join(dir, '.env');
    await writeFile(
      file,
      'MAX_TRACK_DURATION_SEC=1800\nYOUTUBE_MAX_DURATION_SEC=900\nMELODY_ENV_TEST=yes\n',
    );

    expect(loadDotEnv(dir)).toBe(true);

    expect(process.env.MAX_TRACK_DURATION_SEC).toBe('0');
    expect(process.env.YOUTUBE_MAX_DURATION_SEC).toBe('0');
    expect(process.env.MELODY_ENV_TEST).toBe('yes');
    expect(await readFile(file, 'utf8')).toBe(
      'MAX_TRACK_DURATION_SEC=0\nYOUTUBE_MAX_DURATION_SEC=0\nMELODY_ENV_TEST=yes\n',
    );
  });

  it('reports a missing file', () => {
    expect(loadDotEnv(path.join(os.tmpdir(), 'melody-no-such-dir'))).toBe(false);
  });
});
