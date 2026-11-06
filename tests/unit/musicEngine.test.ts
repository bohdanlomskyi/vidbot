import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnqueueRequest } from '../../src/music/engine/musicEngine.js';
import { createHarness, draft, flush, type Harness } from '../helpers/fakeMusic.js';

function request(
  guildId: string,
  voiceChannelId: string,
  titles: readonly string[],
  durationSec?: number,
): EnqueueRequest {
  return {
    guildId,
    voiceChannelId,
    requesterId: 'user-1',
    tracks: titles.map((title) => draft(title, durationSec ?? 200)),
  };
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

async function errorCodeOf(action: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await action();
  } catch (error) {
    return codeOf(error) ?? 'OTHER';
  }
  return undefined;
}

describe('MusicEngine', () => {
  let harness: Harness;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    harness = createHarness();
  });

  afterEach(async () => {
    await harness.engine.shutdown();
    vi.useRealTimers();
  });

  describe('playback and queue order', () => {
    it('connects, starts the first track and reports it as playing', async () => {
      await harness.engine.enqueue(request('g1', 'c1', ['Alpha']));
      harness.players[0]?.emitStart();
      await flush();

      expect(harness.voice.active).toHaveLength(1);
      expect(harness.engine.snapshot('g1')).toMatchObject({
        state: 'playing',
        voiceChannelId: 'c1',
        nowPlaying: { track: { title: 'Alpha' }, paused: false },
      });
    });

    it('appends later tracks in order while one is playing', async () => {
      await harness.engine.enqueue(request('g1', 'c1', ['Alpha']));
      const result = await harness.engine.enqueue(request('g1', 'c1', ['Beta', 'Gamma']));

      expect(result).toEqual({ positions: [1, 2], startedNow: false, failure: null });
      expect(harness.engine.snapshot('g1').queue.map((item) => item.title)).toEqual([
        'Beta',
        'Gamma',
      ]);
    });

    it('keeps every track in the order the requests arrived when many users add at once', async () => {
      await harness.engine.enqueue(request('g1', 'c1', ['t0']));
      await Promise.all(
        Array.from({ length: 9 }, (_unused, index) =>
          harness.engine.enqueue(request('g1', 'c1', [`t${String(index + 1)}`])),
        ),
      );

      expect(harness.engine.snapshot('g1').queue.map((item) => item.title)).toEqual([
        't1',
        't2',
        't3',
        't4',
        't5',
        't6',
        't7',
        't8',
        't9',
      ]);
    });

    it('connects once and keeps one queue when many users add to an idle bot at the same moment', async () => {
      await Promise.all(
        Array.from({ length: 5 }, (_unused, index) =>
          harness.engine.enqueue(request('g1', 'c1', [`t${String(index)}`])),
        ),
      );

      expect(harness.voice.connections).toHaveLength(1);
      expect(harness.engine.snapshot('g1').nowPlaying?.track.title).toBe('t0');
      expect(harness.engine.snapshot('g1').queue.map((item) => item.title)).toEqual([
        't1',
        't2',
        't3',
        't4',
      ]);
    });

    it('advances exactly once when the audio ends, ignoring a duplicate end signal', async () => {
      await harness.engine.enqueue(request('g1', 'c1', ['Alpha', 'Beta']));
      harness.players[0]?.emitStart();

      harness.players[0]?.emitEnd();
      harness.players[0]?.emitEnd();
      await flush();

      expect(harness.engine.snapshot('g1')).toMatchObject({
        nowPlaying: { track: { title: 'Beta' } },
        queue: [],
      });
      expect(harness.players[0]?.played).toHaveLength(2);
    });

    it('ignores the end signal of a track that was skipped', async () => {
      await harness.engine.enqueue(request('g1', 'c1', ['Alpha', 'Beta']));
      harness.players[0]?.emitStart();
      const skippedCallbacks = harness.players[0]?.current?.callbacks;

      await harness.engine.skip('g1');
      skippedCallbacks?.onEnd();
      await flush();

      expect(harness.engine.snapshot('g1').nowPlaying?.track.title).toBe('Beta');
      expect(harness.players[0]?.played).toHaveLength(2);
    });

    it('moves on to the next track when a playback fails midway', async () => {
      await harness.engine.enqueue(request('g1', 'c1', ['Alpha', 'Beta']));
      harness.players[0]?.emitStart();

      harness.provider.opened[0]?.finish('failed');
      await flush();

      expect(harness.engine.snapshot('g1')).toMatchObject({
        nowPlaying: { track: { title: 'Beta' } },
      });
      expect(harness.engine.snapshot('g1').notice).toContain('Alpha');
    });

    it('skips a track whose source cannot be opened and plays the next one', async () => {
      harness.provider.failTitles.add('Broken');

      await harness.engine.enqueue(request('g1', 'c1', ['Broken', 'Alpha']));

      expect(harness.engine.snapshot('g1').nowPlaying?.track.title).toBe('Alpha');
      expect(harness.engine.snapshot('g1').notice).toContain('Broken');
    });
  });

  describe('repeat modes', () => {
    it('replays the finished track without taking anything from the queue', async () => {
      await harness.engine.setLoop('g1', 'track');
      await harness.engine.enqueue(request('g1', 'c1', ['Alpha', 'Beta']));
      harness.players[0]?.emitStart();

      harness.players[0]?.emitEnd();
      await flush();

      expect(harness.engine.snapshot('g1')).toMatchObject({
        nowPlaying: { track: { title: 'Alpha' } },
      });
      expect(harness.engine.snapshot('g1').queue.map((item) => item.title)).toEqual(['Beta']);
    });

    it('does not replay forever a track that ended without ever playing', async () => {
      await harness.engine.setLoop('g1', 'track');
      await harness.engine.enqueue(request('g1', 'c1', ['Empty', 'Next']));

      // An empty or broken file: the player goes idle without ever reaching "playing".
      harness.players[0]?.emitEnd();
      await flush();
      await flush();

      expect(harness.players[0]?.played).toHaveLength(2);
      expect(harness.engine.snapshot('g1').nowPlaying?.track.title).toBe('Next');
      expect(harness.engine.snapshot('g1').notice).toContain('Empty');
    });

    it('moves each finished track to the back of the queue in queue mode', async () => {
      await harness.engine.setLoop('g1', 'queue');
      await harness.engine.enqueue(request('g1', 'c1', ['Alpha', 'Beta']));
      harness.players[0]?.emitStart();

      harness.players[0]?.emitEnd();
      await flush();

      expect(harness.engine.snapshot('g1')).toMatchObject({
        nowPlaying: { track: { title: 'Beta' } },
      });
      expect(harness.engine.snapshot('g1').queue.map((item) => item.title)).toEqual(['Alpha']);
    });
  });

  describe('limits and validation', () => {
    it('refuses a batch that would exceed the queue limit and changes nothing', async () => {
      harness = createHarness({ queueLimit: 1 });
      await harness.engine.enqueue(request('g1', 'c1', ['Alpha']));
      await harness.engine.enqueue(request('g1', 'c1', ['Beta']));

      // The refused request comes from another channel, so a refusal must happen before joining it.
      expect(
        await errorCodeOf(() => harness.engine.enqueue(request('g1', 'c2', ['Gamma', 'Delta']))),
      ).toBe('QUEUE_FULL');
      expect(harness.engine.snapshot('g1').queue.map((item) => item.title)).toEqual(['Beta']);
      expect(harness.voice.connections).toHaveLength(1);
    });

    it('refuses tracks longer than the guild maximum before joining the channel', async () => {
      harness = createHarness({ maxTrackSec: 600 });

      expect(
        await errorCodeOf(() => harness.engine.enqueue(request('g1', 'c1', ['Long'], 900))),
      ).toBe('TRACK_TOO_LONG');
      expect(harness.voice.connections).toHaveLength(0);
    });

    it('applies the guild default volume to a new session', async () => {
      harness = createHarness({ defaultVolume: 40 });
      await harness.engine.enqueue(request('g1', 'c1', ['Alpha']));

      expect(harness.engine.snapshot('g1').volume).toBe(40);
      expect(harness.players[0]?.gain).toBeCloseTo(0.4);
    });
  });

  describe('stopping and isolation', () => {
    it('stop clears the queue, stops playback and leaves the channel', async () => {
      await harness.engine.enqueue(request('g1', 'c1', ['Alpha', 'Beta']));

      await harness.engine.stop('g1');

      expect(harness.engine.snapshot('g1')).toMatchObject({
        state: 'idle',
        voiceChannelId: null,
        nowPlaying: null,
        queue: [],
      });
      expect(harness.voice.active).toHaveLength(0);
    });

    it('keeps guilds isolated: stopping one does not touch another', async () => {
      await harness.engine.enqueue(request('g1', 'c1', ['Alpha']));
      await harness.engine.enqueue(request('g2', 'c2', ['Beta']));

      await harness.engine.stop('g1');

      expect(harness.engine.snapshot('g2').nowPlaying?.track.title).toBe('Beta');
      expect(harness.voice.active.map((connection) => connection.channelId)).toEqual(['c2']);
    });
  });

  describe('pausing', () => {
    it('pauses and resumes the player and reports the paused state', async () => {
      await harness.engine.enqueue(request('g1', 'c1', ['Alpha']));
      harness.players[0]?.emitStart();

      await harness.engine.pause('g1');
      expect(harness.engine.snapshot('g1')).toMatchObject({
        state: 'paused',
        nowPlaying: { paused: true },
      });
      expect(harness.players[0]?.status).toBe('paused');

      await harness.engine.resume('g1');
      expect(harness.engine.snapshot('g1').state).toBe('playing');
      expect(harness.players[0]?.status).toBe('playing');
    });
  });

  describe('queue edits', () => {
    it('removes a waiting track by position and rejects positions out of range', async () => {
      await harness.engine.enqueue(request('g1', 'c1', ['Alpha', 'Beta', 'Gamma']));

      const removed = await harness.engine.remove('g1', 1);

      expect(removed.title).toBe('Beta');
      expect(harness.engine.snapshot('g1').queue.map((item) => item.title)).toEqual(['Gamma']);
      expect(await errorCodeOf(() => harness.engine.remove('g1', 5))).toBe('NOT_FOUND');
    });

    it('clear keeps the current track playing and reports how many tracks it removed', async () => {
      await harness.engine.enqueue(request('g1', 'c1', ['Alpha', 'Beta', 'Gamma']));
      harness.players[0]?.emitStart();

      expect(await harness.engine.clear('g1')).toBe(2);
      expect(harness.engine.snapshot('g1').nowPlaying?.track.title).toBe('Alpha');
    });

    it('shuffles only the waiting tracks', async () => {
      await harness.engine.enqueue(request('g1', 'c1', ['Alpha', 'Beta', 'Gamma', 'Delta']));

      await harness.engine.shuffle('g1');

      expect(harness.engine.snapshot('g1').nowPlaying?.track.title).toBe('Alpha');
      expect(harness.engine.snapshot('g1').queue.map((item) => item.title)).toEqual([
        'Gamma',
        'Delta',
        'Beta',
      ]);
    });

    it('restarts the current track from the beginning without consuming the queue', async () => {
      await harness.engine.enqueue(request('g1', 'c1', ['Alpha', 'Beta']));
      harness.players[0]?.emitStart();

      await harness.engine.restart('g1');

      expect(harness.engine.snapshot('g1').nowPlaying?.track.title).toBe('Alpha');
      expect(harness.engine.snapshot('g1').queue.map((item) => item.title)).toEqual(['Beta']);
    });
  });

  describe('volume', () => {
    it('clamps the volume to 0–100 and applies it to the player', async () => {
      await harness.engine.enqueue(request('g1', 'c1', ['Alpha']));

      await harness.engine.setVolume('g1', 150);
      expect(harness.engine.snapshot('g1').volume).toBe(100);
      expect(harness.players[0]?.gain).toBeCloseTo(1);

      await harness.engine.setVolume('g1', 40);
      expect(harness.players[0]?.gain).toBeCloseTo(0.4);
    });
  });

  describe('auto-disconnect', () => {
    it('leaves after the idle timeout when nothing is queued', async () => {
      // A listener is present so only the idle timer can end the session.
      harness.setListeners(1);
      await harness.engine.enqueue(request('g1', 'c1', ['Alpha']));
      harness.players[0]?.emitEnd();
      await flush();

      await vi.advanceTimersByTimeAsync(300_000);

      expect(harness.voice.active).toHaveLength(0);
      expect(harness.engine.snapshot('g1').state).toBe('idle');
    });

    it('cancels the idle countdown when a track is queued before it expires', async () => {
      harness.setListeners(1);
      await harness.engine.enqueue(request('g1', 'c1', ['Alpha']));
      harness.players[0]?.emitEnd();
      await flush();

      await vi.advanceTimersByTimeAsync(200_000);
      await harness.engine.enqueue(request('g1', 'c1', ['Beta']));
      await vi.advanceTimersByTimeAsync(400_000);

      expect(harness.voice.active).toHaveLength(1);
    });

    it('gives a finished track the full idle timeout instead of the rest of an old countdown', async () => {
      harness.setListeners(1);
      await harness.engine.enqueue(request('g1', 'c1', ['Alpha']));
      harness.players[0]?.emitEnd();
      await flush();

      await vi.advanceTimersByTimeAsync(200_000);
      await harness.engine.enqueue(request('g1', 'c1', ['Beta']));
      await vi.advanceTimersByTimeAsync(50_000);
      harness.players[0]?.emitEnd();
      await flush();

      // The new countdown started at 250 s and ends at 550 s. The old one would have ended at 300 s.
      await vi.advanceTimersByTimeAsync(200_000);

      expect(harness.voice.active).toHaveLength(1);
    });

    it('leaves an empty voice channel after the empty timeout', async () => {
      await harness.engine.enqueue(request('g1', 'c1', ['Alpha']));

      await vi.advanceTimersByTimeAsync(60_000);

      expect(harness.voice.active).toHaveLength(0);
    });

    it('stays when someone rejoins the channel before the empty timeout', async () => {
      await harness.engine.enqueue(request('g1', 'c1', ['Alpha']));
      harness.setListeners(1);
      await harness.engine.handleListenersChanged('g1');

      await vi.advanceTimersByTimeAsync(120_000);

      expect(harness.voice.active).toHaveLength(1);
    });
  });

  describe('voice connection recovery', () => {
    it('reconnects after an unexpected voice loss and keeps the track playing', async () => {
      await harness.engine.enqueue(request('g1', 'c1', ['Alpha']));
      harness.players[0]?.emitStart();
      await flush();

      harness.voice.connections[0]?.loseConnection();
      await flush();
      expect(harness.engine.snapshot('g1').state).toBe('disconnected');
      await vi.advanceTimersByTimeAsync(1_000);
      await flush();

      expect(harness.voice.active.map((connection) => connection.channelId)).toEqual(['c1']);
      expect(harness.voice.active[0]?.subscribedTo).toBe(harness.players[0]);
      expect(harness.engine.snapshot('g1').state).toBe('playing');
    });

    it('gives up after repeated failed reconnects and reports the loss', async () => {
      await harness.engine.enqueue(request('g1', 'c1', ['Alpha']));
      harness.players[0]?.emitStart();
      harness.voice.failures = 3;

      harness.voice.connections[0]?.loseConnection();
      await flush();
      await vi.advanceTimersByTimeAsync(20_000);
      await flush();

      expect(harness.engine.snapshot('g1')).toMatchObject({ state: 'idle', nowPlaying: null });
      expect(harness.engine.snapshot('g1').notice).toContain('восстановить');
      expect(harness.events.some((event) => event.type === 'connection_lost')).toBe(true);
    });
  });

  describe('moving and busy checks', () => {
    it('moves the bot to another channel without losing the queue', async () => {
      await harness.engine.enqueue(request('g1', 'c1', ['Alpha', 'Beta']));
      harness.players[0]?.emitStart();

      await harness.engine.move('g1', 'c2');

      // Discord keeps one voice connection per guild, and moving reuses it. Destroying the
      // "previous" connection would destroy the moved one and silently drop the bot.
      expect(harness.voice.active.map((connection) => connection.channelId)).toEqual(['c2']);
      expect(harness.voice.connections).toHaveLength(1);
      expect(harness.voice.active[0]?.subscribedTo).toBe(harness.players[0]);
      expect(harness.voice.active[0]?.lossHandlerCount).toBe(1);
      expect(harness.engine.snapshot('g1')).toMatchObject({ voiceChannelId: 'c2' });
      expect(harness.engine.voiceChannelOf('g1')).toBe('c2');
      expect(harness.engine.snapshot('g1').queue.map((item) => item.title)).toEqual(['Beta']);
      expect(harness.engine.snapshot('g1').nowPlaying?.track.title).toBe('Alpha');
    });

    it('refuses to take a busy bot away from its channel', async () => {
      await harness.engine.enqueue(request('g1', 'c1', ['Alpha']));

      expect(await errorCodeOf(() => harness.engine.enqueue(request('g1', 'c2', ['Beta'])))).toBe(
        'BOT_BUSY',
      );
      expect(harness.voice.connections).toHaveLength(1);
    });

    it('lets an idle bot move to the requester channel', async () => {
      await harness.engine.enqueue(request('g1', 'c1', ['Alpha']));
      harness.players[0]?.emitEnd();
      await flush();

      await harness.engine.join('g1', 'c2');

      expect(harness.voice.active.map((connection) => connection.channelId)).toEqual(['c2']);
    });

    it('reports a failed connection as a voice error and queues nothing', async () => {
      harness.voice.failures = 1;

      expect(await errorCodeOf(() => harness.engine.enqueue(request('g1', 'c1', ['Alpha'])))).toBe(
        'VOICE_FAILED',
      );
      expect(harness.engine.snapshot('g1').queue).toEqual([]);
    });
  });

  describe('administrator actions and lifecycle', () => {
    it('follows an administrator moving the bot by rejoining the new channel', async () => {
      await harness.engine.enqueue(request('g1', 'c1', ['Alpha']));

      await harness.engine.handleBotVoiceChange('g1', 'c9');

      expect(harness.voice.active.map((connection) => connection.channelId)).toEqual(['c9']);
      expect(harness.voice.active[0]?.subscribedTo).toBe(harness.players[0]);
      expect(harness.engine.snapshot('g1')).toMatchObject({ voiceChannelId: 'c9' });
    });

    it('counts listeners in the new channel when the connection already followed an administrator move', async () => {
      await harness.engine.enqueue(request('g1', 'c1', ['Alpha']));
      // @discordjs/voice updates its connection from the bot's own voice state first.
      const live = harness.voice.active[0];
      if (live !== undefined) {
        live.channelId = 'c9';
      }

      await harness.engine.handleBotVoiceChange('g1', 'c9');

      expect(harness.engine.snapshot('g1')).toMatchObject({ voiceChannelId: 'c9' });
      expect(harness.engine.voiceChannelOf('g1')).toBe('c9');
      expect(harness.voice.connections).toHaveLength(1);
    });

    it('treats the bot being disconnected by an administrator as a stop', async () => {
      await harness.engine.enqueue(request('g1', 'c1', ['Alpha', 'Beta']));

      await harness.engine.handleBotVoiceChange('g1', null);

      expect(harness.engine.snapshot('g1')).toMatchObject({ state: 'idle', queue: [] });
      expect(harness.events).toContainEqual({
        type: 'left_channel',
        guildId: 'g1',
        reason: 'kicked',
      });
    });

    it('reads the snapshot of an unknown guild without creating a session', () => {
      expect(harness.engine.snapshot('unknown')).toMatchObject({
        state: 'idle',
        voiceChannelId: null,
        queue: [],
      });
      expect(harness.voice.connections).toHaveLength(0);
    });

    it('shutdown leaves every voice channel and destroys the players', async () => {
      await harness.engine.enqueue(request('g1', 'c1', ['Alpha']));
      await harness.engine.enqueue(request('g2', 'c2', ['Beta']));

      await harness.engine.shutdown();

      expect(harness.voice.active).toHaveLength(0);
      expect(harness.players.every((player) => player.destroyed)).toBe(true);
    });
  });

  describe('loading a track outside the guild lock', () => {
    it('answers other commands while the next track is still loading', async () => {
      await harness.engine.enqueue(request('g1', 'c1', ['Alpha', 'Beta']));
      harness.players[0]?.emitStart();
      await flush();
      const release = harness.provider.hold('Beta');

      await harness.engine.skip('g1');
      await harness.engine.setVolume('g1', 40);

      expect(harness.players[0]?.gain).toBe(0.4);
      expect(harness.engine.snapshot('g1')).toMatchObject({
        state: 'buffering',
        nowPlaying: { track: { title: 'Beta' } },
      });

      release();
      await flush();
      await flush();
      expect(harness.players[0]?.played).toHaveLength(2);
    });

    it('closes a source that finishes opening after its track was skipped', async () => {
      await harness.engine.enqueue(request('g1', 'c1', ['Alpha', 'Slow', 'Gamma']));
      harness.players[0]?.emitStart();
      await flush();
      const release = harness.provider.hold('Slow');
      await harness.engine.skip('g1');

      await harness.engine.skip('g1');
      release();
      await flush();
      await flush();

      expect(harness.provider.signals.get('Slow')?.aborted).toBe(true);
      expect(harness.provider.opened.find((item) => item.title === 'Slow')?.closed).toBe(true);
      expect(harness.engine.snapshot('g1').nowPlaying?.track.title).toBe('Gamma');
    });

    it('gives up on a source that does not open in time, cancels it, and closes it if it opens later', async () => {
      harness = createHarness({}, { bufferTimeoutMs: 1_000 });
      const release = harness.provider.hold('Slow');

      const pending = harness.engine.enqueue(request('g1', 'c1', ['Slow', 'Alpha']));
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await pending;

      expect(result.failure).toContain('вовремя');
      expect(harness.provider.signals.get('Slow')?.aborted).toBe(true);
      expect(harness.engine.snapshot('g1').nowPlaying?.track.title).toBe('Alpha');

      release();
      await flush();
      await flush();
      expect(harness.provider.opened.find((item) => item.title === 'Slow')?.closed).toBe(true);
    });

    it('reports why the first track could not start instead of claiming it was queued', async () => {
      harness.provider.failTitles.add('Broken');

      const result = await harness.engine.enqueue(request('g1', 'c1', ['Broken']));

      expect(result).toEqual({ positions: [1], startedNow: false, failure: 'Файл недоступен.' });
      expect(harness.engine.snapshot('g1')).toMatchObject({ nowPlaying: null, queue: [] });
    });

    it('logs a failure while handling a playback event instead of leaving it unobserved', async () => {
      let failNext = false;
      harness = createHarness(
        {},
        {
          onChange: () => {
            if (failNext) {
              throw new Error('panel refresh exploded');
            }
          },
        },
      );
      await harness.engine.enqueue(request('g1', 'c1', ['Alpha', 'Beta']));
      harness.players[0]?.emitStart();
      await flush();

      failNext = true;
      harness.players[0]?.emitEnd();
      await flush();
      await flush();
      failNext = false;

      expect(harness.errors.length).toBeGreaterThan(0);
    });
  });
});
