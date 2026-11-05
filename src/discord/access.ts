import { PermissionFlagsBits, type GuildMember } from 'discord.js';
import type { GuildSettings } from '../database/settingsRepository.js';
import type { GuildSnapshot } from '../music/engine/snapshot.js';
import {
  evaluateAccess,
  type AccessActor,
  type AccessContext,
  type AccessAction,
  type AccessDecision,
} from '../security/accessPolicy.js';
import { AppError } from '../utils/errors.js';

/** Builds the policy actor from a guild member and the session's voice channel. */
export function actorFromMember(
  member: GuildMember,
  botChannelId: string | null,
  settings: GuildSettings,
): AccessActor {
  const channelId = member.voice.channelId;
  return {
    userId: member.id,
    inBotChannel: channelId !== null && channelId === botChannelId,
    inAnyVoiceChannel: channelId !== null,
    isDj: settings.djRoleId !== null && member.roles.cache.has(settings.djRoleId),
    isAdmin:
      member.permissions.has(PermissionFlagsBits.ManageGuild) ||
      member.permissions.has(PermissionFlagsBits.Administrator),
  };
}

/** The session facts the policy needs, taken from the engine snapshot and the guild settings. */
export function accessContextFor(
  snapshot: GuildSnapshot,
  settings: GuildSettings,
  actor: AccessActor,
): AccessContext {
  return {
    policy: settings.controlPolicy,
    botConnected: snapshot.voiceChannelId !== null,
    botBusy: snapshot.nowPlaying !== null || snapshot.queue.length > 0 || snapshot.listeners > 0,
    soleListener: actor.inBotChannel && snapshot.listeners === 1,
    skipVoteEnabled: settings.skipVotePercent > 0,
  };
}

/** Turns a denial into the error a user should see. VOTE_REQUIRED is handled by the caller. */
export function assertAllowed(decision: AccessDecision): void {
  if (decision.allowed) {
    return;
  }
  const messages = {
    NOT_IN_VOICE: 'Зайдите в голосовой канал, где играет бот, чтобы управлять музыкой.',
    NOT_ALLOWED: 'Для этого нужна роль DJ или право управления сервером.',
    BOT_BUSY:
      'Бот уже играет музыку в другом голосовом канале. Подключитесь к нему или попросите DJ переместить бота.',
    VOTE_REQUIRED: 'Пропуск требует голосования.',
  } as const;
  throw new AppError('NOT_ALLOWED', messages[decision.reason]);
}

export function decide(
  action: AccessAction,
  actor: AccessActor,
  context: AccessContext,
  target?: { readonly requesterId: string },
): AccessDecision {
  return evaluateAccess(action, actor, context, target);
}
