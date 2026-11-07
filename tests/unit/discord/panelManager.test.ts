import type { Client } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type {
  GuildSettings,
  GuildSettingsRepository,
} from '../../../src/database/settingsRepository.js';
import { PanelManager } from '../../../src/discord/ui/panelManager.js';
import type { MusicEngine } from '../../../src/music/engine/musicEngine.js';
import type { GuildSnapshot } from '../../../src/music/engine/snapshot.js';

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/** Settings without a panel channel, so a refresh returns early after reading them. */
function unconfiguredSettings(): GuildSettings {
  return { textChannelId: null } as unknown as GuildSettings;
}

function setup(read: () => GuildSettings) {
  const settings = { get: vi.fn(read), setPanel: vi.fn(), clearPanelMessage: vi.fn() };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const panel = new PanelManager({
    client: {} as Client,
    engine: {} as MusicEngine,
    settings: settings as unknown as GuildSettingsRepository,
    botName: 'Melody',
    logger,
    refreshDelayMs: 1,
  });
  return { panel, settings, logger };
}

describe('PanelManager', () => {
  it('reports a failed refresh through the logger instead of leaking a rejected promise', async () => {
    const { panel, logger } = setup(() => {
      throw new Error('database is closed');
    });

    panel.requestRefresh('guild-1');
    await wait(20);

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: 'guild-1' }),
      expect.any(String),
    );
  });

  it('runs one refresh for a burst of requests for the same guild', async () => {
    const { panel, settings } = setup(unconfiguredSettings);

    panel.requestRefresh('guild-1');
    panel.requestRefresh('guild-1');
    panel.requestRefresh('guild-1');
    await wait(20);

    expect(settings.get).toHaveBeenCalledTimes(1);
  });

  it('cancels pending refreshes when disposed, so none runs after shutdown starts', async () => {
    const { panel, settings } = setup(unconfiguredSettings);

    panel.requestRefresh('guild-1');
    panel.dispose();
    await wait(20);

    expect(settings.get).not.toHaveBeenCalled();
  });

  describe('with a panel channel', () => {
    function idleSnapshot(volume = 70): GuildSnapshot {
      return {
        guildId: 'guild-1',
        state: 'idle',
        voiceChannelId: null,
        nowPlaying: null,
        queue: [],
        queueLimit: 100,
        loop: 'off',
        volume,
        listeners: 0,
        notice: null,
      };
    }

    function configured(sendDelayMs = 0) {
      const stored = { textChannelId: '200000000000000000', panelMessageId: null as string | null };
      let snapshot = idleSnapshot();
      const channel = {
        id: stored.textChannelId,
        guildId: 'guild-1',
        isTextBased: () => true,
        isDMBased: () => false,
        send: vi.fn(async () => {
          await wait(sendDelayMs);
          return { id: '300000000000000000' };
        }),
        messages: { edit: vi.fn(() => Promise.resolve()) },
      };
      const settings = {
        get: vi.fn(() => ({ ...stored }) as unknown as GuildSettings),
        setPanel: vi.fn((_guildId: string, _channelId: string, messageId: string) => {
          stored.panelMessageId = messageId;
        }),
        clearPanelMessage: vi.fn(),
      };
      const panel = new PanelManager({
        client: { channels: { cache: new Map([[channel.id, channel]]) } } as unknown as Client,
        engine: { snapshot: () => snapshot } as unknown as MusicEngine,
        settings: settings as unknown as GuildSettingsRepository,
        botName: 'Melody',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        refreshDelayMs: 1,
      });
      return {
        panel,
        channel,
        setSnapshot: (next: GuildSnapshot) => {
          snapshot = next;
        },
      };
    }

    it('creates a single panel message when a refresh arrives while the first one is still sending', async () => {
      const { panel, channel, setSnapshot } = configured(50);

      panel.requestRefresh('guild-1');
      await wait(10);
      setSnapshot(idleSnapshot(40));
      panel.requestRefresh('guild-1');
      await wait(150);

      expect(channel.send).toHaveBeenCalledTimes(1);
      expect(channel.messages.edit).toHaveBeenCalledTimes(1);
    });

    it('does not edit the message again when nothing shown on the panel has changed', async () => {
      const { panel, channel, setSnapshot } = configured();
      panel.requestRefresh('guild-1');
      await wait(20);

      panel.requestRefresh('guild-1');
      await wait(20);
      panel.requestRefresh('guild-1');
      await wait(20);
      expect(channel.send).toHaveBeenCalledTimes(1);
      expect(channel.messages.edit).not.toHaveBeenCalled();

      setSnapshot(idleSnapshot(30));
      panel.requestRefresh('guild-1');
      await wait(20);
      expect(channel.messages.edit).toHaveBeenCalledTimes(1);
    });
  });

  describe('following the channel of the latest command', () => {
    function channelNamed(id: string, sentIds: string[]) {
      return {
        id,
        guildId: 'guild-1',
        isTextBased: () => true,
        isDMBased: () => false,
        send: vi.fn(() => {
          const messageId = `m-${id}-${String(sentIds.length)}`;
          sentIds.push(messageId);
          return Promise.resolve({ id: messageId });
        }),
        messages: { edit: vi.fn(() => Promise.resolve()), delete: vi.fn(() => Promise.resolve()) },
      };
    }

    function followed() {
      const sent: string[] = [];
      const first = channelNamed('100000000000000001', sent);
      const second = channelNamed('100000000000000002', sent);
      const settings = {
        get: vi.fn(
          () => ({ textChannelId: null, panelMessageId: null }) as unknown as GuildSettings,
        ),
        setPanel: vi.fn(),
        clearPanelMessage: vi.fn(),
      };
      let volume = 70;
      const panel = new PanelManager({
        client: {
          channels: {
            cache: new Map([
              [first.id, first],
              [second.id, second],
            ]),
          },
        } as unknown as Client,
        engine: {
          snapshot: () => ({
            guildId: 'guild-1',
            state: 'idle',
            voiceChannelId: null,
            nowPlaying: null,
            queue: [],
            queueLimit: 100,
            loop: 'off',
            volume,
            listeners: 0,
            notice: null,
          }),
        } as unknown as MusicEngine,
        settings: settings as unknown as GuildSettingsRepository,
        botName: 'Melody',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        refreshDelayMs: 1,
      });
      return {
        panel,
        first,
        second,
        settings,
        setVolume: (value: number) => {
          volume = value;
        },
      };
    }

    it('posts nothing until a command has shown where to post', async () => {
      const { panel, first } = followed();

      panel.requestRefresh('guild-1');
      await wait(20);

      expect(first.send).not.toHaveBeenCalled();
    });

    it('creates the panel in the channel of the command and edits it afterwards', async () => {
      const { panel, first, settings, setVolume } = followed();
      panel.follow('guild-1', first.id);

      panel.requestRefresh('guild-1');
      await wait(20);
      setVolume(20);
      panel.requestRefresh('guild-1');
      await wait(20);

      expect(first.send).toHaveBeenCalledTimes(1);
      expect(first.messages.edit).toHaveBeenCalledTimes(1);
      expect(settings.setPanel).not.toHaveBeenCalled();
    });

    it('moves the panel when a command is used in another channel', async () => {
      const { panel, first, second } = followed();
      panel.follow('guild-1', first.id);
      panel.requestRefresh('guild-1');
      await wait(20);

      panel.follow('guild-1', second.id);
      panel.requestRefresh('guild-1');
      await wait(20);

      expect(first.messages.delete).toHaveBeenCalledTimes(1);
      expect(second.send).toHaveBeenCalledTimes(1);
    });

    it('sends the panel again at the bottom when asked to, replacing the old message', async () => {
      const { panel, first } = followed();
      panel.follow('guild-1', first.id);
      panel.requestRefresh('guild-1');
      await wait(20);

      panel.requestRepost('guild-1');
      await wait(20);

      expect(first.messages.delete).toHaveBeenCalledTimes(1);
      expect(first.send).toHaveBeenCalledTimes(2);
      expect(first.messages.edit).not.toHaveBeenCalled();
    });
  });
});
