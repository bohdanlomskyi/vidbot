import { MessageFlags, type Client } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { AnnounceMode } from '../../../src/database/settingsRepository.js';
import { Announcer, modeAllows } from '../../../src/discord/announcer.js';
import { ChannelFollower } from '../../../src/discord/channelFollower.js';

interface Setup {
  readonly announcer: Announcer;
  readonly follower: ChannelFollower;
  readonly send: ReturnType<typeof vi.fn>;
  readonly warn: ReturnType<typeof vi.fn>;
  readonly advance: (ms: number) => void;
  readonly posted: unknown[];
}

function setup(
  options: {
    mode?: AnnounceMode;
    fixedChannel?: string | null;
    sendFails?: boolean;
    channelMissing?: boolean;
  } = {},
): Setup {
  const send = vi.fn(() =>
    options.sendFails === true
      ? Promise.reject(new Error('Missing Access'))
      : Promise.resolve({ id: '700000000000000000' }),
  );
  const channel = { isTextBased: () => true, send };
  const warn = vi.fn();
  const follower = new ChannelFollower();
  let now = 1_000_000;
  const posted: unknown[] = [];
  const announcer = new Announcer({
    client: {
      channels: {
        cache: new Map(
          options.channelMissing === true
            ? []
            : [
                ['chat-1', channel],
                ['fixed-1', channel],
              ],
        ),
        fetch: () => Promise.resolve(null),
      },
    } as unknown as Client,
    settings: {
      get: () =>
        ({
          announceMode: options.mode ?? 'all',
          textChannelId: options.fixedChannel ?? null,
        }) as never,
    },
    follower,
    logger: { warn },
    now: () => now,
    onPosted: (guildId, channelId, messageId) => {
      posted.push({ guildId, channelId, messageId });
    },
  });
  return {
    announcer,
    follower,
    send,
    warn,
    advance: (ms) => {
      now += ms;
    },
    posted,
  };
}

describe('modeAllows', () => {
  it.each([
    ['all', 'important', true],
    ['all', 'info', true],
    ['important', 'important', true],
    ['important', 'info', false],
    ['off', 'important', false],
    ['off', 'info', false],
  ] as const)('mode %s, kind %s -> %s', (mode, kind, expected) => {
    expect(modeAllows(mode, kind)).toBe(expected);
  });
});

describe('Announcer', () => {
  it('writes a silent message that mentions nobody into the channel of the latest command', async () => {
    const { announcer, follower, send } = setup();
    follower.set('g1', 'chat-1');

    const sent = await announcer.say('g1', 'important', '⏸ Пауза · <@1>');

    expect(sent).toBe(true);
    expect(send).toHaveBeenCalledWith({
      content: '⏸ Пауза · <@1>',
      allowedMentions: { parse: [] },
      flags: MessageFlags.SuppressNotifications,
    });
  });

  it('prefers the channel an administrator fixed with /setup', async () => {
    const { announcer, follower, send } = setup({ fixedChannel: 'fixed-1' });
    follower.set('g1', 'chat-1');

    expect(announcer.channelFor('g1')).toBe('fixed-1');
    await announcer.say('g1', 'important', 'x');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('stays silent when no command has shown where to write', async () => {
    const { announcer, send } = setup();

    expect(await announcer.say('g1', 'important', 'x')).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('respects the mode: minor notes are dropped in "important", everything in "off"', async () => {
    const important = setup({ mode: 'important' });
    important.follower.set('g1', 'chat-1');
    expect(await important.announcer.say('g1', 'info', 'minor')).toBe(false);
    expect(await important.announcer.say('g1', 'important', 'major')).toBe(true);

    const off = setup({ mode: 'off' });
    off.follower.set('g1', 'chat-1');
    expect(await off.announcer.say('g1', 'important', 'major')).toBe(false);
    expect(off.send).not.toHaveBeenCalled();
  });

  it('drops the same text sent again within a few seconds, but not later', async () => {
    const { announcer, follower, send, advance } = setup();
    follower.set('g1', 'chat-1');

    await announcer.say('g1', 'info', '🔀 Очередь перемешана.');
    await announcer.say('g1', 'info', '🔀 Очередь перемешана.');
    advance(10_000);
    await announcer.say('g1', 'info', '🔀 Очередь перемешана.');

    expect(send).toHaveBeenCalledTimes(2);
  });

  it('never throws when sending fails, and logs it', async () => {
    const { announcer, follower, warn } = setup({ sendFails: true });
    follower.set('g1', 'chat-1');

    await expect(announcer.say('g1', 'important', 'x')).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('returns false for a channel that no longer exists', async () => {
    const { announcer, follower } = setup({ channelMissing: true });
    follower.set('g1', 'chat-1');

    await expect(announcer.say('g1', 'important', 'x')).resolves.toBe(false);
  });

  it('tells who listens where its message went, so the player panel can move below it', async () => {
    const { announcer, follower, posted } = setup();
    follower.set('g1', 'chat-1');

    await announcer.post('g1', 'Пауза');

    expect(posted).toEqual([
      { guildId: 'g1', channelId: 'chat-1', messageId: '700000000000000000' },
    ]);
  });

  it('reports nothing when the message could not be sent', async () => {
    const { announcer, follower, posted } = setup({ sendFails: true });
    follower.set('g1', 'chat-1');

    await announcer.post('g1', 'Пауза');

    expect(posted).toEqual([]);
  });
});
