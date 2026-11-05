import { describe, expect, it } from 'vitest';
import { KeyedMutex } from '../../src/utils/keyedMutex.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function nextTick(): Promise<void> {
  return new Promise((done) => setImmediate(done));
}

describe('KeyedMutex', () => {
  it('never runs two tasks for the same key at the same time', async () => {
    const mutex = new KeyedMutex();
    let active = 0;
    let maxActive = 0;
    const task = async (): Promise<void> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await nextTick();
      await nextTick();
      active -= 1;
    };

    await Promise.all([1, 2, 3, 4].map(() => mutex.run('guild-1', task)));

    expect(maxActive).toBe(1);
  });

  it('lets tasks for different keys run at the same time', async () => {
    const mutex = new KeyedMutex();
    const gateA = deferred();
    const gateB = deferred();
    const started: string[] = [];

    const a = mutex.run('guild-a', async () => {
      started.push('a');
      await gateA.promise;
    });
    const b = mutex.run('guild-b', async () => {
      started.push('b');
      await gateB.promise;
    });
    await nextTick();

    expect(started).toEqual(['a', 'b']);
    gateA.resolve();
    gateB.resolve();
    await Promise.all([a, b]);
  });

  it('runs tasks for the same key in submission order even when earlier tasks are slower', async () => {
    const mutex = new KeyedMutex();
    const finished: number[] = [];
    const delays = [15, 5, 10];

    await Promise.all(
      delays.map((delay, index) =>
        mutex.run('guild-1', async () => {
          await new Promise((done) => setTimeout(done, delay));
          finished.push(index);
        }),
      ),
    );

    expect(finished).toEqual([0, 1, 2]);
  });

  it('returns the value produced by the task', async () => {
    const mutex = new KeyedMutex();

    await expect(mutex.run('guild-1', () => Promise.resolve(42))).resolves.toBe(42);
  });

  it('releases the key after a failing task so the next task still runs', async () => {
    const mutex = new KeyedMutex();
    const failing = mutex.run('guild-1', () => Promise.reject(new Error('boom')));

    await expect(failing).rejects.toThrow('boom');
    await expect(mutex.run('guild-1', () => Promise.resolve('next'))).resolves.toBe('next');
  });
});
