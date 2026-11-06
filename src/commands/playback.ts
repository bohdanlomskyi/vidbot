import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
} from 'discord.js';
import { parseYouTubeInput } from '../audio/providers/youtube/url.js';
import { buildCustomId } from '../security/customIds.js';
import { assertAllowed, actorFromMember, accessContextFor, decide } from '../discord/access.js';
import { buildPanelPayload, buildQueuePage, type MessagePayload } from '../discord/ui/panel.js';
import type { GuildSettings } from '../database/settingsRepository.js';
import type { GuildSnapshot } from '../music/engine/snapshot.js';
import type { SourceKind, TrackDraft } from '../music/models/track.js';
import type { AccessAction, AccessDecision } from '../security/accessPolicy.js';
import type { LoopMode } from '../music/ports.js';
import { AppError } from '../utils/errors.js';
import { describeEnqueue } from './enqueueReply.js';
import { formatDuration, truncate, escapeMarkdown } from '../utils/format.js';
import {
  assertBotCanUse,
  deferEphemeral,
  requireGuildMember,
  sayEphemeral,
  type AppServices,
  VOICE_CHANNEL_TYPES,
} from './context.js';

const RESOLVE_TIMEOUT_MS = 20_000;
const HISTORY_SHOWN = 10;
const LOOP_ORDER: readonly LoopMode[] = ['off', 'track', 'queue'];
const LOOP_NAMES: Readonly<Record<LoopMode, string>> = {
  off: 'выключен',
  track: 'текущий трек',
  queue: 'вся очередь',
};

/** Everything an action needs: the services, the guild, the member, and a way to answer. */
export interface ActionContext {
  readonly services: AppServices;
  readonly guild: Guild;
  readonly member: GuildMember;
  readonly guildId: string;
  readonly reply: (content: string) => Promise<void>;
}

type ChatHandler = (
  interaction: ChatInputCommandInteraction,
  services: AppServices,
) => Promise<void>;

async function chatContext(
  interaction: ChatInputCommandInteraction,
  services: AppServices,
): Promise<ActionContext> {
  await deferEphemeral(interaction);
  const { guild, member, guildId } = await requireGuildMember(interaction);
  return {
    services,
    guild,
    member,
    guildId,
    reply: (content) => sayEphemeral(interaction, content),
  };
}

