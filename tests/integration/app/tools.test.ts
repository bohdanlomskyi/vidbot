import { describe, expect, it } from 'vitest';
import { readToolVersion } from '../../../src/app/tools.js';

describe('readToolVersion', () => {
  it('returns the first line of the tool version output', async () => {
    expect(await readToolVersion('ffmpeg', ['-version'])).toMatch(/^ffmpeg version \S+/);
  });

  it('returns null when the binary does not exist', async () => {
    expect(await readToolVersion('melody-no-such-binary', ['-version'])).toBeNull();
  });

  it('returns null when the tool rejects the arguments', async () => {
    expect(await readToolVersion('ffmpeg', ['--melody-invalid-option'])).toBeNull();
  });
});
