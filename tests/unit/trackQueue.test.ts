import { describe, expect, it } from 'vitest';
import { TrackQueue } from '../../src/music/queue/trackQueue.js';
import type { Track } from '../../src/music/models/track.js';
import { AppError } from '../../src/utils/errors.js';

function track(title: string): Track {
  return {
    id: `id-${title}`,
    source: 'local',
    sourceRef: title,
    title,
    artist: null,
    durationSec: 100,
    thumbnailUrl: null,
    originalUrl: null,
    requesterId: 'user-1',
    createdAt: 0,
    metadata: {},
  };
}

function titles(queue: TrackQueue): string[] {
  return queue.list().map((item) => item.title);
}

function codeOf(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return error instanceof AppError ? error.code : 'OTHER';
  }
  return undefined;
}

describe('TrackQueue', () => {
  it('keeps tracks in the order they were added and reports 1-based positions', () => {
    const queue = new TrackQueue(10);

    expect(queue.enqueue([track('a'), track('b')])).toEqual([1, 2]);
    expect(queue.enqueue([track('c')])).toEqual([3]);
    expect(titles(queue)).toEqual(['a', 'b', 'c']);
  });

  it('adds nothing when the whole batch would exceed the capacity', () => {
    const queue = new TrackQueue(2);
    queue.enqueue([track('a')]);

    expect(codeOf(() => queue.enqueue([track('b'), track('c')]))).toBe('QUEUE_FULL');
    expect(titles(queue)).toEqual(['a']);
  });

  it('removes the track at the given 1-based position', () => {
    const queue = new TrackQueue(10);
    queue.enqueue([track('a'), track('b'), track('c')]);

    expect(queue.remove(2).title).toBe('b');
    expect(titles(queue)).toEqual(['a', 'c']);
  });

  it('rejects positions outside the queue', () => {
    const queue = new TrackQueue(10);
    queue.enqueue([track('a')]);

    expect(codeOf(() => queue.remove(0))).toBe('NOT_FOUND');
    expect(codeOf(() => queue.remove(2))).toBe('NOT_FOUND');
  });

  it('clears the waiting tracks and returns them', () => {
    const queue = new TrackQueue(10);
    queue.enqueue([track('a'), track('b')]);

    expect(queue.clear().map((item) => item.title)).toEqual(['a', 'b']);
    expect(queue.size).toBe(0);
  });

  it('shuffles with the injected random source, starting from the end of the queue', () => {
    const queue = new TrackQueue(10);
    queue.enqueue([track('a'), track('b'), track('c'), track('d')]);

    queue.shuffle(() => 0);

    expect(titles(queue)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('keeps every track when shuffling with the real random source', () => {
    const queue = new TrackQueue(10);
    queue.enqueue([track('a'), track('b'), track('c'), track('d'), track('e')]);

    queue.shuffle();

    expect(titles(queue).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('appends a rotated track even when the queue is already at capacity', () => {
    const queue = new TrackQueue(1);
    queue.enqueue([track('a')]);

    queue.pushBack(track('b'));

    expect(titles(queue)).toEqual(['a', 'b']);
  });

  it('returns undefined from shift when the queue is empty', () => {
    expect(new TrackQueue(5).shift()).toBeUndefined();
  });
});