async function buttonContext(
  interaction: ButtonInteraction,
  services: AppServices,
): Promise<ActionContext> {
  await interaction.deferUpdate();
  const { guild, member, guildId } = await requireGuildMember(interaction);
  return {
    services,
    guild,
    member,
    guildId,
    reply: async (content) => {
      await interaction.followUp({
        content,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    },
  };
}

/** Evaluates the policy for the invoking member against the live session. */
function evaluate(
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

/** Runs a guarded action, sends its result and refreshes the panel. */
async function run(
  ctx: ActionContext,
  action: AccessAction,
  perform: () => Promise<string>,
  target?: { readonly requesterId: string },
): Promise<void> {
  assertAllowed(evaluate(ctx, action, target).decision);
  const text = await perform();
  await ctx.reply(text);
  ctx.services.panel.requestRefresh(ctx.guildId);
}

function requireVoiceChannel(ctx: ActionContext) {
  const channel = ctx.member.voice.channel;
  if (channel === null) {
    throw new AppError('NOT_IN_VOICE', 'Зайдите в голосовой канал, чтобы управлять музыкой.');
  }
  return channel;
}

async function resolveInput(
  ctx: ActionContext,
  input: string,
  allowed: readonly SourceKind[],
): Promise<TrackDraft[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, RESOLVE_TIMEOUT_MS);
  try {
    return await ctx.services.sources.resolve(input, allowed, { signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new AppError('TIMEOUT', 'Источник не ответил вовремя. Попробуйте позже.', {
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function startPlayback(ctx: ActionContext, input: string): Promise<string> {
  const channel = requireVoiceChannel(ctx);
  const { decision, settings } = evaluate(ctx, 'enqueue');
  assertAllowed(decision);
  assertBotCanUse(ctx.guild, channel);

  const drafts = await resolveInput(ctx, input, settings.allowedSources);
  const first = drafts[0];
  if (first === undefined) {
    throw new AppError('NOT_FOUND', 'Ничего не найдено.');
  }
  const result = await ctx.services.engine.enqueue({
    guildId: ctx.guildId,
    voiceChannelId: channel.id,
    requesterId: ctx.member.id,
    tracks: drafts,
  });
  return describeEnqueue(
    drafts.map((item) => item.title),
    result,
  );
}

async function doSkip(ctx: ActionContext): Promise<string> {
  const { decision } = evaluate(ctx, 'skip');
  if (!decision.allowed && decision.reason === 'VOTE_REQUIRED') {
    const vote = await ctx.services.engine.voteSkip(ctx.guildId, ctx.member.id);
    return vote.skipped
      ? 'Голосование пройдено: трек пропущен.'
      : `Голос учтён: ${String(vote.votes)} из ${String(vote.required)}.`;
  }
  assertAllowed(decision);
  const skipped = await ctx.services.engine.skip(ctx.guildId);
  return skipped !== null ? `Пропущено: «${skipped.title}».` : 'Пропущено.';
}

export const PLAYBACK_COMMANDS: Readonly<Record<string, ChatHandler>> = {
  play: async (interaction, services) => {
    const ctx = await chatContext(interaction, services);
    const input = interaction.options.getString('source', true);
    await ctx.reply(await startPlayback(ctx, input));
    services.panel.requestRefresh(ctx.guildId);
  },

  replay: async (interaction, services) => {
    const ctx = await chatContext(interaction, services);
    const [last] = services.history.recent(ctx.guildId, 1);
    if (last === undefined) {
      throw new AppError('NOT_FOUND', 'В истории пока нет сыгранных треков.');
    }
    const input =
      last.source === 'youtube'
        ? `https://www.youtube.com/watch?v=${last.sourceRef}`
        : last.sourceRef;
    await ctx.reply(await startPlayback(ctx, input));
    services.panel.requestRefresh(ctx.guildId);
  },

  playlist: async (interaction, services) => {
    const ctx = await chatContext(interaction, services);
    const input = interaction.options.getString('source', true).trim();
    if (parseYouTubeInput(input)?.kind !== 'playlist') {
      throw new AppError('INVALID_INPUT', 'Пока поддерживаются только плейлисты YouTube.');
    }
    const channel = requireVoiceChannel(ctx);
    const { decision, settings } = evaluate(ctx, 'enqueue');
    assertAllowed(decision);
    assertBotCanUse(ctx.guild, channel);

    const drafts = await resolveInput(ctx, input, settings.allowedSources);
    if (drafts.length === 0) {
      throw new AppError('NOT_FOUND', 'В плейлисте нет доступных треков.');
    }
    const token = services.pendingPlaylists.add({
      guildId: ctx.guildId,
      userId: ctx.member.id,
      voiceChannelId: channel.id,
      tracks: drafts,
    });
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(buildCustomId('playlist', 'confirm', token))
        .setLabel(`Добавить ${String(drafts.length)}`)
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(buildCustomId('playlist', 'cancel', token))
        .setLabel('Отмена')
        .setStyle(ButtonStyle.Secondary),
    );
    await interaction.editReply({
      content: `Найдено треков: ${String(drafts.length)}. Добавить их в очередь?`,
      components: [row],
      allowedMentions: { parse: [] },
    });
  },

  pause: async (interaction, services) => {
    const ctx = await chatContext(interaction, services);
    await run(ctx, 'pause', async () => {
      await services.engine.pause(ctx.guildId);
      return 'Воспроизведение на паузе.';
    });
  },

  resume: async (interaction, services) => {
    const ctx = await chatContext(interaction, services);
    await run(ctx, 'resume', async () => {
      await services.engine.resume(ctx.guildId);
      return 'Воспроизведение продолжено.';
    });
  },

  skip: async (interaction, services) => {
    const ctx = await chatContext(interaction, services);
    await ctx.reply(await doSkip(ctx));
    services.panel.requestRefresh(ctx.guildId);
  },

  stop: async (interaction, services) => {
    const ctx = await chatContext(interaction, services);
    await run(ctx, 'stop', async () => {
      await services.engine.stop(ctx.guildId);
      return 'Воспроизведение остановлено, очередь очищена, бот отключён.';
    });
  },

  leave: async (interaction, services) => {
    const ctx = await chatContext(interaction, services);
    await run(ctx, 'leave', async () => {
      await services.engine.leave(ctx.guildId);
      return 'Бот отключён от голосового канала.';
    });
  },

  join: async (interaction, services) => {
    const ctx = await chatContext(interaction, services);
    const channel = requireVoiceChannel(ctx);
    assertBotCanUse(ctx.guild, channel);
    await run(ctx, 'join', async () => {
      await services.engine.join(ctx.guildId, channel.id);
      return `Бот подключён к «${channel.name}».`;
    });
  },

  move: async (interaction, services) => {
    const ctx = await chatContext(interaction, services);
    // Discord enforces the channel types declared on the option, and the type filter narrows the result.
    const channel = interaction.options.getChannel('channel', true, [...VOICE_CHANNEL_TYPES]);
    assertBotCanUse(ctx.guild, channel);
    await run(ctx, 'move', async () => {
      await services.engine.move(ctx.guildId, channel.id);
      return `Бот перемещён в «${channel.name}».`;
    });
  },

  queue: async (interaction, services) => {
    await deferEphemeral(interaction);
    const guildId = requireGuildId(interaction.guildId);
    const page = buildQueuePage(services.engine.snapshot(guildId), 1);
    await interaction.editReply({
      embeds: page.embeds,
      components: page.components,
      allowedMentions: { parse: [] },
    });
  },

  nowplaying: async (interaction, services) => {
    await deferEphemeral(interaction);
    const guildId = requireGuildId(interaction.guildId);
    const panel = buildPanelPayload(services.engine.snapshot(guildId), services.config.botName);
    await interaction.editReply({
      embeds: panel.embeds,
      components: panel.components,
      allowedMentions: { parse: [] },
    });
    services.panel.requestRefresh(guildId);
  },

  remove: async (interaction, services) => {
    const ctx = await chatContext(interaction, services);
    const position = interaction.options.getInteger('position', true);
    const target = services.engine.snapshot(ctx.guildId).queue[position - 1];
    if (target === undefined) {
      throw new AppError('NOT_FOUND', 'В очереди нет трека с таким номером.');
    }
    await run(
      ctx,
      'remove',
      async () => {
        const removed = await services.engine.remove(ctx.guildId, position);
        return `Удалено из очереди: «${removed.title}».`;
      },
      { requesterId: target.requesterId },
    );
  },

  clear: async (interaction, services) => {
    const ctx = await chatContext(interaction, services);
    await run(ctx, 'clear', async () => {
      const removed = await services.engine.clear(ctx.guildId);
      return `Очередь очищена: удалено треков ${String(removed)}.`;
    });
  },

  shuffle: async (interaction, services) => {
    const ctx = await chatContext(interaction, services);
    await run(ctx, 'shuffle', async () => {
      await services.engine.shuffle(ctx.guildId);
      return 'Очередь перемешана.';
    });
  },

  loop: async (interaction, services) => {
    const ctx = await chatContext(interaction, services);
    const mode = parseLoopMode(interaction.options.getString('mode', true));
    await run(ctx, 'loop', async () => {
      await services.engine.setLoop(ctx.guildId, mode);
      return `Повтор: ${LOOP_NAMES[mode]}.`;
    });
  },

  volume: async (interaction, services) => {
    const ctx = await chatContext(interaction, services);
    const value = interaction.options.getInteger('value', true);
    await run(ctx, 'volume', async () => {
      await services.engine.setVolume(ctx.guildId, value);
      return `Громкость: ${String(value)} %.`;
    });
  },

  history: async (interaction, services) => {
    await deferEphemeral(interaction);
    const guildId = requireGuildId(interaction.guildId);
    const entries = services.history.recent(guildId, HISTORY_SHOWN);
    const lines = entries.map(
      (entry, index) =>
        `${String(index + 1)}. ${escapeMarkdown(truncate(entry.title, 80))}${entry.artist !== null ? ` — ${escapeMarkdown(truncate(entry.artist, 40))}` : ''}`,
    );
    const embed = new EmbedBuilder()
      .setTitle('🕘 История')
      .setDescription(lines.length > 0 ? lines.join('\n') : 'Пока ничего не играло.');
    await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
  },
};

/** Panel buttons: play/pause, restart, skip, stop, loop and the queue view. */
export async function handlePanelButton(
  interaction: ButtonInteraction,
  services: AppServices,
  action: string,
): Promise<void> {
  if (action === 'queue') {
    const guildId = requireGuildId(interaction.guildId);
    const page = buildQueuePage(services.engine.snapshot(guildId), 1);
    await interaction.reply({ ...toReplyPayload(page), flags: MessageFlags.Ephemeral });
    return;
  }

  const ctx = await buttonContext(interaction, services);
  switch (action) {
    case 'toggle': {
      const state = services.engine.snapshot(ctx.guildId).state;
      if (state === 'paused') {
        await run(ctx, 'resume', async () => {
          await services.engine.resume(ctx.guildId);
          return 'Воспроизведение продолжено.';
        });
      } else {
        await run(ctx, 'pause', async () => {
          await services.engine.pause(ctx.guildId);
          return 'Воспроизведение на паузе.';
        });
      }
      return;
    }
    case 'restart':
      await run(ctx, 'restart', async () => {
        await services.engine.restart(ctx.guildId);
        return 'Трек начат сначала.';
      });
      return;
    case 'skip':
      await ctx.reply(await doSkip(ctx));
      services.panel.requestRefresh(ctx.guildId);
      return;
    case 'stop':
      await run(ctx, 'stop', async () => {
        await services.engine.stop(ctx.guildId);
        return 'Воспроизведение остановлено, бот отключён.';
      });
      return;
    case 'loop': {
      const current = services.engine.snapshot(ctx.guildId).loop;
      const next = LOOP_ORDER[(LOOP_ORDER.indexOf(current) + 1) % LOOP_ORDER.length] ?? 'off';
      await run(ctx, 'loop', async () => {
        await services.engine.setLoop(ctx.guildId, next);
        return `Повтор: ${LOOP_NAMES[next]}.`;
      });
      return;
    }
    default:
      throw new AppError('INVALID_INPUT', 'Неизвестное действие панели.');
  }
}

/** Queue page buttons: the message is updated in place. */
export function handleQueuePage(
  interaction: ButtonInteraction,
  services: AppServices,
  page: number,
): Promise<void> {
  const guildId = requireGuildId(interaction.guildId);
  const view = buildQueuePage(services.engine.snapshot(guildId), page);
  return interaction
    .update({ embeds: view.embeds, components: view.components, allowedMentions: { parse: [] } })
    .then(() => undefined);
}

/** Confirms or cancels a playlist that the member previewed with /playlist. */
export async function handlePlaylistButton(
  interaction: ButtonInteraction,
  services: AppServices,
  action: 'confirm' | 'cancel',
  token: string,
): Promise<void> {
  const { guild, member, guildId } = await requireGuildMember(interaction);
  await interaction.deferUpdate();
  const pending = services.pendingPlaylists.take(token, guildId, member.id);
  if (pending === null) {
    await interaction.editReply({
      content: 'Срок подтверждения истёк. Запустите /playlist снова.',
      components: [],
    });
    return;
  }
  if (action === 'cancel') {
    await interaction.editReply({ content: 'Плейлист отменён.', components: [] });
    return;
  }

  const snapshot = services.engine.snapshot(guildId);
  const settings = services.settings.get(guildId);
  const actor = actorFromMember(member, snapshot.voiceChannelId, settings);
  assertAllowed(decide('enqueue', actor, accessContextFor(snapshot, settings, actor)));
  const channel = member.voice.channel;
  if (channel === null || channel.id !== pending.voiceChannelId) {
    throw new AppError('NOT_IN_VOICE', 'Вы покинули голосовой канал. Запустите /playlist снова.');
  }
  assertBotCanUse(guild, channel);
  const result = await services.engine.enqueue({
    guildId,
    voiceChannelId: channel.id,
    requesterId: member.id,
    tracks: pending.tracks,
  });
  services.panel.requestRefresh(guildId);
  await interaction.editReply({
    content: describeEnqueue(
      pending.tracks.map((item) => item.title),
      result,
    ),
    components: [],
    allowedMentions: { parse: [] },
  });
}

function requireGuildId(guildId: string | null): string {
  if (guildId === null) {
    throw new AppError('INVALID_INPUT', 'Эта команда работает только на сервере.');
  }
  return guildId;
}

function parseLoopMode(value: string): LoopMode {
  return value === 'track' || value === 'queue' ? value : 'off';
}

function toReplyPayload(payload: MessagePayload): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
  allowedMentions: { parse: [] };
} {
  return { embeds: payload.embeds, components: payload.components, allowedMentions: { parse: [] } };
}

export { formatDuration };
