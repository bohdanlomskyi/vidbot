import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Guild,
  GuildMember,
} from 'discord.js';
import { assertAllowed, accessContextFor, actorFromMember, decide } from '../discord/access.js';
import type { AnnounceKind } from '../discord/announcer.js';
import type { GuildSettings } from '../database/settingsRepository.js';
import type { GuildSnapshot } from '../music/engine/snapshot.js';
import type { TrackDraft } from '../music/models/track.js';
import type { AccessAction, AccessDecision } from '../security/accessPolicy.js';
import { AppError } from '../utils/errors.js';
import { describeEnqueue } from './enqueueReply.js';
import { assertBotCanUse, requireGuildMember, type AppServices } from './context.js';
import { Responder, type PrivatePayload } from './responder.js';

/** Everything an action needs: the services, the guild, the member, and ways to answer. */
export interface ActionContext {
  readonly services: AppServices;
  readonly guild: Guild;
  readonly member: GuildMember;
  readonly guildId: string;
  /** A private answer that only the member sees. A later call replaces an earlier one. */
  readonly reply: (payload: PrivatePayload) => Promise<void>;
  /** A message everybody in the chat sees. False when it could not be sent. */
  readonly publish: (content: string) => Promise<boolean>;
  /** Nothing to tell: the interaction is closed without leaving a message. */
  readonly dismiss: () => Promise<void>;
}

/**
 * A slash command. A quick action is answered with one public or private reply. A slow one
 * gets a private placeholder first, and its public result goes to the chat as a normal message.
 */
export async function chatContext(
  interaction: ChatInputCommandInteraction,
  services: AppServices,
): Promise<ActionContext> {
  return interactiveContext(interaction, services, 'command');
}

/** A button on the player panel. A quick action is answered with one public reply under it. */
export async function buttonContext(
  interaction: ButtonInteraction,
  services: AppServices,
): Promise<ActionContext> {
  return interactiveContext(interaction, services, 'component');
}

async function interactiveContext(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  services: AppServices,
  kind: 'command' | 'component',
): Promise<ActionContext> {
  const guildKey = interaction.guildId ?? '';
  // Created first, so its timer counts from when the interaction arrived.
  const responder = new Responder(interaction, {
    kind,
    postToChat: (text) => services.announcer.post(guildKey, text),
    chatChannelId: () => services.announcer.channelFor(guildKey),
    onPublicMessage: (message) => {
      services.panel.notePosted(guildKey, message.channelId, message.messageId);
    },
  });
  const { guild, member, guildId } = await requireGuildMember(interaction);
  followChannel(services, guildId, interaction.channelId);
  return {
    services,
    guild,
    member,
    guildId,
    reply: (payload) => responder.private(payload),
    publish: (content) => responder.publish(content),
    dismiss: () => responder.dismiss(),
  };
}

/**
 * A button on a private message that the handler already acknowledged, such as the search
 * results. The message is replaced by the outcome, or removed when the outcome went to the chat.
 */
export async function privateButtonContext(
  interaction: ButtonInteraction,
  services: AppServices,
): Promise<ActionContext> {
  const { guild, member, guildId } = await requireGuildMember(interaction);
  followChannel(services, guildId, interaction.channelId);
  return {
    services,
    guild,
    member,
    guildId,
    reply: async (payload) => {
      await interaction.editReply({
        content: '',
        embeds: [],
        components: [],
        ...(typeof payload === 'string' ? { content: payload } : payload),
        allowedMentions: { parse: [] },
      });
    },
    publish: async (content) => {
      if (!(await services.announcer.post(guildId, content))) {
        return false;
      }
      await interaction.deleteReply().catch(() => undefined);
      return true;
    },
    dismiss: async () => {
      await interaction.deleteReply().catch(() => undefined);
    },
  };
}

function followChannel(services: AppServices, guildId: string, channelId: string | null): void {
  if (channelId !== null) {
    services.panel.follow(guildId, channelId);
  }
}

/** Evaluates the policy for the invoking member against the live session. */
export function evaluate(
  ctx: ActionContext,
  action: AccessAction,
  target?: { readonly requesterId: string },
): { decision: AccessDecision; snapshot: GuildSnapshot; settings: GuildSettings } {
  const snapshot = ctx.services.engine.snapshot(ctx.guildId);
  const settings = ctx.services.settings.get(ctx.guildId);
  const actor = actorFromMember(ctx.member, snapshot.voiceChannelId, settings);
  const decision = decide(action, actor, accessContextFor(snapshot, settings, actor), target);
  return { decision, snapshot, settings };
}

/**
 * Tells the outcome of an action. With announcements on for this kind, it becomes a short public
 * message naming the member. Otherwise only the member is told.
 */
export async function confirm(ctx: ActionContext, kind: AnnounceKind, text: string): Promise<void> {
  if (
    ctx.services.announcer.allows(ctx.guildId, kind) &&
    (await ctx.publish(`${text} · <@${ctx.member.id}>`))
  ) {
    return;
  }
  await ctx.reply(text);
}

/** Runs a guarded action, announces its result and refreshes the panel. */
export async function run(
  ctx: ActionContext,
  action: AccessAction,
  perform: () => Promise<string>,
  options: {
    readonly target?: { readonly requesterId: string };
    readonly kind?: AnnounceKind;
  } = {},
): Promise<void> {
  assertAllowed(evaluate(ctx, action, options.target).decision);
  const text = await perform();
  await confirm(ctx, options.kind ?? 'info', text);
  ctx.services.panel.requestRefresh(ctx.guildId);
}

export function requireVoiceChannel(ctx: ActionContext) {
  const channel = ctx.member.voice.channel;
  if (channel === null) {
    throw new AppError('NOT_IN_VOICE', 'Зайдите в голосовой канал, чтобы управлять музыкой.');
  }
  return channel;
}

/** Checks that the member may add music here, and returns the channel to play in. */
export function prepareToEnqueue(ctx: ActionContext) {
  const channel = requireVoiceChannel(ctx);
  const { decision, settings } = evaluate(ctx, 'enqueue');
  assertAllowed(decision);
  assertBotCanUse(ctx.guild, channel);
  return { channel, settings };
}

/** Adds resolved tracks to the queue and tells the chat what happened. */
export async function enqueueDrafts(
  ctx: ActionContext,
  drafts: readonly TrackDraft[],
  options: { readonly playNext?: boolean } = {},
): Promise<void> {
  const { channel } = prepareToEnqueue(ctx);
  const result = await ctx.services.engine.enqueue({
    guildId: ctx.guildId,
    voiceChannelId: channel.id,
    requesterId: ctx.member.id,
    tracks: drafts,
    playNext: options.playNext,
  });
  const text = describeEnqueue(drafts, result);
  if (result.failure !== null) {
    // The engine also reports the failed track to the chat; this tells the member who asked.
    await ctx.reply(text);
  } else {
    await confirm(ctx, 'important', text);
  }
  ctx.services.panel.requestRefresh(ctx.guildId);
}
