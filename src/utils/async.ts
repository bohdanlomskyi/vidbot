import { AppError } from './errors.js';

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
   * is idempotent. When `signal` aborts first, the wait ends with a CANCELLED error and
   * the cancelled caller never receives a slot.
   */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    await this.waitForSlot(signal);
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.release();
      }
    };
  }

  /** Takes a slot only when one is free right now. Returns its release function, or null. */
  tryAcquire(): (() => void) | null {
    if (this.available === 0 || this.waiters.length > 0) {
      return null;
    }
    this.available -= 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.release();
      }
    };
  }

  private waitForSlot(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) {
      return Promise.reject(new AppError('CANCELLED', 'Запрос отменён.'));
    }
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.waiters.indexOf(grant);
        if (index !== -1) {
          this.waiters.splice(index, 1);
        }
        reject(new AppError('CANCELLED', 'Запрос отменён.'));
      };
      const grant = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(grant);
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
