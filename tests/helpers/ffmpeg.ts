import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Creates an original test tone with FFmpeg's sine generator. No third-party audio is involved. */
export async function createSineFixture(
  ffmpegPath: string,
  outputFile: string,
  seconds: number,
): Promise<void> {
  await run(ffmpegPath, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:duration=${String(seconds)}`,
    '-ac',
    '2',
    '-ar',
    '48000',
    outputFile,
  ]);
}

/** Reads a readable stream to the end and returns the total byte count. */
export async function countBytes(stream: AsyncIterable<Buffer | string>): Promise<number> {
  let total = 0;
  for await (const chunk of stream) {
    total += Buffer.byteLength(chunk);
  }
  return total;
}

/** True when a process with this pid still exists. */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
