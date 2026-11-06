/**
 * CPU cost of turning decoded audio into Opus packets inside the bot process.
 *
 * Each variant feeds the same 60 s of stereo noise through FFmpeg and @discordjs/voice and
 * reads every Opus packet the AudioPlayer would send, as fast as possible. The numbers are
 * the CPU time of the bot's main thread, which also runs every Discord event and command
 * (FFmpeg runs in a child process, an encoder worker in its own thread).
 * Noise is used because it is the hardest input for an Opus encoder.
 *
 *   npx tsx bench/pipeline.bench.ts
 */
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { Readable } from 'node:stream';
import { createAudioResource, StreamType } from '@discordjs/voice';
import { buildFfmpegArgs } from '../src/audio/pipeline/ffmpeg.js';

const SECONDS = 60;
const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const ROUNDS = 3;

interface Variant {
  readonly name: string;
  readonly args: string[];
  readonly inputType: StreamType;
  readonly inlineVolume: boolean;
}

const source = ['-f', 'lavfi', '-i', `anoisesrc=d=${String(SECONDS)}:c=pink:a=0.3`];
const pcmArgs = buildFfmpegArgs({ kind: 'file', path: 'unused' });
const pcmOutput = pcmArgs.slice(pcmArgs.indexOf('-map') + 2);

const VARIANTS: readonly Variant[] = [
  {
    name: 'PCM + inline volume + Opus in Node (before)',
    args: ['-hide_banner', '-loglevel', 'error', ...source, ...pcmOutput],
    inputType: StreamType.Raw,
    inlineVolume: true,
  },
  {
    name: 'PCM + Opus in Node, no inline volume',
    args: ['-hide_banner', '-loglevel', 'error', ...source, ...pcmOutput],
    inputType: StreamType.Raw,
    inlineVolume: false,
  },
  {
    name: 'Opus encoded by FFmpeg, Ogg demuxed in Node',
    args: [
      '-hide_banner',
      '-loglevel',
      'error',
      ...source,
      '-ar',
      '48000',
      '-ac',
      '2',
      '-c:a',
      'libopus',
      '-b:a',
      '128k',
      '-frame_duration',
      '20',
      '-f',
      'ogg',
      'pipe:1',
    ],
    inputType: StreamType.OggOpus,
    inlineVolume: false,
  },
];

async function measure(
  variant: Variant,
): Promise<{ cpuMs: number; wallMs: number; packets: number }> {
  const child = spawn(FFMPEG, variant.args, { stdio: ['ignore', 'pipe', 'inherit'] });
  const stdout: Readable = child.stdout;
  const resource = createAudioResource(stdout, {
    inputType: variant.inputType,
    inlineVolume: variant.inlineVolume,
  });
  resource.volume?.setVolume(0.7);

  const cpuStart = process.threadCpuUsage();
  const wallStart = performance.now();
  let packets = 0;
  resource.playStream.on('data', () => {
    packets += 1;
  });
  await new Promise((resolve) => resource.playStream.once('end', resolve));
  const cpu = process.threadCpuUsage(cpuStart);
  const wallMs = performance.now() - wallStart;
  await new Promise((resolve) => child.once('close', resolve));
  return { cpuMs: (cpu.user + cpu.system) / 1000, wallMs, packets };
}

async function main(): Promise<void> {
  console.log(`Audio: ${String(SECONDS)} s pink noise, ${String(ROUNDS)} rounds, median shown`);
  for (const variant of VARIANTS) {
    const runs = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      runs.push(await measure(variant));
    }
    runs.sort((a, b) => a.cpuMs - b.cpuMs);
    const median = runs[Math.floor(runs.length / 2)];
    if (median === undefined) {
      continue;
    }
    const perAudioSecond = median.cpuMs / SECONDS;
    console.log(
      `${variant.name}\n  bot CPU: ${median.cpuMs.toFixed(0)} ms total, ${perAudioSecond.toFixed(2)} ms per audio second ` +
        `(${((perAudioSecond / 1000) * 100).toFixed(2)} % of one core per stream), packets: ${String(median.packets)}`,
    );
  }
}

await main();
