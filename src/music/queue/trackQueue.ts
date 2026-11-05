import type { Track } from '../models/track.js';
import { AppError } from '../../utils/errors.js';

/**
 * The waiting tracks of one guild session. The current track is not part of the queue.
 * Positions are 1-based. Capacity applies only to direct additions. Rotation during repeat
 * uses `pushBack` after the track has left the queue, so the length never grows past the limit.
 */
export class TrackQueue {
  private items: Track[] = [];
  private capacity: number;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError('Queue capacity must be a positive integer');
    }
    this.capacity = capacity;
  }

  get size(): number {
    return this.items.length;
  }

  get limit(): number {
    return this.capacity;
  }

  setCapacity(limit: number): void {
    this.capacity = limit;
  }

  list(): readonly Track[] {
    return [...this.items];
  }

  /** Adds the whole batch or none of it. Returns the 1-based positions of the new tracks. */
  enqueue(tracks: readonly Track[]): number[] {
    if (this.items.length + tracks.length > this.capacity) {
      const free = Math.max(0, this.capacity - this.items.length);
      throw new AppError(
        'QUEUE_FULL',
        `Очередь заполнена: свободно мест ${String(free)} из ${String(this.capacity)}.`,
      );
    }
    const first = this.items.length + 1;
    this.items.push(...tracks);
    return tracks.map((_track, index) => first + index);
  }

  pushBack(track: Track): void {
    this.items.push(track);
  }

  shift(): Track | undefined {
    return this.items.shift();
  }

  remove(position: number): Track {
    if (!Number.isInteger(position) || position < 1 || position > this.items.length) {
      throw new AppError('NOT_FOUND', `В очереди нет трека с номером ${String(position)}.`);
    }
    const [removed] = this.items.splice(position - 1, 1);
    if (removed === undefined) {
      throw new AppError('NOT_FOUND', `В очереди нет трека с номером ${String(position)}.`);
    }
    return removed;
  }

  clear(): Track[] {
    const removed = this.items;
    this.items = [];
    return removed;
  }

  /** Fisher–Yates shuffle. `random` returns values in [0, 1) and can be injected for tests. */
  shuffle(random: () => number = Math.random): void {
    for (let index = this.items.length - 1; index > 0; index -= 1) {
      const other = Math.floor(random() * (index + 1));
      const current = this.items[index];
      const target = this.items[other];
      if (current !== undefined && target !== undefined) {
        this.items[index] = target;
        this.items[other] = current;
      }
    }
  }
}
