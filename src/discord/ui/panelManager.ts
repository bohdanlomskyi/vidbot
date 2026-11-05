import { DiscordAPIError, type Client, type GuildTextBasedChannel } from 'discord.js';
import type { Logger } from 'pino';
import type { GuildSettingsRepository } from '../../database/settingsRepository.js';
import type { MusicEngine } from '../../music/engine/musicEngine.js';
import { buildPanelPayload } from './panel.js';

const UNKNOWN_MESSAGE = 10_008;
const UNKNOWN_CHANNEL = 10_003;
const MISSING_ACCESS = 50_001;
const REFRESH_DELAY_MS = 1_000;

export interface PanelManagerOptions {
  readonly client: Client;
  readonly engine: MusicEngine;
  readonly settings: GuildSettingsRepository;
  readonly botName: string;
  readonly logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  readonly refreshDelayMs?: number;
}

/**
 * Keeps one main panel message per guild and updates it in place. Refreshes are coalesced
 * per guild. A deleted message is recreated, and a missing channel or access problem is
 * logged once instead of being retried in a loop.
 */
export class PanelManager {
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly delay: number;

  constructor(private readonly options: PanelManagerOptions) {
    this.delay = options.refreshDelayMs ?? REFRESH_DELAY_MS;
  }

  /** Cancels pending refreshes. Called during shutdown, before the database is closed. */
  dispose(): void {
    for (const timer of this.pending.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
  }

  requestRefresh(guildId: string): void {
    const existing = this.pending.get(guildId);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    this.pending.set(
      guildId,
      setTimeout(() => {
        this.pending.delete(guildId);
        this.refresh(guildId).catch((error: unknown) => {
          this.reportFailure(guildId, error);
        });
      }, this.delay),
    );
  }

  /** Creates the panel in `channel` and remembers where it lives. Used by /setup. */
  async create(guildId: string, channel: GuildTextBasedChannel): Promise<void> {
    const message = await channel.send({
      ...buildPanelPayload(this.options.engine.snapshot(guildId), this.options.botName),
      allowedMentions: { parse: [] },
    });
    this.options.settings.setPanel(guildId, channel.id, message.id);
  }

  async refresh(guildId: string): Promise<void> {
    const settings = this.options.settings.get(guildId);
    if (settings.textChannelId === null) {
      return;
    }
    const channel = await this.resolveChannel(guildId, settings.textChannelId);
    if (channel === null) {
      return;
    }

    const payload = {
      ...buildPanelPayload(this.options.engine.snapshot(guildId), this.options.botName),
      allowedMentions: { parse: [] as [] },
    };

    if (settings.panelMessageId !== null) {
      try {
        await channel.messages.edit(settings.panelMessageId, payload);
        return;
      } catch (error) {
        if (!isDiscordError(error, UNKNOWN_MESSAGE)) {
          this.reportFailure(guildId, error);
          return;
        }
        // The message was deleted. Fall through and create a new one.
      }
    }

    try {
      const message = await channel.send(payload);
      this.options.settings.setPanel(guildId, channel.id, message.id);
    } catch (error) {
      this.reportFailure(guildId, error);
    }
  }

  private async resolveChannel(
    guildId: string,
    channelId: string,
  ): Promise<GuildTextBasedChannel | null> {
    try {
      const channel =
        this.options.client.channels.cache.get(channelId) ??
        (await this.options.client.channels.fetch(channelId));
      if (
        channel === null ||
        !channel.isTextBased() ||
        channel.isDMBased() ||
        !('guildId' in channel)
      ) {
        return null;
      }
      return channel;
    } catch (error) {
      if (isDiscordError(error, UNKNOWN_CHANNEL)) {
        this.options.settings.clearPanelMessage(guildId);
        this.options.logger.warn(
          { guildId },
          'The panel channel no longer exists; run /setup again',
        );
      } else {
        this.reportFailure(guildId, error);
      }
      return null;
    }
  }

  private reportFailure(guildId: string, error: unknown): void {
    const code = error instanceof DiscordAPIError ? error.code : undefined;
    if (code === MISSING_ACCESS) {
      this.options.logger.warn({ guildId }, 'The bot cannot write to the panel channel');
      return;
    }
    this.options.logger.error({ guildId, err: error }, 'Panel update failed');
  }
}

function isDiscordError(error: unknown, code: number): boolean {
  return error instanceof DiscordAPIError && error.code === code;
}
