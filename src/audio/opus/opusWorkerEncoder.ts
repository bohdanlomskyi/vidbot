import { createRequire } from 'node:module';
import { Transform, type TransformCallback } from 'node:stream';
import { Worker } from 'node:worker_threads';
import type { Logger } from 'pino';

/**
 * The worker's code. It is plain CommonJS so it runs the same under tsx, Vitest and the
 * compiled build, with no loader. It owns one libopus encoder per stream, applies the gain
 * to the 16-bit samples, and returns whole 20 ms packets. A partial frame waits for the next
 * chunk; the last partial frame of a stream is dropped, as @discordjs/voice does.
 */
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { OpusEncoder } = require(workerData.opusPath);
const FRAME_BYTES = 3840;
const streams = new Map();

function applyGain(frame, gain) {
  const samples = new Int16Array(frame.buffer, frame.byteOffset, frame.length / 2);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.round(samples[index] * gain);
    samples[index] = value > 32767 ? 32767 : value < -32768 ? -32768 : value;
  }
}

parentPort.on('message', (message) => {
  if (message.op === 'open') {
    streams.set(message.id, { encoder: new OpusEncoder(48000, 2), gain: message.gain, rest: null });
    return;
  }
  const stream = streams.get(message.id);
  if (stream === undefined) {
    return;
  }
  if (message.op === 'close') {
    streams.delete(message.id);
    return;
  }
  if (message.op === 'gain') {
    stream.gain = message.gain;
    return;
  }
  try {
    let pcm = Buffer.from(message.data);
    if (stream.rest !== null) {
      pcm = Buffer.concat([stream.rest, pcm]);
      stream.rest = null;
    }
    const packets = [];
    let offset = 0;
    for (; offset + FRAME_BYTES <= pcm.length; offset += FRAME_BYTES) {
      const frame = pcm.subarray(offset, offset + FRAME_BYTES);
      if (stream.gain !== 1) {
        applyGain(frame, stream.gain);
      }
      const packet = stream.encoder.encode(frame);
      packets.push(packet.buffer.slice(packet.byteOffset, packet.byteOffset + packet.byteLength));
    }
    if (offset < pcm.length) {
      stream.rest = Buffer.from(pcm.subarray(offset));
    }
    parentPort.postMessage({ op: 'packets', id: message.id, packets }, packets);
  } catch (error) {
    streams.delete(message.id);
    parentPort.postMessage({ op: 'failed', id: message.id, message: String(error && error.message) });
  }
});
parentPort.postMessage({ op: 'ready' });
`;

const START_TIMEOUT_MS = 10_000;

type WorkerReply =
  | { readonly op: 'ready' }
  | { readonly op: 'packets'; readonly id: number; readonly packets: ArrayBuffer[] }
  | { readonly op: 'failed'; readonly id: number; readonly message: string };

export interface EncodedStream {
  /** Write PCM (signed 16-bit, 48 kHz, stereo); read Opus packets, one per 20 ms. */
  readonly stream: Transform;
  /** Linear gain from 0 to 1 for the audio that has not been encoded yet. */
  readonly setGain: (gain: number) => void;
}

type EncoderLog = Pick<Logger, 'warn' | 'error'>;

/**
 * Encodes Opus in one shared worker thread instead of on the main thread. Encoding is the
 * main CPU cost of every playing stream; on the main thread it competes with Discord events
 * and commands. Volume is applied in the worker, so a change still takes effect at once,
 * with no FFmpeg restart and no extra process. Each stream has at most one chunk in flight,
 * which keeps backpressure from the voice player all the way back to FFmpeg.
 *
 * If the worker dies, its streams fail like any broken source and the next stream starts a
 * new worker. If it cannot start at all, start() returns null and the caller keeps the
 * in-process encoder.
 */
export class OpusWorkerEncoder {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly streams = new Map<number, WorkerEncodeStream>();
  private disposed = false;

  private constructor(
    private readonly opusPath: string,
    private readonly log: EncoderLog,
  ) {}

  /** Starts the worker and waits until libopus has loaded in it. Null when that fails. */
  static async start(log: EncoderLog): Promise<OpusWorkerEncoder | null> {
    let opusPath: string;
    try {
      opusPath = createRequire(import.meta.url).resolve('@discordjs/opus');
    } catch (error) {
      log.warn({ err: error }, 'Opus worker unavailable; encoding on the main thread');
      return null;
    }
    const encoder = new OpusWorkerEncoder(opusPath, log);
    const worker = encoder.spawn();
    const ready = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        resolve(false);
      }, START_TIMEOUT_MS);
      worker.once('message', () => {
        clearTimeout(timer);
        resolve(true);
      });
      worker.once('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    if (!ready) {
      log.warn('Opus worker did not start; encoding on the main thread');
      await encoder.dispose();
      return null;
    }
    return encoder;
  }

  /** Streams that still hold an encoder in the worker. */
  get activeStreams(): number {
    return this.streams.size;
  }

  open(gain: number): EncodedStream {
    const id = this.nextId;
    this.nextId += 1;
    const stream = new WorkerEncodeStream(this, id);
    this.streams.set(id, stream);
    this.post({ op: 'open', id, gain });
    return {
      stream,
      setGain: (next) => {
        if (this.streams.has(id)) {
          this.post({ op: 'gain', id, gain: next });
        }
      },
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const worker = this.worker;
    this.worker = null;
    for (const stream of [...this.streams.values()]) {
      stream.destroy(new Error('The Opus encoder was shut down'));
    }
    this.streams.clear();
    await worker?.terminate();
  }

  /** @internal Sends one chunk of PCM to the worker. The ArrayBuffer is transferred. */
  encode(id: number, data: ArrayBuffer): void {
    this.post({ op: 'pcm', id, data }, [data]);
  }

  /** @internal Called once when a stream ends or is destroyed. */
  release(id: number): void {
    if (this.streams.delete(id)) {
      this.post({ op: 'close', id });
    }
  }

  private post(message: object, transfer: ArrayBuffer[] = []): void {
    if (this.disposed) {
      return;
    }
    (this.worker ?? this.spawn()).postMessage(message, transfer);
  }

  private spawn(): Worker {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { opusPath: this.opusPath },
    });
    // The worker never keeps the process alive on its own.
    worker.unref();
    worker.on('message', (reply: WorkerReply) => {
      if (reply.op === 'packets') {
        this.streams.get(reply.id)?.deliver(reply.packets);
      } else if (reply.op === 'failed') {
        this.streams.get(reply.id)?.fail(new Error(`Opus encoding failed: ${reply.message}`));
      }
    });
    worker.on('error', (error) => {
      this.log.error({ err: error }, 'The Opus worker crashed');
    });
    worker.on('exit', () => {
      if (this.worker !== worker) {
        return;
      }
      // Every encoder lived in that worker. Its streams fail; new streams start a new worker.
      this.worker = null;
      for (const stream of [...this.streams.values()]) {
        stream.fail(new Error('The Opus worker stopped'));
      }
    });
    this.worker = worker;
    return worker;
  }
}

class WorkerEncodeStream extends Transform {
  private pending: TransformCallback | null = null;

  constructor(
    private readonly owner: OpusWorkerEncoder,
    private readonly id: number,
  ) {
    super({ readableObjectMode: true });
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.pending = callback;
    // A copy of just this chunk, because Node may slice small buffers out of a shared pool.
    const data = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
    this.owner.encode(this.id, data as ArrayBuffer);
  }

  override _flush(callback: TransformCallback): void {
    this.owner.release(this.id);
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.pending = null;
    this.owner.release(this.id);
    callback(error);
  }

  deliver(packets: readonly ArrayBuffer[]): void {
    const callback = this.pending;
    this.pending = null;
    if (this.destroyed) {
      return;
    }
    for (const packet of packets) {
      this.push(Buffer.from(packet));
    }
    callback?.();
  }

  fail(error: Error): void {
    const callback = this.pending;
    this.pending = null;
    if (callback !== null) {
      callback(error);
    } else {
      this.destroy(error);
    }
  }
}
