import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type Attachment,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { parseYouTubeInput } from '../audio/providers/youtube/url.js';
import { buildCustomId } from '../security/customIds.js';
import { libraryTrackId } from '../security/libraryPaths.js';
import { assertAllowed } from '../discord/access.js';
import { buildQueuePage, type MessagePayload } from '../discord/ui/panel.js';
import type { SourceKind, TrackDraft } from '../music/models/track.js';
import type { LoopMode } from '../music/ports.js';
import { AppError, isAppError } from '../utils/errors.js';
import { chatTitle, formatDuration, truncate, escapeMarkdown } from '../utils/format.js';
import {
  type ActionContext,
  buttonContext,
  chatContext,
  confirm,
  enqueueDrafts,
  evaluate,
  prepareToEnqueue,
  privateButtonContext,
  requireVoiceChannel,
  run,
} from './actionContext.js';
import {
  assertBotCanUse,
  deferEphemeral,
  type AppServices,
  VOICE_CHANNEL_TYPES,
} from './context.js';
import { addCurrentToFavorites } from './favorites.js';
import { showSearch } from './search.js';
import { actorFromMember, accessContextFor, decide } from '../discord/access.js';

const RESOLVE_TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const HISTORY_SHOWN = 10;
const VOLUME_STEP = 10;
const LOOP_ORDER: readonly LoopMode[] = ['off', 'track', 'queue'];
const LOOP_NAMES: Readonly<Record<LoopMode, string>> = {
  off: 'выключен',
  track: 'текущий трек',
  queue: 'вся очередь',
};

export type { ActionContext };

type ChatHandler = (
  interaction: ChatInputCommandInteraction,
  services: AppServices,
) => Promise<void>;

