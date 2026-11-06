/**
 * CPU cost of turning decoded audio into the Opus packets the voice player sends.
 *
 * Each variant decodes the same 60 s of stereo pink noise with FFmpeg and reads every packet
 * through the bot's own createPlayerResource, as fast as possible. Two numbers are reported:
 * - main thread: CPU time on the thread that also runs every Discord event and command;
 * - whole process: main thread plus the Opus worker thread (FFmpeg is a child process and is
 *   the same in every variant, so it is left out).
 * Noise is used because it is the hardest input for an Opus encoder.
 *
 *   npx tsx bench/pipeline.bench.ts
 */
import { spawn } from 'node:child_process';
import { OpusWorkerEncoder } from '../src/audio/opus/opusWorkerEncoder.js';
import { buildFfmpegArgs } from '../src/audio/pipeline/ffmpeg.js';
import { createPlayerResource } from '../src/discord/voice/discordVoice.js';

const SECONDS = 60;
const ROUNDS = 5;
const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const GAIN = 0.7;

const pcmArgs = buildFfmpegArgs({ kind: 'file', path: 'unused' });
const decodeArgs = [
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  `anoisesrc=d=${String(SECONDS)}:c=pink:a=0.3`,
  ...pcmArgs.slice(pcmArgs.indexOf('-map') + 2),
];

interface Sample {
  readonly mainMs: number;
  readonly processMs: number;
  readonly packets: number;
}

async function measure(encoder: OpusWorkerEncoder | null): Promise<Sample> {
  const child = spawn(FFMPEG, decodeArgs, { stdio: ['ignore', 'pipe', 'inherit'] });
  // FFmpeg can exit before the last packets are read, so listen for that from the start.
  const exited = new Promise((resolve) => child.once('close', resolve));
  const { resource } = createPlayerResource(child.stdout, GAIN, encoder);

  const mainStart = process.threadCpuUsage();
  const processStart = process.cpuUsage();
  let packets = 0;
  resource.playStream.on('data', () => {
    packets += 1;
  });
  await new Promise((resolve) => resource.playStream.once('end', resolve));
  const main = process.threadCpuUsage(mainStart);
  const whole = process.cpuUsage(processStart);
  await exited;
  return {
    mainMs: (main.user + main.system) / 1000,
    processMs: (whole.user + whole.system) / 1000,
    packets,
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function report(name: string, encoder: OpusWorkerEncoder | null): Promise<void> {
  await measure(encoder);
  const samples: Sample[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    samples.push(await measure(encoder));
  }
  const main = median(samples.map((sample) => sample.mainMs));
  const whole = median(samples.map((sample) => sample.processMs));
  const perSecond = main / SECONDS;
  console.log(
    `${name}\n` +
      `  main thread: ${main.toFixed(0)} ms (${perSecond.toFixed(2)} ms per audio second, ` +
      `${((perSecond / 1000) * 100).toFixed(2)} % of a core per stream)\n` +
      `  whole process: ${whole.toFixed(0)} ms, packets: ${String(samples[0]?.packets ?? 0)}`,
  );
}

const worker = await OpusWorkerEncoder.start(console);
console.log(
  `${String(SECONDS)} s of pink noise at gain ${String(GAIN)}, median of ${String(ROUNDS)}`,
);
await report('Before: Opus and volume on the main thread', null);
if (worker === null) {
  console.log('The Opus worker did not start');
} else {
  await report('After: Opus and volume in the worker thread', worker);
  await worker.dispose();
}
