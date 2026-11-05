import { describe, expect, it } from 'vitest';
import { checkCipher, checkDave, checkOpus } from '../../../src/app/nativeChecks.js';

describe('native dependency checks', () => {
  it('loads the Opus encoder and produces a packet for a 20 ms stereo frame', () => {
    const result = checkOpus();

    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/Opus/u);
  });

  it('creates a DAVE session and serializes its key package', async () => {
    const result = await checkDave();

    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/DAVE/u);
  });

  it('round-trips a message through AES-256-GCM, the cipher the voice transport uses', () => {
    expect(checkCipher().ok).toBe(true);
  });
});
