import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnqueueRequest } from '../../src/music/engine/musicEngine.js';
import { createHarness, draft, flush, type Harness } from '../helpers/fakeMusic.js';

function request(titles: readonly string[], extra: Partial<EnqueueRequest> = {}): EnqueueRequest {
  return {
    guildId: 'g1',
    voiceChannelId: 'c1',
    requesterId: 'user-1',
    tracks: titles.map((title) => draft(title)),
    ...extra,
  };
}

function queueTitles(harness: Harness): string[] {
  return harness.engine.snapshot('g1').queue.map((track) => track.title);
}

function currentTitle(harness: Harness): string | undefined {
  return harness.engine.snapshot('g1').nowPlaying?.track.title;
}

/** Starts the loaded track and lets the engine settle. */
async function startPlaying(harness: Harness): Promise<void> {
  harness.players[0]?.emitStart();
  await flush();
}

async function endTrack(harness: Harness): Promise<void> {
  harness.players[0]?.emitEnd();
  await flush();
  await startPlaying(harness);
}

describe('MusicEngine extras', () => {
  let harness: Harness;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    harness = createHarness();
  });

  afterEach(async () => {
    await harness.engine.shutdown();
    vi.useRealTimers();
  });

  describe('opening the next track early', () => {
    beforeEach(() => {
      // With nobody listening the bot would leave the channel before the track ends.
      harness.setListeners(1);
    });

    function preloaded(h: Harness): string[] {
      return h.provider.preloaded;
    }

    it('starts opening the next track shortly before the current one ends', async () => {
      await harness.engine.enqueue(request(['A', 'B']));
      await startPlaying(harness);

      await vi.advanceTimersByTimeAsync(169_000);
      expect(preloaded(harness)).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(preloaded(harness)).toEqual(['B']);
    });

    it('opens the next track only once, whatever else changes', async () => {
      await harness.engine.enqueue(request(['A', 'B']));
      await startPlaying(harness);
      await vi.advanceTimersByTimeAsync(185_000);
      await harness.engine.setVolume('g1', 50);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(preloaded(harness)).toEqual(['B']);
    });

    it('waits while the track is paused', async () => {
      await harness.engine.enqueue(request(['A', 'B']));
      await startPlaying(harness);
      await harness.engine.pause('g1');

      await vi.advanceTimersByTimeAsync(400_000);

      expect(preloaded(harness)).toEqual([]);
    });

    it('follows a change of the queue', async () => {
      await harness.engine.enqueue(request(['A', 'B']));
      await startPlaying(harness);
      await harness.engine.enqueue(request(['X'], { playNext: true }));

      await vi.advanceTimersByTimeAsync(171_000);

      expect(preloaded(harness)).toEqual(['X']);
    });

    it('opens the same track again when it repeats', async () => {
      await harness.engine.enqueue(request(['A']));
      await startPlaying(harness);
      await harness.engine.setLoop('g1', 'track');

      await vi.advanceTimersByTimeAsync(171_000);

      expect(preloaded(harness)).toEqual(['A']);
    });

    it('does nothing for a live stream or when nothing follows', async () => {
      await harness.engine.enqueue({ ...request([]), tracks: [draft('Live', null), draft('B')] });
      await startPlaying(harness);
      await vi.advanceTimersByTimeAsync(4_000_000);
      expect(preloaded(harness)).toEqual([]);

      const single = createHarness();
      single.setListeners(1);
      await single.engine.enqueue(request(['Only']));
      single.players[0]?.emitStart();
      await flush();
      await vi.advanceTimersByTimeAsync(400_000);
      expect(single.provider.preloaded).toEqual([]);
      await single.engine.shutdown();
    });
  });

  describe('track_started announcements', () => {
    it('marks the start a command waits for, and not the tracks that follow on their own', async () => {
      await harness.engine.enqueue(request(['A', 'B']));
      await startPlaying(harness);
      await endTrack(harness);

      const starts = harness.events.flatMap((event) =>
        event.type === 'track_started' ? [[event.track.title, event.announcedByCaller]] : [],
      );
      expect(starts).toEqual([
        ['A', true],
        ['B', false],
      ]);
    });

    it('does not mark a track added while another one plays', async () => {
      await harness.engine.enqueue(request(['A']));
      await startPlaying(harness);
      await harness.engine.enqueue(request(['B']));
      await endTrack(harness);

      const last = harness.events.filter((event) => event.type === 'track_started').at(-1);
      expect(last).toMatchObject({ track: { title: 'B' }, announcedByCaller: false });
    });
  });

  describe('play next', () => {
    it('puts new tracks at the front of the queue, in their own order', async () => {
      await harness.engine.enqueue(request(['A', 'B', 'C']));
      await startPlaying(harness);

      const result = await harness.engine.enqueue(request(['X', 'Y'], { playNext: true }));

      expect(queueTitles(harness)).toEqual(['X', 'Y', 'B', 'C']);
      expect(result.positions).toEqual([1, 2]);
    });

    it('starts the track at once when the bot is idle', async () => {
      const result = await harness.engine.enqueue(request(['X'], { playNext: true }));
      await startPlaying(harness);

      expect(result.startedNow).toBe(true);
      expect(currentTitle(harness)).toBe('X');
    });

    it('still respects the queue limit', async () => {
      const small = createHarness({ queueLimit: 2 });
      await small.engine.enqueue(request(['A', 'B']));

      await expect(
        small.engine.enqueue(request(['X', 'Y'], { playNext: true })),
      ).rejects.toMatchObject({
        code: 'QUEUE_FULL',
      });
      await small.engine.shutdown();
    });
  });

  describe('previous', () => {
    it('goes back to the track that played before and keeps the current one next in line', async () => {
      await harness.engine.enqueue(request(['A', 'B']));
      await startPlaying(harness);
      await endTrack(harness);
      expect(currentTitle(harness)).toBe('B');

      await vi.advanceTimersByTimeAsync(2_000);
      const outcome = await harness.engine.previous('g1');
      await startPlaying(harness);

      expect(outcome).toBe('previous');
      expect(currentTitle(harness)).toBe('A');
      expect(queueTitles(harness)).toEqual(['B']);
    });

    it('restarts the current track when it has played for more than a few seconds', async () => {
      await harness.engine.enqueue(request(['A', 'B']));
      await startPlaying(harness);
      await endTrack(harness);

      await vi.advanceTimersByTimeAsync(20_000);
      const outcome = await harness.engine.previous('g1');
      await startPlaying(harness);

      expect(outcome).toBe('restarted');
      expect(currentTitle(harness)).toBe('B');
      expect(queueTitles(harness)).toEqual([]);
    });

    it('restarts the first track when nothing played before it', async () => {
      await harness.engine.enqueue(request(['A']));
      await startPlaying(harness);

      expect(await harness.engine.previous('g1')).toBe('restarted');
      await startPlaying(harness);
      expect(currentTitle(harness)).toBe('A');
    });

    it('can step back more than once', async () => {
      await harness.engine.enqueue(request(['A', 'B', 'C']));
      await startPlaying(harness);
      await endTrack(harness);
      await endTrack(harness);
      expect(currentTitle(harness)).toBe('C');

      await harness.engine.previous('g1');
      await startPlaying(harness);
      await harness.engine.previous('g1');
      await startPlaying(harness);

      expect(currentTitle(harness)).toBe('A');
      expect(queueTitles(harness)).toEqual(['B', 'C']);
    });

    it('says there is nothing to go back to when nothing plays', async () => {
      await expect(harness.engine.previous('g1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('skip to', () => {
    it('drops the tracks before the chosen one and plays it', async () => {
      await harness.engine.enqueue(request(['A', 'B', 'C', 'D', 'E']));
      await startPlaying(harness);

      const target = await harness.engine.skipTo('g1', 3);
      await startPlaying(harness);

      expect(target.title).toBe('D');
      expect(currentTitle(harness)).toBe('D');
      expect(queueTitles(harness)).toEqual(['E']);
    });

    it('refuses a position outside the queue and changes nothing', async () => {
      await harness.engine.enqueue(request(['A', 'B']));
      await startPlaying(harness);

      await expect(harness.engine.skipTo('g1', 5)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(currentTitle(harness)).toBe('A');
      expect(queueTitles(harness)).toEqual(['B']);
    });
  });

  describe('24/7 mode', () => {
    it('does not leave after the idle timeout', async () => {
      const staying = createHarness({ stayConnected: true });
      staying.setListeners(1);
      await staying.engine.enqueue(request(['A']));
      staying.players[0]?.emitEnd();
      await flush();

      await vi.advanceTimersByTimeAsync(3_600_000);

      expect(staying.voice.active).toHaveLength(1);
      await staying.engine.shutdown();
    });

    it('does not leave when the channel is empty', async () => {
      const staying = createHarness({ stayConnected: true });
      await staying.engine.enqueue(request(['A']));
      staying.players[0]?.emitEnd();
      await flush();

      await vi.advanceTimersByTimeAsync(3_600_000);

      expect(staying.voice.active).toHaveLength(1);
      await staying.engine.shutdown();
    });
  });

  describe('events for the chat', () => {
    it('reports that the queue is over after the last track ends by itself', async () => {
      await harness.engine.enqueue(request(['A']));
      await startPlaying(harness);

      harness.players[0]?.emitEnd();
      await flush();

      expect(harness.events.map((event) => event.type)).toContain('queue_finished');
    });

    it('does not report a finished queue while tracks are waiting', async () => {
      await harness.engine.enqueue(request(['A', 'B']));
      await startPlaying(harness);

      harness.players[0]?.emitEnd();
      await flush();

      expect(harness.events.map((event) => event.type)).not.toContain('queue_finished');
    });

    it('reports a restored voice connection', async () => {
      await harness.engine.enqueue(request(['A']));
      await startPlaying(harness);

      harness.voice.connections[0]?.loseConnection();
      await vi.advanceTimersByTimeAsync(1_500);

      expect(harness.events.map((event) => event.type)).toEqual(
        expect.arrayContaining(['connection_lost', 'connection_restored']),
      );
    });

    it('reports when an administrator moves the bot to another channel', async () => {
      await harness.engine.enqueue(request(['A']));
      await startPlaying(harness);

      await harness.engine.handleBotVoiceChange('g1', 'c2');

      expect(harness.events).toContainEqual({ type: 'moved', guildId: 'g1', channelId: 'c2' });
    });
  });
});
