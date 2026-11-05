import { AppError } from './errors.js';

/**
 * Rejects with a TIMEOUT application error if `work` does not settle in time.
 * The timer is always cleared, so a finished operation leaves nothing behind.
 */
export function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  userMessage: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new AppError('TIMEOUT', userMessage));
    }, timeoutMs);
  });

  return Promise.race([work, deadline]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Limits how many tasks run at the same time. Waiting tasks start in the order
 * they arrived. A slot is handed to the next waiter directly, so it cannot be
 * stolen by a task that arrives later.
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError('Semaphore capacity must be a positive integer');
    }
    this.available = capacity;
  }

  async use<T>(task: () => Promise<T>): Promise<T> {
    await this.waitForSlot();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  /**
   * Waits for a slot and returns the function that releases it. Use this when the slot
   * must stay held beyond one call, such as while a stream plays. The release function
   * is idempotent.
   */
  async acquire(): Promise<() => void> {
    await this.waitForSlot();
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.release();
      }
    };
  }

  private waitForSlot(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.available += 1;
    }
  }
}
