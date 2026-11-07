import { EmbedBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { AppError } from '../utils/errors.js';
import { escapeMarkdown, formatDuration, truncate } from '../utils/format.js';
import {
  type ActionContext,
  chatContext,
  enqueueDrafts,
  prepareToEnqueue,
} from './actionContext.js';
import type { AppServices } from './context.js';

const LIST_SHOWN = 25;

/** Saves the track that plays now into the member's favorites. Used by the panel button and /favorites add. */
export async function addCurrentToFavorites(ctx: ActionContext): Promise<void> {
  const playing = ctx.services.engine.snapshot(ctx.guildId).nowPlaying;
  if (playing === null) {
    throw new AppError('NOT_FOUND', 'Сейчас ничего не играет.');
  }
  const { track } = playing;
  const outcome = ctx.services.favorites.add(ctx.member.id, track);
  const title = escapeMarkdown(truncate(track.title, 80));
  switch (outcome) {
    case 'added':
      await ctx.reply(`⭐ «${title}» добавлен в ваше избранное. Список: /favorites list`);
      return;
    case 'exists':
      await ctx.reply(`«${title}» уже есть в вашем избранном.`);
      return;
    case 'full':
      await ctx.reply('Избранное заполнено. Удалите что-нибудь командой /favorites remove.');
      return;
  }
}

/** `/favorites`: add the current track, show the list, play from it, remove from it. */
export async function handleFavorites(
  interaction: ChatInputCommandInteraction,
  services: AppServices,
): Promise<void> {
  const ctx = await chatContext(interaction, services);
  const entries = services.favorites.list(ctx.member.id);

  switch (interaction.options.getSubcommand()) {
    case 'add':
      await addCurrentToFavorites(ctx);
      return;

    case 'list': {
      if (entries.length === 0) {
        await ctx.reply('В избранном пока пусто. Нажмите ⭐ на панели во время игры трека.');
        return;
      }
      const lines = entries
        .slice(0, LIST_SHOWN)
        .map(
          ({ draft }, index) =>
            `${String(index + 1)}. ${escapeMarkdown(truncate(draft.title, 70))}${draft.artist !== null ? ` — ${escapeMarkdown(truncate(draft.artist, 30))}` : ''} · ${formatDuration(draft.durationSec)}`,
        );
      if (entries.length > LIST_SHOWN) {
        lines.push(`и ещё ${String(entries.length - LIST_SHOWN)}`);
      }
      const embed = new EmbedBuilder()
        .setTitle(`⭐ Ваше избранное · ${String(entries.length)}`)
        .setDescription(lines.join('\n'))
        .setFooter({ text: '/favorites play — включить, /favorites remove — убрать' });
      await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
      return;
    }

    case 'play': {
      const number = interaction.options.getInteger('number');
      const { settings } = prepareToEnqueue(ctx);
      const chosen =
        number === null
          ? entries.map((entry) => entry.draft)
          : entries.slice(number - 1, number).map((entry) => entry.draft);
      if (chosen.length === 0) {
        throw new AppError('NOT_FOUND', 'В избранном нет такого трека.');
      }
      const playable = chosen.filter((draft) => settings.allowedSources.includes(draft.source));
      if (playable.length === 0) {
        throw new AppError('SOURCE_DISABLED', 'Источник этих треков отключён на сервере.');
      }
      await enqueueDrafts(ctx, playable);
      return;
    }

    case 'remove': {
      const number = interaction.options.getInteger('number', true);
      const removed = services.favorites.removeAt(ctx.member.id, number);
      if (removed === null) {
        throw new AppError('NOT_FOUND', 'В избранном нет трека с таким номером.');
      }
      await ctx.reply(`Убрано из избранного: «${escapeMarkdown(truncate(removed.title, 80))}».`);
      return;
    }

    default:
      throw new AppError('INVALID_INPUT', 'Неизвестная команда избранного.');
  }
}