async function resolveInput(
  ctx: ActionContext,
  input: string,
  allowed: readonly SourceKind[],
  willPlayNow: boolean,
): Promise<TrackDraft[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, RESOLVE_TIMEOUT_MS);
  try {
    return await ctx.services.sources.resolve(input, allowed, {
      signal: controller.signal,
      willPlayNow,
    });
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

async function startPlayback(
  ctx: ActionContext,
  input: string,
  options: { readonly playNext?: boolean } = {},
): Promise<void> {
  const { settings } = prepareToEnqueue(ctx);
  const snapshot = ctx.services.engine.snapshot(ctx.guildId);
  // When nothing is playing, the track starts at once, so a source may open it while resolving.
  const willPlayNow = snapshot.nowPlaying === null && snapshot.queue.length === 0;

  let drafts: TrackDraft[];
  try {
    drafts = await resolveInput(ctx, input, settings.allowedSources, willPlayNow);
  } catch (error) {
    if (!isAppError(error) || error.code !== 'NOT_FOUND') {
      throw error;
    }
    // A file may have just been copied into the music folder: look again after a rescan.
    await ctx.services.refreshLibrary();
    drafts = await resolveInput(ctx, input, settings.allowedSources, willPlayNow);
  }
  if (drafts[0] === undefined) {
    throw new AppError('NOT_FOUND', 'Ничего не найдено.');
  }
  await enqueueDrafts(ctx, drafts, options);
}

/** Saves an attached audio file into the library and queues it. */
async function playAttachment(
  ctx: ActionContext,
  attachment: Attachment,
  options: { readonly playNext?: boolean },
): Promise<void> {
  const { uploads, config } = ctx.services;
  if (uploads === null || !config.uploads.enabled) {
    throw new AppError('SOURCE_DISABLED', 'Загрузка файлов отключена оператором бота.');
  }
  const { settings } = prepareToEnqueue(ctx);
  if (!settings.allowedSources.includes('local')) {
    throw new AppError(
      'SOURCE_DISABLED',
      'Источник «Библиотека сервера» отключён на этом сервере.',
    );
  }

  await ctx.reply(`⏳ Загружаю файл «${truncate(attachment.name, 60)}»…`);
  const stored = await uploads.ingest(
    { name: attachment.name, size: attachment.size, url: attachment.url },
    AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  );
  const drafts = await resolveInput(
    ctx,
    libraryTrackId(stored.relativePath),
    settings.allowedSources,
    false,
  );
  await enqueueDrafts(ctx, drafts, options);
}

async function doSkip(ctx: ActionContext): Promise<string> {
  const { decision } = evaluate(ctx, 'skip');
  if (!decision.allowed && decision.reason === 'VOTE_REQUIRED') {
    const vote = await ctx.services.engine.voteSkip(ctx.guildId, ctx.member.id);
    return vote.skipped
      ? '🗳 Голосование пройдено: трек пропущен.'
      : `🗳 Голос за пропуск учтён: ${String(vote.votes)} из ${String(vote.required)}.`;
  }
  assertAllowed(decision);
  const skipped = await ctx.services.engine.skip(ctx.guildId);
  return skipped !== null ? `⏭ Пропущено: «${chatTitle(skipped.title)}».` : '⏭ Пропущено.';
}

async function doPrevious(ctx: ActionContext): Promise<void> {
  await run(
    ctx,
    'previous',
    async () =>
      (await ctx.services.engine.previous(ctx.guildId)) === 'previous'
        ? '⏮ Возвращаюсь к предыдущему треку.'
        : '⏮ Трек начат сначала.',
    { kind: 'important' },
  );
}

export const PLAYBACK_COMMANDS: Readonly<Record<string, ChatHandler>> = {
  play: async (interaction, services) => {
    const ctx = await chatContext(interaction, services);
    const source = interaction.options.getString('source')?.trim() ?? '';
    const file = interaction.options.getAttachment('file');
    const playNext = interaction.options.getBoolean('next') ?? false;

    if (file !== null) {
      await playAttachment(ctx, file, { playNext });
      return;
    }
    if (source === '') {
      throw new AppError(
        'INVALID_INPUT',
        'Напишите название или ссылку в поле «source» либо приложите аудиофайл в поле «file».',
      );
    }
    if (services.sources.wantsSearch(source, services.settings.get(ctx.guildId).allowedSources)) {
      await showSearch(ctx, source, playNext);
      return;
    }
    await startPlayback(ctx, source, { playNext });
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
    await startPlayback(ctx, input);
  },

  playlist: async (interaction, services) => {
    const ctx = await chatContext(interaction, services);
    const input = interaction.options.getString('source', true).trim();
    if (parseYouTubeInput(input)?.kind !== 'playlist') {
      throw new AppError('INVALID_INPUT', 'Пока поддерживаются только плейлисты YouTube.');
    }
    const { channel, settings } = prepareToEnqueue(ctx);

    const drafts = await resolveInput(ctx, input, settings.allowedSources, false);
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
    await ctx.reply({
      content: `Найдено треков: ${String(drafts.length)}. Добавить их в очередь?`,
      components: [row],
    });
  },

  pause: async (interaction, services) => {
    const ctx = await chatContext(interaction, services);
    await run(ctx, 'pause', async () => {
      await services.engine.pause(ctx.guildId);
      return '⏸ Пауза.';
    });
  },

  resume: async (interaction, services) => {
    const ctx = await chatContext(interaction, services);
    await run(ctx, 'resume', async () => {
      await services.engine.resume(ctx.guildId);
      return '▶️ Продолжаем.';
    });
  },

  skip: async (interaction, services) => {
    const ctx = await chatContext(interaction, services);
    await confirm(ctx, 'important', await doSkip(ctx));
    services.panel.requestRefresh(ctx.guildId);
  },

  previous: async (interaction, services) => {
    await doPrevious(await chatContext(interaction, services));
  },

  skipto: async (interaction, services) => {
    const ctx = await chatContext(interaction, services);
    const position = interaction.options.getInteger('position', true);
    await run(
      ctx,
      'skipto',
      async () => {
        const target = await services.engine.skipTo(ctx.guildId, position);
        return `⏭ Перехожу к «${chatTitle(target.title)}».`;
      },
      { kind: 'important' },
    );
  },

  stop: async (interaction, services) => {
    const ctx = await chatContext(interaction, services);
    await run(
      ctx,
      'stop',
      async () => {
        await services.engine.stop(ctx.guildId);
        return '⏹ Остановлено, очередь очищена, бот отключён.';
      },
      { kind: 'important' },
    );
  },

  leave: async (interaction, services) => {
    const ctx = await chatContext(interaction, services);
    await run(
      ctx,
      'leave',
      async () => {
        await services.engine.leave(ctx.guildId);
        return '👋 Бот отключён от голосового канала.';
      },
      { kind: 'important' },
    );
  },

  join: async (interaction, services) => {
    const ctx = await chatContext(interaction, services);
    const channel = requireVoiceChannel(ctx);
    assertBotCanUse(ctx.guild, channel);
    await run(
      ctx,
      'join',
      async () => {
        await services.engine.join(ctx.guildId, channel.id);
        return `🔊 Бот подключён к «${channel.name}».`;
      },
      { kind: 'important' },
    );
  },

  move: async (interaction, services) => {
    const ctx = await chatContext(interaction, services);
    // Discord enforces the channel types declared on the option, and the type filter narrows the result.
    const channel = interaction.options.getChannel('channel', true, [...VOICE_CHANNEL_TYPES]);
    assertBotCanUse(ctx.guild, channel);
    await run(
      ctx,
      'move',
      async () => {
        await services.engine.move(ctx.guildId, channel.id);
        return `↔️ Бот перемещён в «${channel.name}».`;
      },
      { kind: 'important' },
    );
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
    services.panel.follow(guildId, interaction.channelId);
    // The panel is sent again at the bottom of this chat, so it is where the conversation is.
    services.panel.requestRepost(guildId);
    await interaction.editReply({ content: 'Панель плеера перенесена в этот чат.' });
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
        return `➖ Удалено из очереди: «${chatTitle(removed.title)}».`;
      },
      { target: { requesterId: target.requesterId } },
    );
  },

  clear: async (interaction, services) => {
    const ctx = await chatContext(interaction, services);
    await run(
      ctx,
      'clear',
      async () => {
        const removed = await services.engine.clear(ctx.guildId);
        return `🗑 Очередь очищена: удалено треков ${String(removed)}.`;
      },
      { kind: 'important' },
    );
  },

  shuffle: async (interaction, services) => {
    const ctx = await chatContext(interaction, services);
    await run(ctx, 'shuffle', async () => {
      await services.engine.shuffle(ctx.guildId);
      return '🔀 Очередь перемешана.';
    });
  },

  loop: async (interaction, services) => {
    const ctx = await chatContext(interaction, services);
    const mode = parseLoopMode(interaction.options.getString('mode', true));
    await run(ctx, 'loop', async () => {
      await services.engine.setLoop(ctx.guildId, mode);
      return `🔁 Повтор: ${LOOP_NAMES[mode]}.`;
    });
  },

  volume: async (interaction, services) => {
    const ctx = await chatContext(interaction, services);
    const value = interaction.options.getInteger('value', true);
    await run(ctx, 'volume', async () => {
      await services.engine.setVolume(ctx.guildId, value);
      return `🔊 Громкость: ${String(value)} %.`;
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

/** Panel buttons: the player controls, the volume, favorites and the queue view. */
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
          return '▶️ Продолжаем.';
        });
      } else {
        await run(ctx, 'pause', async () => {
          await services.engine.pause(ctx.guildId);
          return '⏸ Пауза.';
        });
      }
      return;
    }
    case 'previous':
      await doPrevious(ctx);
      return;
    case 'restart':
      await run(ctx, 'restart', async () => {
        await services.engine.restart(ctx.guildId);
        return '⏮ Трек начат сначала.';
      });
      return;
    case 'skip':
      await confirm(ctx, 'important', await doSkip(ctx));
      services.panel.requestRefresh(ctx.guildId);
      return;
    case 'stop':
      await run(
        ctx,
        'stop',
        async () => {
          await services.engine.stop(ctx.guildId);
          return '⏹ Остановлено, бот отключён.';
        },
        { kind: 'important' },
      );
      return;
    case 'shuffle':
      await run(ctx, 'shuffle', async () => {
        await services.engine.shuffle(ctx.guildId);
        return '🔀 Очередь перемешана.';
      });
      return;
    case 'loop': {
      const current = services.engine.snapshot(ctx.guildId).loop;
      const next = LOOP_ORDER[(LOOP_ORDER.indexOf(current) + 1) % LOOP_ORDER.length] ?? 'off';
      await run(ctx, 'loop', async () => {
        await services.engine.setLoop(ctx.guildId, next);
        return `🔁 Повтор: ${LOOP_NAMES[next]}.`;
      });
      return;
    }
    case 'volup':
    case 'voldown': {
      const current = services.engine.snapshot(ctx.guildId).volume;
      const step = action === 'volup' ? VOLUME_STEP : -VOLUME_STEP;
      const next = Math.min(100, Math.max(0, current + step));
      if (next === current) {
        await ctx.reply(`Громкость уже ${String(current)} %.`);
        return;
      }
      await run(ctx, 'volume', async () => {
        await services.engine.setVolume(ctx.guildId, next);
        return `🔊 Громкость: ${String(next)} %.`;
      });
      return;
    }
    case 'favorite':
      await addCurrentToFavorites(ctx);
      return;
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
  await interaction.deferUpdate();
  const ctx = await privateButtonContext(interaction, services);
  const pending = services.pendingPlaylists.take(token, ctx.guildId, ctx.member.id);
  if (pending === null) {
    await ctx.reply('Срок подтверждения истёк. Запустите /playlist снова.');
    return;
  }
  if (action === 'cancel') {
    await ctx.reply('Плейлист отменён.');
    return;
  }

  const snapshot = services.engine.snapshot(ctx.guildId);
  const settings = services.settings.get(ctx.guildId);
  const actor = actorFromMember(ctx.member, snapshot.voiceChannelId, settings);
  assertAllowed(decide('enqueue', actor, accessContextFor(snapshot, settings, actor)));
  const channel = ctx.member.voice.channel;
  if (channel === null || channel.id !== pending.voiceChannelId) {
    throw new AppError('NOT_IN_VOICE', 'Вы покинули голосовой канал. Запустите /playlist снова.');
  }
  assertBotCanUse(ctx.guild, channel);
  await enqueueDrafts(ctx, pending.tracks);
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
