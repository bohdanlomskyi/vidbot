import { EventEmitter } from 'node:events';
import type { Client } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The parts of an @discordjs/voice VoiceConnection the port uses. */
class FakeLibraryConnection extends EventEmitter {
  state: { status: string } = { status: 'ready' };
  readonly joinConfig: { channelId: string | null };
  readonly rejoin = vi.fn((config: { channelId: string }) => {
    this.joinConfig.channelId = config.channelId;
    return true;
  });
  readonly destroy = vi.fn(() => {
    const oldState = this.state;
    this.state = { status: 'destroyed' };
    this.emit('stateChange', oldState, this.state);
  });
  readonly subscribe = vi.fn();

  constructor(channelId: string) {
    super();
    this.joinConfig = { channelId };
  }
}

const created: FakeLibraryConnection[] = [];

vi.mock('@discordjs/voice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@discordjs/voice')>();
  return {
    ...actual,
    joinVoiceChannel: vi.fn((config: { channelId: string }) => {
      const connection = new FakeLibraryConnection(config.channelId);
      created.push(connection);
      return connection;
    }),
    entersState: vi.fn(() => Promise.resolve()),
  };
});

const { DiscordVoicePort } = await import('../../../src/discord/voice/discordVoice.js');

function fakeClient(): Client {
  const guild = { voiceAdapterCreator: () => ({}) };
  return { guilds: { cache: new Map([['g1', guild]]) } } as unknown as Client;
}

const log = { info: vi.fn(), warn: vi.fn() };

describe('DiscordVoicePort', () => {
  beforeEach(() => {
    created.length = 0;
  });

  it('moves the guild connection to another channel instead of opening and destroying one', async () => {
    const port = new DiscordVoicePort(fakeClient(), log);

    const first = await port.connect('g1', 'c1');
    const moved = await port.connect('g1', 'c2');

    expect(moved).toBe(first);
    expect(moved.channelId).toBe('c2');
    expect(created).toHaveLength(1);
    expect(created[0]?.rejoin).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'c2' }));
    expect(created[0]?.destroy).not.toHaveBeenCalled();
  });

  it('does not rejoin when an administrator already moved the connection to that channel', async () => {
    const port = new DiscordVoicePort(fakeClient(), log);
    const connection = await port.connect('g1', 'c1');
    // The library follows the bot's own voice state, so the connection already reports c9.
    if (created[0] !== undefined) {
      created[0].joinConfig.channelId = 'c9';
    }

    const followed = await port.connect('g1', 'c9');

    expect(followed).toBe(connection);
    expect(created[0]?.rejoin).not.toHaveBeenCalled();
  });

  it('opens a new connection once the previous one was destroyed', async () => {
    const port = new DiscordVoicePort(fakeClient(), log);
    const first = await port.connect('g1', 'c1');
    first.destroy();

    const second = await port.connect('g1', 'c1');

    expect(second).not.toBe(first);
    expect(created).toHaveLength(2);
  });
});
