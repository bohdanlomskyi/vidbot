import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scheduleLibraryRescan } from '../../../src/app/librarySchedule.js';

const MINUTE = 60_000;

describe('scheduleLibraryRescan', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('never rescans when the interval is zero', async () => {
    const refresh = vi.fn(() => Promise.resolve());
    const stop = scheduleLibraryRescan({ minutes: 0, refresh, onError: vi.fn() });

    await vi.advanceTimersByTimeAsync(120 * MINUTE);

    expect(refresh).not.toHaveBeenCalled();
    stop();
  });

  it('rescans once per configured interval', async () => {
    const refresh = vi.fn(() => Promise.resolve());
    const stop = scheduleLibraryRescan({ minutes: 5, refresh, onError: vi.fn() });

    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(refresh).toHaveBeenCalledTimes(3);
    stop();
  });

  it('stops scheduling after the returned function is called', async () => {
    const refresh = vi.fn(() => Promise.resolve());
    const stop = scheduleLibraryRescan({ minutes: 1, refresh, onError: vi.fn() });

    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    stop();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);

    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('reports a failed rescan and keeps the schedule running', async () => {
    const refresh = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('disk unavailable'))
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const stop = scheduleLibraryRescan({ minutes: 1, refresh, onError });

    await vi.advanceTimersByTimeAsync(2 * MINUTE);

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(refresh).toHaveBeenCalledTimes(2);
    stop();
  });
});
