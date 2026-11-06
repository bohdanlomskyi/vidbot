import { describe, expect, it } from 'vitest';
import { Semaphore } from '../../src/utils/async.js';

describe('Semaphore', () => {
  it('never runs more tasks at once than its capacity', async () => {
    const semaphore = new Semaphore(2);
    let active = 0;
    let maxActive = 0;
    const job = (): Promise<string> =>
      semaphore.use(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((done) => setTimeout(done, 5));
        active -= 1;
        return 'done';
      });

    const results = await Promise.all([job(), job(), job(), job(), job()]);

    expect(maxActive).toBe(2);
    expect(results).toEqual(['done', 'done', 'done', 'done', 'done']);
  });

  it('frees its slot when a task throws so the next task can run', async () => {
    const semaphore = new Semaphore(1);

    await expect(semaphore.use(() => Promise.reject(new Error('task failed')))).rejects.toThrow(
      'task failed',
    );
    await expect(semaphore.use(() => Promise.resolve('after'))).resolves.toBe('after');
  });
});

describe('Semaphore.acquire with a cancellation signal', () => {
  it('stops waiting when the signal aborts, and the cancelled waiter never takes a slot', async () => {
    const semaphore = new Semaphore(1);
    const holder = await semaphore.acquire();
    const controller = new AbortController();

    const waiting = semaphore.acquire(controller.signal);
    controller.abort();

    await expect(waiting).rejects.toMatchObject({ code: 'CANCELLED' });
    holder();
    // The slot went back to the pool instead of to the cancelled waiter.
    const next = await Promise.race([
      semaphore.acquire().then(() => 'acquired'),
      new Promise((done) => {
        setTimeout(() => {
          done('stuck');
        }, 50);
      }),
    ]);
    expect(next).toBe('acquired');
  });

  it('refuses at once when the signal is already aborted', async () => {
    const semaphore = new Semaphore(1);
    const controller = new AbortController();
    controller.abort();

    await expect(semaphore.acquire(controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
