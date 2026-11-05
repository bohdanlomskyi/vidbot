import { type ChildProcessByStdio, spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

export const PCM_SAMPLE_RATE = 48_000;
export const PCM_CHANNELS = 2;

const STDERR_LIMIT = 4096;
const CLOSE_GRACE_MS = 2_000;

export type PcmInput =
  | { readonly kind: 'file'; readonly path: string; readonly startSec?: number }
  | { readonly kind: 'pipe' };

/**
 * Builds the FFmpeg argument vector. Arguments are passed as an array and never
 * through a shell. File inputs are limited to the local file protocol, so a playlist
 * file cannot make FFmpeg open network addresses.
 */
export function buildFfmpegArgs(input: PcmInput): string[] {
  const args = ['-hide_banner', '-loglevel', 'error'];

  if (input.kind === 'file') {
    args.push('-nostdin', '-protocol_whitelist', 'file');
    if (input.startSec !== undefined && input.startSec > 0) {
      args.push('-ss', input.startSec.toFixed(3));
    }
    args.push('-i', input.path);
  } else {
    args.push('-protocol_whitelist', 'pipe', '-i', 'pipe:0');
  }

  args.push(
    '-map',
    '0:a:0',
    '-vn',
    '-sn',
    '-dn',
    '-f',
    's16le',
    '-acodec',
    'pcm_s16le',
    '-ar',
    String(PCM_SAMPLE_RATE),
    '-ac',
    String(PCM_CHANNELS),
    'pipe:1',
  );
  return args;
}

export interface DecoderExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** The first few kilobytes of FFmpeg diagnostics, for logs only. */
  readonly stderr: string;
  /** Set when the FFmpeg binary could not be started at all. */
  readonly spawnError: Error | null;
}

export interface PcmDecoder {
  /** Decoded PCM. The consumer must read it or call close(), otherwise FFmpeg blocks. */
  readonly stream: Readable;
  readonly pid: number | undefined;
  /**
   * Resolves once the FFmpeg process has exited. Decoded output may still be buffered for
   * the consumer, so a finished `done` does not mean the audio has been played.
   */
  readonly done: Promise<DecoderExit>;
  /** Terminates FFmpeg (SIGTERM, then SIGKILL after a grace period). Idempotent. */
  close(): Promise<void>;
}

export interface StartDecoderOptions {
  readonly ffmpegPath: string;
  readonly input: PcmInput;
  /** Required for pipe input. The decoder takes ownership and destroys it on close. */
  readonly source?: Readable;
}

export function startPcmDecoder(options: StartDecoderOptions): PcmDecoder {
  const isPipe = options.input.kind === 'pipe';
  const source = options.source;
  if (isPipe !== (source !== undefined)) {
    throw new TypeError('A pipe input needs a source stream, and a file input must not have one.');
  }

  // The stdio layout is fixed above, so stdout and stderr are always present.
  const child = spawn(options.ffmpegPath, buildFfmpegArgs(options.input), {
    stdio: [isPipe ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }) as ChildProcessByStdio<Writable | null, Readable, Readable>;

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    if (stderr.length < STDERR_LIMIT) {
      stderr += chunk.slice(0, STDERR_LIMIT - stderr.length);
    }
  });

  const done = new Promise<DecoderExit>((resolve) => {
    child.once('error', (spawnError) => {
      // The output ends without an error event, so the consumer treats it as a
      // normal end of stream. Callers must check `done` for a spawn error.
      child.stdout.destroy();
      resolve({ code: null, signal: null, stderr, spawnError });
    });
    // 'exit' rather than 'close': 'close' waits for stdout to be consumed, and a consumer
    // that is paused or has stopped reading would block it forever.
    child.once('exit', (code, signal) => {
      resolve({ code, signal, stderr, spawnError: null });
    });
  });

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const exitedInTime = await waitFor(done, CLOSE_GRACE_MS);
        if (!exitedInTime) {
          child.kill('SIGKILL');
        }
      }
      await done;
      child.stdout.destroy();
      source?.destroy();
    })();
    return closing;
  };

  if (source !== undefined && child.stdin !== null) {
    // EPIPE is expected when FFmpeg exits before the source is exhausted.
    child.stdin.on('error', () => undefined);
    source.on('error', () => {
      // Ending stdin lets FFmpeg finish on its own. A process blocked on a read ignores
      // SIGTERM, so close() escalates to SIGKILL after the grace period.
      child.stdin?.destroy();
      void close();
    });
    source.pipe(child.stdin);
  }

  return { stream: child.stdout, pid: child.pid, done, close };
}

async function waitFor(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
