import type { Client } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type {
  GuildSettings,
  GuildSettingsRepository,
} from '../../../src/database/settingsRepository.js';
import { PanelManager } from '../../../src/discord/ui/panelManager.js';
import type { MusicEngine } from '../../../src/music/engine/musicEngine.js';

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
});
