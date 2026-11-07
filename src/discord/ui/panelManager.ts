import { DiscordAPIError, type Client, type GuildTextBasedChannel } from 'discord.js';
import type { Logger } from 'pino';
import type { GuildSettingsRepository } from '../../database/settingsRepository.js';
import type { MusicEngine } from '../../music/engine/musicEngine.js';
import type { GuildSnapshot } from '../../music/engine/snapshot.js';
import { ChannelFollower } from '../channelFollower.js';
import { buildPanelPayload } from './panel.js';

const UNKNOWN_MESSAGE = 10_008;
const UNKNOWN_CHANNEL = 10_003;
const MISSING_ACCESS = 50_001;
const MISSING_PERMISSIONS = 50_013;
/** Changes that arrive together (a track starts, its message is posted) become one update. */
const REFRESH_DELAY_MS = 250;

export interface PanelManagerOptions {
  readonly client: Client;
  readonly engine: MusicEngine;
  readonly settings: GuildSettingsRepository;
  readonly botName: string;
  readonly logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  readonly refreshDelayMs?: number;
  /** Where the latest command was used. The panel goes there when no channel is fixed. */
  readonly follower?: ChannelFollower;
}

/** Where a guild's panel lives. A fixed one comes from /setup, a followed one from the last command. */
interface Target {
  readonly channelId: string;
  readonly messageId: string | null;
  readonly fixed: boolean;
}

/**
 * Keeps one player panel per guild, always under the bot's latest message. Refreshes are
 * coalesced per guild and run one at a time, so two refreshes can never both create a message.
 *
 * - After every message the bot writes into the panel's channel, the panel is sent again below
 *   it: the new panel first, then the old one is deleted, so the chat is never without one.
 * - When what the panel shows changes and people have written since, it also comes back down.
 *   While it is still the newest message, it is edited in place, which is one call instead of two.
 * - An edit is skipped when nothing shown on the panel changed.
 *
 * The panel lives in the channel fixed by /setup, or else in the channel of the latest command.
 * A deleted message is recreated, and a missing channel or access problem is logged once
 * instead of being retried in a loop.
 */
export class PanelManager {
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  /** Guilds with a refresh in progress, and those that asked for another one meanwhile. */
  private readonly running = new Set<string>();
  private readonly rerun = new Set<string>();
  /** What each guild's panel message shows now, keyed by message. */
  private readonly shown = new Map<string, string>();
  /** Panels that follow commands: the message each guild's panel is in now. Not persisted. */
  private readonly followed = new Map<string, { channelId: string; messageId: string }>();
  /** Guilds whose panel must be sent again, at the bottom of the chat. */
  private readonly reposts = new Set<string>();
  /** The newest message the bot wrote into each guild's panel channel, besides the panel itself. */
  private readonly newestBotMessage = new Map<string, { channelId: string; messageId: string }>();
  private readonly follower: ChannelFollower;
  private readonly delay: number;
  private disposed = false;

  constructor(private readonly options: PanelManagerOptions) {
    this.delay = options.refreshDelayMs ?? REFRESH_DELAY_MS;
    this.follower = options.follower ?? new ChannelFollower();
  }

  /** The player panel and chat messages go to `channelId` from now on, unless /setup fixed one. */
  follow(guildId: string, channelId: string): void {
    this.follower.set(guildId, channelId);
  }

  /** Sends the panel again, so it sits under the newest messages. */
  requestRepost(guildId: string): void {
    this.reposts.add(guildId);
    this.requestRefresh(guildId);
  }

  /** The bot wrote a message. When it is in the panel's channel, the panel moves below it. */
  notePosted(guildId: string, channelId: string, messageId: string): void {
    const known = this.newestBotMessage.get(guildId);
    if (known?.channelId === channelId && !isNewer(messageId, known.messageId)) {
      return;
    }
    this.newestBotMessage.set(guildId, { channelId, messageId });
    this.requestRefresh(guildId);
  }

