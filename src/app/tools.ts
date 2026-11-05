import { execFile } from 'node:child_process';

const VERSION_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_LINE_LENGTH = 200;

/**
 * Runs an external tool with fixed arguments and returns the first line of its output, such as
 * "ffmpeg version 6.1.1". Returns null when the tool is missing, exits with an error, or times
 * out. No shell is involved, so the binary path and the arguments are never interpreted.
 */
export function readToolVersion(binary: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      binary,
      args,
      {
        timeout: VERSION_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        encoding: 'utf8',
      },
      (error, stdout) => {
        if (error !== null) {
          resolve(null);
          return;
        }
        const firstLine = stdout.split(/\r?\n/u)[0]?.trim() ?? '';
        resolve(firstLine === '' ? null : firstLine.slice(0, MAX_LINE_LENGTH));
      },
    );
  });
}
