import { describe, expect, it } from 'vitest';
import { Semaphore, withTimeout } from '../../src/utils/async.js';

describe('withTimeout', () => {
  it('resolves with the value when the work finishes in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1_000, 'Слишком долго.')).resolves.toBe('ok');
  });

  it('rejects with a TIMEOUT application error when the work runs too long', async () => {
    const neverFinishes = new Promise<never>(() => undefined);

    const error: unknown = await withTimeout(
      neverFinishes,
      20,
      'Источник не ответил вовремя.',
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'TIMEOUT',
      userMessage: 'Источник не ответил вовремя.',
    });
  });

  it('passes through the original rejection when the work fails before the deadline', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1_000, 'x')).rejects.toThrow(
      'boom',
    );
  });
});

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
