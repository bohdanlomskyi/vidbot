import { createRequire } from 'node:module';
import { PassThrough, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpusWorkerEncoder } from '../../../src/audio/opus/opusWorkerEncoder.js';
import { createPlayerResource } from '../../../src/discord/voice/discordVoice.js';

interface OpusModule {
  readonly OpusEncoder: new (
    rate: number,
    channels: number,
  ) => { decode(packet: Buffer): Buffer; encode(frame: Buffer): Buffer };
}

const { OpusEncoder } = createRequire(import.meta.url)('@discordjs/opus') as OpusModule;

const FRAME_BYTES = 3840;
const silentLog = { warn: () => undefined, error: () => undefined };

/** One second of a 440 Hz stereo tone at half scale, as 16-bit PCM. */
function tone(seconds: number, amplitude = 16_000): Buffer {
  const samples = 48_000 * seconds;
  const pcm = Buffer.alloc(samples * 4);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * index) / 48_000));
    pcm.writeInt16LE(value, index * 4);
    pcm.writeInt16LE(value, index * 4 + 2);
  }
  return pcm;
}

/** Feeds PCM in pieces that do not line up with Opus frames, as FFmpeg's pipe does. */
function pcmSource(pcm: Buffer, chunk = 10_000): Readable {
  const source = new PassThrough();
  for (let offset = 0; offset < pcm.length; offset += chunk) {
    source.write(pcm.subarray(offset, offset + chunk));
  }
  source.end();
  return source;
}

async function collect(stream: Readable): Promise<Buffer[]> {
  const packets: Buffer[] = [];
  for await (const packet of stream) {
    packets.push(packet as Buffer);
  }
  return packets;
}

/** Root mean square of the decoded audio, ignoring the encoder's first frames. */
function loudness(packets: readonly Buffer[]): number {
  const decoder = new OpusEncoder(48_000, 2);
  let sum = 0;
  let count = 0;
  for (const packet of packets.slice(5)) {
    const pcm = decoder.decode(packet);
    for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
      const sample = pcm.readInt16LE(offset);
      sum += sample * sample;
      count += 1;
    }
  }
  return Math.sqrt(sum / Math.max(1, count));
}

describe('OpusWorkerEncoder', () => {
  let encoder: OpusWorkerEncoder;

  beforeAll(async () => {
    const started = await OpusWorkerEncoder.start(silentLog);
    if (started === null) {
      throw new Error('The Opus worker did not start');
    }
    encoder = started;
  });

  afterAll(async () => {
    await encoder.dispose();
  });

  it('turns one second of PCM into fifty 20 ms Opus packets that decode back to the audio', async () => {
    const encoded = encoder.open(1);
    const [packets] = await Promise.all([
      collect(encoded.stream),
      pipeline(pcmSource(tone(1)), encoded.stream),
    ]);

    expect(packets).toHaveLength(48_000 / 960);
    expect(new OpusEncoder(48_000, 2).decode(packets[10] ?? Buffer.alloc(0))).toHaveLength(
      FRAME_BYTES,
    );
    expect(loudness(packets)).toBeGreaterThan(9_000);
  });

  it('applies the gain in the worker, and a later change affects the audio that follows', async () => {
    const full = encoder.open(1);
    const half = encoder.open(0.5);
    const [fullPackets, halfPackets] = await Promise.all([
      collect(full.stream),
      collect(half.stream),
      pipeline(pcmSource(tone(1)), full.stream),
      pipeline(pcmSource(tone(1)), half.stream),
    ]);
    expect(loudness(halfPackets) / loudness(fullPackets)).toBeCloseTo(0.5, 1);

    const changing = encoder.open(1);
    const source = new PassThrough();
    const collected = collect(changing.stream);
    const feeding = pipeline(source, changing.stream);
    source.write(tone(1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    changing.setGain(0);
    source.end(tone(1));
    await feeding;
    const packets = await collected;
    expect(loudness(packets.slice(0, 50))).toBeGreaterThan(9_000);
    expect(loudness(packets.slice(60))).toBeLessThan(50);
  });

  it('releases the worker-side encoder when the stream is destroyed', async () => {
    const encoded = encoder.open(1);
    const source = new PassThrough();
    source.pipe(encoded.stream);
    source.write(tone(0.2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(encoder.activeStreams).toBeGreaterThan(0);

    encoded.stream.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(encoder.activeStreams).toBe(0);
  });

  it('gives the voice player finished packets through the same resource builder the bot uses', async () => {
    const { resource, setGain } = createPlayerResource(pcmSource(tone(1)), 0.8, encoder);
    setGain(0.5);

    const packets = await collect(resource.playStream);

    expect(resource.volume).toBeUndefined();
    expect(packets).toHaveLength(50);
  });
});
