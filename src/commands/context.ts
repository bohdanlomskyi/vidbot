import {
  ChannelType,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Guild,
  type User,
  type VoiceBasedChannel,
} from 'discord.js';
import type { Logger } from 'pino';
import type { AppConfig } from '../config/load.js';
import type { AuthorizedStreamProvider } from '../audio/providers/streamProvider.js';
import type { LibraryCatalog } from '../audio/library/catalog.js';
import type { YouTubeExperimentalProvider } from '../audio/providers/youtubeProvider.js';
import type { GuildSettingsRepository } from '../database/settingsRepository.js';
import type { HistoryRepository } from '../database/historyRepository.js';
import type { MusicEngine } from '../music/engine/musicEngine.js';
import type { SourceRouter } from '../music/sourceRouter.js';
import type { PanelManager } from '../discord/ui/panelManager.js';
import type { SlidingWindowRateLimiter } from '../utils/rateLimiter.js';
import { AppError } from '../utils/errors.js';
import type { PendingPlaylists } from './pendingPlaylists.js';

/** Everything a command or interaction handler may use. Built once at startup. */
export interface AppServices {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly engine: MusicEngine;
  readonly settings: GuildSettingsRepository;
  readonly history: HistoryRepository;
  readonly catalog: LibraryCatalog;
  readonly streams: AuthorizedStreamProvider;
  readonly youtube: YouTubeExperimentalProvider;
  readonly sources: SourceRouter;
  readonly panel: PanelManager;
  readonly rateLimiter: SlidingWindowRateLimiter;
  readonly pendingPlaylists: PendingPlaylists;
  readonly status: { readonly databaseOk: boolean; readonly ffmpegVersion: string | null };
  readonly startedAt: number;
}

export const VOICE_CHANNEL_TYPES = [ChannelType.GuildVoice, ChannelType.GuildStageVoice] as const;

/** The guild and the invoking member. Throws when the command was used outside a server. */
export async function requireGuildMember(interaction: {
  readonly guild: Guild | null;
  readonly member: unknown;
  readonly user: User;
}): Promise<{ readonly guild: Guild; readonly member: GuildMember; readonly guildId: string }> {
  const guild = interaction.guild;
  if (guild === null) {
    throw new AppError('INVALID_INPUT', 'Эта команда работает только на сервере.');
  }
  const member =
    interaction.member instanceof GuildMember
      ? interaction.member
      : await guild.members.fetch(interaction.user.id);
  return { guild, member, guildId: guild.id };
}

/** The bot needs to see, join and speak in the target channel before it can play there. */
export function botCanUseChannel(guild: Guild, channel: VoiceBasedChannel): boolean {
  const me = guild.members.me;
  return (
    me !== null &&
    me.permissionsIn(channel).has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])
  );
}

export function assertBotCanUse(guild: Guild, channel: VoiceBasedChannel): void {
  if (!botCanUseChannel(guild, channel)) {
    throw new AppError(
      'PERMISSION_MISSING',
      `У бота нет прав «Подключение» и «Говорить» в канале «${channel.name}». Выдайте их и повторите.`,
    );
  }
}

export function formatRetry(milliseconds: number): string {
  return String(Math.max(1, Math.ceil(milliseconds / 1000)));
}

/** Clears a deferred reply's content and sends the final text, ephemerally. */
export async function sayEphemeral(
  interaction: ChatInputCommandInteraction,
  content: string,
): Promise<void> {
  await interaction.editReply({
    content,
    embeds: [],
    components: [],
    allowedMentions: { parse: [] },
  });
}

export async function deferEphemeral(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
}

export const SETUP_ROLE_CHECK = PermissionFlagsBits.ManageGuild;
export const CHANNEL_CREATE_PERMISSION = PermissionFlagsBits.ManageChannels;
export const TEXT_CHANNEL = ChannelType.GuildText;
