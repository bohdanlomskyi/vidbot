import { MessageFlags, type Client } from 'discord.js';
import type { Logger } from 'pino';
import type { AnnounceMode, GuildSettingsRepository } from '../database/settingsRepository.js';
import { truncate } from '../utils/format.js';
import type { ChannelFollower } from './channelFollower.js';

/** `important` events are shown in both "all" and "important" mode. `info` only in "all". */
export type AnnounceKind = 'important' | 'info';

const DUPLICATE_WINDOW_MS = 3_000;
const MAX_LENGTH = 1_800;

export interface AnnouncerOptions {
  readonly client: Client;
  readonly settings: Pick<GuildSettingsRepository, 'get'>;
  readonly follower: ChannelFollower;
  readonly logger: Pick<Logger, 'warn'>;
  readonly now?: () => number;
  /** Called after a message was sent, with where it went. */
  readonly onPosted?: (guildId: string, channelId: string, messageId: string) => void;
}

export function modeAllows(mode: AnnounceMode, kind: AnnounceKind): boolean {
  return mode === 'all' || (mode === 'important' && kind === 'important');
}

/**
 * Writes short messages about what the bot does into the server's chat: the fixed panel
 * channel, or else the channel of the latest command. Messages are silent (no notification
 * sound), mention nobody, and a repeat of the same text within seconds is dropped. Sending
 * never throws: a missing channel or permission is logged and playback carries on.
 */
export class Announcer {
  private readonly lastSent = new Map<string, { readonly text: string; readonly at: number }>();
  private readonly now: () => number;

  constructor(private readonly options: AnnouncerOptions) {
    this.now = options.now ?? Date.now;
  }

  allows(guildId: string, kind: AnnounceKind): boolean {
    return modeAllows(this.options.settings.get(guildId).announceMode, kind);
  }

  /** The channel messages for this server go to, or null when nobody has used the bot yet. */
  channelFor(guildId: string): string | null {
    return this.options.settings.get(guildId).textChannelId ?? this.options.follower.get(guildId);
  }

  /** Sends the text when the server's mode allows this kind. Returns true when it was sent. */
  async say(guildId: string, kind: AnnounceKind, text: string): Promise<boolean> {
    if (!this.allows(guildId, kind)) {
      return false;
    }
    return this.post(guildId, text);
  }

  /** Sends the text regardless of the mode. Used once the caller has already decided. */
  async post(guildId: string, text: string): Promise<boolean> {
    const channelId = this.channelFor(guildId);
    if (channelId === null) {
      return false;
    }
    const now = this.now();
    const previous = this.lastSent.get(guildId);
    if (previous?.text === text && now - previous.at < DUPLICATE_WINDOW_MS) {
      return false;
    }
    this.lastSent.set(guildId, { text, at: now });
    try {
      const channel =
        this.options.client.channels.cache.get(channelId) ??
        (await this.options.client.channels.fetch(channelId));
      if (channel === null || !channel.isTextBased() || !('send' in channel)) {
        return false;
      }
      const message = await channel.send({
        content: truncate(text, MAX_LENGTH),
        allowedMentions: { parse: [] },
        flags: MessageFlags.SuppressNotifications,
      });
      this.options.onPosted?.(guildId, channelId, message.id);
      return true;
    } catch (error) {
      this.options.logger.warn({ guildId, err: error }, 'Could not write to the chat');
      return false;
    }
  }
}
