import { type ChildProcess, type ChildProcessByStdio, spawn } from 'node:child_process';
import type { Readable } from 'node:stream';

const STDOUT_LIMIT = 4 * 1024 * 1024;
const STDERR_LIMIT = 16 * 1024;
const GRACE_MS = 2_000;

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** The first few kilobytes of stderr. Used for classification and logs, never shown raw. */
  readonly stderr: string;
  readonly spawnError: Error | null;
}

/** Ends a process with SIGTERM, then SIGKILL after the grace period. Safe to call repeatedly. */
export async function terminate(child: ChildProcess, graceMs = GRACE_MS): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill('SIGTERM');
  const exited = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, graceMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (!exited) {
    child.kill('SIGKILL');
  }
}

export interface JsonRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly spawnError: Error | null;
}

/**
 * Runs a command that prints one JSON document. Output is size-capped, the process is
 * killed on timeout or abort, and the arguments are passed as an array with no shell.
 */
export function runJson(
  binary: string,
  args: readonly string[],
  options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
): Promise<JsonRun> {
  return new Promise((resolve) => {
    const child = spawn(binary, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < STDOUT_LIMIT) {
        stdout += chunk;
      }
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < STDERR_LIMIT) {
        stderr += chunk.slice(0, STDERR_LIMIT - stderr.length);
      }
    });

    const stop = (): void => {
      void terminate(child);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    const onAbort = (): void => {
      stop();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (code: number | null, spawnError: Error | null): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut, spawnError });
    };
    child.once('error', (error) => {
      finish(null, error);
    });
    child.once('close', (code) => {
      finish(code, null);
    });
  });
}

export interface StreamingProcess {
  readonly pid: number | undefined;
  /** Media bytes written by the process. */
  readonly stdout: Readable;
  readonly exit: Promise<ProcessExit>;
  stop(): Promise<void>;
}

/** Starts a process whose standard output is media, for example yt-dlp writing audio to stdout. */
export function spawnStreamingProcess(binary: string, args: readonly string[]): StreamingProcess {
  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(binary, [...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    if (stderr.length < STDERR_LIMIT) {
      stderr += chunk.slice(0, STDERR_LIMIT - stderr.length);
    }
  });

  const exit = new Promise<ProcessExit>((resolve) => {
    child.once('error', (spawnError) => {
      child.stdout.destroy();
      resolve({ code: null, signal: null, stderr, spawnError });
    });
    child.once('exit', (code, signal) => {
      resolve({ code, signal, stderr, spawnError: null });
    });
  });

  return {
    pid: child.pid,
    stdout: child.stdout,
    exit,
    stop: async () => {
      await terminate(child);
      child.stdout.destroy();
    },
  };
}
