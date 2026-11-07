import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { buildCustomId } from '../../security/customIds.js';
import type { TrackDraft } from '../../music/models/track.js';
import { escapeMarkdown, formatDuration, truncate } from '../../utils/format.js';
import type { MessagePayload } from './panel.js';

export const SEARCH_RESULT_LIMIT = 5;

/** The list of search results with one numbered button for each, and a cancel button. */
export function buildSearchPicker(
  query: string,
  results: readonly TrackDraft[],
  token: string,
): MessagePayload {
  const lines = results.map((track, index) => {
    const title = escapeMarkdown(truncate(track.title, 70));
    const linked = track.originalUrl !== null ? `[${title}](${track.originalUrl})` : title;
    const channel = track.artist !== null ? ` — ${escapeMarkdown(truncate(track.artist, 40))}` : '';
    return `**${String(index + 1)}.** ${linked}${channel} · ${formatDuration(track.durationSec)}`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`🔎 Результаты по запросу «${escapeMarkdown(truncate(query, 80))}»`)
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'Нажмите номер трека. Список действует 2 минуты.' });
  const cover = results[0]?.thumbnailUrl;
  if (cover?.startsWith('https://') === true) {
    embed.setThumbnail(cover);
  }

  const picks = new ActionRowBuilder<ButtonBuilder>().addComponents(
    results.map((_track, index) =>
      new ButtonBuilder()
        .setCustomId(buildCustomId('search', 'pick', token, String(index)))
        .setLabel(String(index + 1))
        .setStyle(ButtonStyle.Primary),
    ),
  );
  const cancel = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildCustomId('search', 'cancel', token))
      .setLabel('Отмена')
      .setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [picks, cancel] };
}