  /** Cancels pending refreshes. Called during shutdown, before the database is closed. */
  dispose(): void {
    this.disposed = true;
    for (const timer of this.pending.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
    this.rerun.clear();
    this.reposts.clear();
    this.newestBotMessage.clear();
  }

  requestRefresh(guildId: string): void {
    if (this.disposed) {
      return;
    }
    const existing = this.pending.get(guildId);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    this.pending.set(
      guildId,
      setTimeout(() => {
        this.pending.delete(guildId);
        this.run(guildId);
      }, this.delay),
    );
  }

  /** Creates the panel in `channel` and remembers where it lives. Used by /setup. */
  async create(guildId: string, channel: GuildTextBasedChannel): Promise<void> {
    const snapshot = this.options.engine.snapshot(guildId);
    const message = await channel.send({
      ...buildPanelPayload(snapshot, this.options.botName),
      allowedMentions: { parse: [] },
    });
    this.options.settings.setPanel(guildId, channel.id, message.id);
    this.shown.set(guildId, shownKey(message.id, snapshot));
  }

  private run(guildId: string): void {
    if (this.running.has(guildId)) {
      this.rerun.add(guildId);
      return;
    }
    this.running.add(guildId);
    this.refresh(guildId)
      .catch((error: unknown) => {
        this.reportFailure(guildId, error);
      })
      .finally(() => {
        this.running.delete(guildId);
        if (this.rerun.delete(guildId) && !this.disposed) {
          this.run(guildId);
        }
      });
  }

  private async refresh(guildId: string): Promise<void> {
    const settings = this.options.settings.get(guildId);
    const target = this.targetFor(guildId, settings.textChannelId, settings.panelMessageId);
    if (target === null) {
      return;
    }
    const snapshot = this.options.engine.snapshot(guildId);
    const forced = this.reposts.delete(guildId);
    const moved = !target.fixed && this.followed.get(guildId)?.channelId !== target.channelId;
    let messageId = target.messageId;
    const changed = messageId === null || this.shown.get(guildId) !== shownKey(messageId, snapshot);
    const botWroteBelow =
      messageId !== null && this.botWroteAfter(guildId, target.channelId, messageId);
    if (!forced && !moved && !changed && !botWroteBelow) {
      return;
    }
    const channel = await this.resolveChannel(guildId, target.channelId);
    if (channel === null) {
      return;
    }
    const peopleWroteBelow =
      messageId !== null &&
      channel.lastMessageId != null &&
      isNewer(channel.lastMessageId, messageId);

    if (moved) {
      await this.deleteFollowed(guildId);
      messageId = null;
    }

    const payload = {
      ...buildPanelPayload(snapshot, this.options.botName),
      allowedMentions: { parse: [] as [] },
    };

    // Edited in place only while it is still at the bottom; otherwise it is sent again below.
    const stayInPlace = !forced && !botWroteBelow && !peopleWroteBelow;
    if (messageId !== null && stayInPlace) {
      try {
        await channel.messages.edit(messageId, payload);
        this.shown.set(guildId, shownKey(messageId, snapshot));
        return;
      } catch (error) {
        this.shown.delete(guildId);
        if (!isDiscordError(error, UNKNOWN_MESSAGE)) {
          this.reportFailure(guildId, error);
          return;
        }
        // The message was deleted. Fall through and create a new one.
        messageId = null;
      }
    }

    try {
      const message = await channel.send(payload);
      if (target.fixed) {
        this.options.settings.setPanel(guildId, channel.id, message.id);
      } else {
        this.followed.set(guildId, { channelId: channel.id, messageId: message.id });
      }
      this.shown.set(guildId, shownKey(message.id, snapshot));
    } catch (error) {
      this.reportFailure(guildId, error);
      return;
    }
    if (messageId !== null) {
      // The old panel goes only once the new one is there.
      await channel.messages.delete(messageId).catch(() => undefined);
    }
  }

  /** True when the bot wrote a message into the panel's channel after the panel message. */
  private botWroteAfter(guildId: string, channelId: string, panelMessageId: string): boolean {
    const newest = this.newestBotMessage.get(guildId);
    return newest?.channelId === channelId && isNewer(newest.messageId, panelMessageId);
  }

  private targetFor(
    guildId: string,
    fixedChannelId: string | null,
    fixedMessageId: string | null,
  ): Target | null {
    if (fixedChannelId !== null) {
      return { channelId: fixedChannelId, messageId: fixedMessageId, fixed: true };
    }
    const channelId = this.follower.get(guildId);
    if (channelId === null) {
      return null;
    }
    const current = this.followed.get(guildId);
    return {
      channelId,
      messageId: current?.channelId === channelId ? current.messageId : null,
      fixed: false,
    };
  }

  /** Deletes the followed panel message, wherever it is. A message that is already gone is fine. */
  private async deleteFollowed(guildId: string): Promise<void> {
    const current = this.followed.get(guildId);
    this.followed.delete(guildId);
    this.shown.delete(guildId);
    if (current === undefined) {
      return;
    }
    try {
      const channel = await this.resolveChannel(guildId, current.channelId);
      await channel?.messages.delete(current.messageId);
    } catch {
      // Deleting is a tidy-up only; a message that cannot be deleted stays as a stale panel.
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
    if (code === MISSING_ACCESS || code === MISSING_PERMISSIONS) {
      this.options.logger.warn({ guildId }, 'The bot cannot write to the chat channel');
      return;
    }
    this.options.logger.error({ guildId, err: error }, 'Panel update failed');
  }
}

/** Message ids are snowflakes, which grow with time. Ids that are not numbers compare as not newer. */
export function isNewer(candidate: string, than: string): boolean {
  if (!/^\d{1,20}$/u.test(candidate) || !/^\d{1,20}$/u.test(than)) {
    return false;
  }
  return BigInt(candidate) > BigInt(than);
}

function isDiscordError(error: unknown, code: number): boolean {
  return error instanceof DiscordAPIError && error.code === code;
}

/**
 * Everything the panel shows, except the playback position: the position is only a reading
 * taken when the panel is drawn, so it alone is no reason to edit the message.
 */
function shownKey(messageId: string, snapshot: GuildSnapshot): string {
  const playing = snapshot.nowPlaying;
  return JSON.stringify([
    messageId,
    snapshot.state,
    snapshot.voiceChannelId,
    playing === null ? null : [playing.track.id, playing.paused],
    snapshot.queue.map((track) => track.id),
    snapshot.queueLimit,
    snapshot.loop,
    snapshot.volume,
    snapshot.listeners,
    snapshot.notice,
  ]);
}
