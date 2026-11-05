import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPcmDecoder } from '../../src/audio/pipeline/ffmpeg.js';
import { countBytes, createSineFixture, isProcessRunning } from '../helpers/ffmpeg.js';

const FFMPEG = process.env.MELODY_FFMPEG_PATH ?? 'ffmpeg';
const BYTES_PER_SECOND = 48_000 * 2 * 2; // 48 kHz, stereo, 16-bit

describe('startPcmDecoder with real FFmpeg', () => {
  let dir: string;
  let twoSecondTone: string;
  let longTone: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'melody-ffmpeg-'));
    twoSecondTone = path.join(dir, 'tone-2s.wav');
    longTone = path.join(dir, 'tone-30s.wav');
    await createSineFixture(FFMPEG, twoSecondTone, 2);
    await createSineFixture(FFMPEG, longTone, 30);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('decodes a whole file into the expected amount of PCM and exits cleanly', async () => {
    const decoder = startPcmDecoder({
      ffmpegPath: FFMPEG,
      input: { kind: 'file', path: twoSecondTone },
    });

    const bytes = await countBytes(decoder.stream);
    const exit = await decoder.done;

    expect(Math.abs(bytes - 2 * BYTES_PER_SECOND)).toBeLessThan(BYTES_PER_SECOND / 100);
    expect(exit.code).toBe(0);
    expect(exit.spawnError).toBeNull();
  });

  it('stops the FFmpeg process and leaves no orphan when closed early', async () => {
    const decoder = startPcmDecoder({
      ffmpegPath: FFMPEG,
      input: { kind: 'file', path: longTone },
    });
    const pid = decoder.pid;
    expect(pid).toBeDefined();

    // Read one chunk and pause. FFmpeg is then blocked on a full pipe, as it is during a
    // real stop. Breaking out of a for-await loop would destroy stdout and let FFmpeg
    // exit on SIGPIPE, which would skip the termination path this test exists to check.
    const firstChunk = await new Promise<Buffer>((resolve) => {
      decoder.stream.once('data', (chunk: Buffer) => {
        decoder.stream.pause();
        resolve(chunk);
      });
    });
    expect(firstChunk.length).toBeGreaterThan(0);

    const startedClosing = Date.now();
    await decoder.close();
    const closeDurationMs = Date.now() - startedClosing;
    await decoder.done;

    expect(closeDurationMs).toBeLessThan(1_500);
    expect(pid !== undefined && isProcessRunning(pid)).toBe(false);
  });

  it('reports a failing exit and stderr when the input file does not exist', async () => {
    const decoder = startPcmDecoder({
      ffmpegPath: FFMPEG,
      input: { kind: 'file', path: path.join(dir, 'missing.mp3') },
    });

    const bytes = await countBytes(decoder.stream);
    const exit = await decoder.done;

    expect(bytes).toBe(0);
    expect(exit.code).not.toBe(0);
    expect(exit.stderr.length).toBeGreaterThan(0);
  });

  it('reports a spawn error instead of hanging when the FFmpeg binary is missing', async () => {
    const decoder = startPcmDecoder({
      ffmpegPath: path.join(dir, 'no-such-ffmpeg-binary'),
      input: { kind: 'file', path: twoSecondTone },
    });

    const exit = await decoder.done;

    expect(exit.spawnError).toBeInstanceOf(Error);
  });

  it('decodes piped input to the same amount of PCM as file input', async () => {
    const source = Readable.from(createReadStream(twoSecondTone));
    const decoder = startPcmDecoder({
      ffmpegPath: FFMPEG,
      input: { kind: 'pipe' },
      source,
    });

    const bytes = await countBytes(decoder.stream);
    await decoder.done;

    expect(Math.abs(bytes - 2 * BYTES_PER_SECOND)).toBeLessThan(BYTES_PER_SECOND / 100);
  });
});
