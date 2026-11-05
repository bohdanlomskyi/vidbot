import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

export type HealthStatus = 'starting' | 'ready' | 'stopping';

/** What the bot writes to the health file. Nothing secret goes in here. */
export interface HealthSnapshot {
  readonly status: HealthStatus;
  readonly updatedAt: string;
  readonly pid: number;
}

/** How often the running bot refreshes the health file. */
export const HEALTH_INTERVAL_MS = 30_000;
/** A snapshot older than this means the process has stopped updating the file. */
export const HEALTH_MAX_AGE_MS = 90_000;

const snapshotSchema = z.object({
  status: z.enum(['starting', 'ready', 'stopping']),
  updatedAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'not a date'),
  pid: z.number().int().nonnegative(),
});

export type HealthVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Decides whether a parsed health file describes a bot that is up and recently active. */
export function evaluateHealth(
  raw: unknown,
  nowMs: number,
  maxAgeMs: number = HEALTH_MAX_AGE_MS,
): HealthVerdict {
  const parsed = snapshotSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: 'файл состояния отсутствует или повреждён' };
  }
  if (parsed.data.status !== 'ready') {
    return { ok: false, reason: `бот не готов: статус "${parsed.data.status}"` };
  }
  if (nowMs - Date.parse(parsed.data.updatedAt) > maxAgeMs) {
    return { ok: false, reason: 'состояние устарело: процесс давно не обновлял файл' };
  }
  return { ok: true };
}

/** Writes the snapshot through a temporary file, so a reader never sees a half-written file. */
export async function writeSnapshot(file: string, snapshot: HealthSnapshot): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${String(process.pid)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { encoding: 'utf8', mode: 0o644 });
  await rename(temporary, file);
}

export interface HeartbeatOptions {
  readonly file: string;
  readonly currentStatus: () => HealthStatus;
  readonly onError: (error: unknown) => void;
  readonly intervalMs?: number;
  readonly now?: () => Date;
}

/**
 * Keeps the health file fresh. Writes are queued one after another, so two writes can never
 * race on the same temporary file. The timer is unreferenced and never keeps the process alive.
 */
export class Heartbeat {
  private timer: ReturnType<typeof setInterval> | undefined;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly options: HeartbeatOptions) {}

  start(): void {
    if (this.timer !== undefined) {
      return;
    }
    this.beat();
    this.timer = setInterval(() => {
      this.beat();
    }, this.options.intervalMs ?? HEALTH_INTERVAL_MS);
    this.timer.unref();
  }

  /** Stops the timer, then writes one last snapshot so health checks see the shutdown. */
  async stop(finalStatus: HealthStatus): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.write(finalStatus);
  }

  /** Resolves once every queued write has finished. */
  async flush(): Promise<void> {
    await this.chain;
  }

  private beat(): void {
    this.write(this.options.currentStatus()).catch(this.options.onError);
  }

  private write(status: HealthStatus): Promise<void> {
    const now = this.options.now ?? (() => new Date());
    const next = this.chain.then(() =>
      writeSnapshot(this.options.file, {
        status,
        updatedAt: now().toISOString(),
        pid: process.pid,
      }),
    );
    this.chain = next.catch(() => undefined);
    return next;
  }
}
