import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAudioResource, StreamType } from '@discordjs/voice';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPcmDecoder } from '../../../src/audio/pipeline/ffmpeg.js';
import { createSineFixture } from '../../helpers/ffmpeg.js';

describe('Opus encoding of decoded audio', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'melody-opus-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('turns a decoded one-second tone into about fifty Opus packets', async () => {
    const file = join(dir, 'tone.wav');
    await createSineFixture('ffmpeg', file, 1);

    const decoder = startPcmDecoder({ ffmpegPath: 'ffmpeg', input: { kind: 'file', path: file } });
    const resource = createAudioResource(decoder.stream, { inputType: StreamType.Raw });
    const packets: Buffer[] = [];
    for await (const packet of resource.playStream) {
      packets.push(packet as Buffer);
    }
    const exit = await decoder.done;

    expect(exit.code).toBe(0);
    // One second of audio is 50 frames of 20 ms. Allow a few extra frames for edge padding.
    expect(packets.length).toBeGreaterThanOrEqual(45);
    expect(packets.length).toBeLessThanOrEqual(55);
    for (const packet of packets) {
      expect(packet.length).toBeGreaterThan(0);
      expect(packet.length).toBeLessThan(1500);
    }
  }, 60_000);
});
