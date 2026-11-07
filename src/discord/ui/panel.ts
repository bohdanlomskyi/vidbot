import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { buildCustomId } from '../../security/customIds.js';
import type { GuildSnapshot } from '../../music/engine/snapshot.js';
import type { Track } from '../../music/models/track.js';
import type { LoopMode } from '../../music/ports.js';
import { escapeMarkdown, formatDuration, progressBar, truncate } from '../../utils/format.js';

export type PanelAction =
  | 'restart'
  | 'previous'
  | 'toggle'
  | 'skip'
  | 'stop'
  | 'queue'
  | 'loop'
  | 'shuffle'
  | 'favorite'
  | 'volup'
  | 'voldown';

export interface MessagePayload {
  readonly embeds: EmbedBuilder[];
  readonly components: ActionRowBuilder<ButtonBuilder>[];
}

export const QUEUE_PAGE_SIZE = 10;
const UPCOMING_SHOWN = 3;

const LOOP_SHORT: Readonly<Record<LoopMode, string>> = {
  off: 'выкл',
  track: 'трек',
  queue: 'очередь',
};

const SOURCE_LABELS: Readonly<Record<Track['source'], string>> = {
  local: 'Библиотека',
  stream: 'Поток',
  youtube: 'YouTube (экспериментально)',
};

/** The one main panel of a guild: a now-playing embed plus the control buttons. */
export function buildPanelPayload(snapshot: GuildSnapshot, botName: string): MessagePayload {
  const embed =
    snapshot.nowPlaying === null ? idleEmbed(snapshot, botName) : playingEmbed(snapshot, botName);
  if (snapshot.notice !== null) {
    embed.addFields({ name: 'Сообщение', value: truncate(escapeMarkdown(snapshot.notice), 1024) });
  }
  return { embeds: [embed], components: panelRows(snapshot) };
}

/** One page of the queue, shown ephemerally with previous and next buttons. */
export function buildQueuePage(
  snapshot: GuildSnapshot,
  requestedPage: number,
  pageSize: number = QUEUE_PAGE_SIZE,
): MessagePayload {
  const total = Math.max(1, Math.ceil(snapshot.queue.length / pageSize));
  const page = Math.min(Math.max(1, Math.trunc(requestedPage)), total);
  const start = (page - 1) * pageSize;
  const lines = snapshot.queue
    .slice(start, start + pageSize)
    .map(
      (track, index) =>
        `${String(start + index + 1)}. ${escapeMarkdown(truncate(track.title, 80))} · ${formatDuration(track.durationSec)} · <@${track.requesterId}>`,
    );

  const embed = new EmbedBuilder()
    .setTitle(`📋 Очередь · ${String(snapshot.queue.length)} из ${String(snapshot.queueLimit)}`)
    .setDescription(lines.length > 0 ? lines.join('\n') : 'Очередь пуста.')
    .setFooter({ text: `Страница ${String(page)} из ${String(total)}` });

  const pager = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildCustomId('queue', 'page', String(page - 1)))
      .setLabel('◀')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(buildCustomId('queue', 'page', String(page + 1)))
      .setLabel('▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= total),
  );
  return { embeds: [embed], components: [pager] };
}

function playingEmbed(snapshot: GuildSnapshot, botName: string): EmbedBuilder {
  const playing = snapshot.nowPlaying;
  if (playing === null) {
    return idleEmbed(snapshot, botName);
  }
  const { track } = playing;
  const elapsedSec = playing.elapsedMs / 1000;
  const ratio =
    track.durationSec !== null && track.durationSec > 0
      ? Math.min(1, elapsedSec / track.durationSec)
      : 0;
  const position = `${playing.paused ? '⏸' : '▶'} \`[${formatDuration(elapsedSec)}/${formatDuration(track.durationSec)}]\` ${progressBar(ratio, 12)}`;

  const embed = new EmbedBuilder()
    .setAuthor({ name: panelTitle(snapshot.state, playing.paused) })
    .setTitle(escapeMarkdown(truncate(track.title, 200)))
    .setDescription(position)
    .addFields(
      { name: 'Источник', value: SOURCE_LABELS[track.source], inline: true },
      {
        name: 'Автор',
        value: track.artist !== null ? escapeMarkdown(truncate(track.artist, 100)) : '—',
        inline: true,
      },
      { name: 'Длительность', value: formatDuration(track.durationSec), inline: true },
      {
        name: 'В очереди',
        value: `${String(snapshot.queue.length)} из ${String(snapshot.queueLimit)}`,
        inline: true,
      },
      { name: 'Громкость', value: `${String(snapshot.volume)}%`, inline: true },
      { name: 'Запросил', value: `<@${track.requesterId}>`, inline: true },
    )
    .setFooter({
      text: `${botName} · слушателей: ${String(snapshot.listeners)} · повтор: ${LOOP_SHORT[snapshot.loop]}`,
    });

  if (track.originalUrl?.startsWith('https://') === true) {
    embed.setURL(track.originalUrl);
  }
  if (track.thumbnailUrl !== null && track.thumbnailUrl.startsWith('https://')) {
    embed.setThumbnail(track.thumbnailUrl);
  }
  if (snapshot.queue.length > 0) {
    embed.addFields({ name: 'Далее', value: upcomingLines(snapshot.queue) });
  }
  return embed;
}

function panelTitle(state: GuildSnapshot['state'], paused: boolean): string {
  if (paused) {
    return '⏸ На паузе';
  }
  // A network source can take seconds to open; the panel says so instead of "playing".
  return state === 'buffering' ? '⏳ Загружается' : '🎵 Сейчас играет';
}

function idleEmbed(snapshot: GuildSnapshot, botName: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`🎵 ${botName}`)
    .setDescription('Сейчас ничего не играет.\nНапишите `/play` и ссылку или название трека.')
    .setFooter({ text: `Громкость ${String(snapshot.volume)}% · очередь пуста` });
}

function upcomingLines(queue: readonly Track[]): string {
  const shown = queue
    .slice(0, UPCOMING_SHOWN)
    .map(
      (track, index) =>
        `${String(index + 1)}. ${escapeMarkdown(truncate(track.title, 60))} — <@${track.requesterId}>`,
    );
  const rest = queue.length - shown.length;
  if (rest > 0) {
    shown.push(`и ещё ${String(rest)}`);
  }
  return shown.join('\n');
}

function panelRows(snapshot: GuildSnapshot): ActionRowBuilder<ButtonBuilder>[] {
  const idle = snapshot.nowPlaying === null;
  const disconnected = snapshot.voiceChannelId === null;
  const paused = snapshot.nowPlaying?.paused === true;

  const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
    panelButton('previous', '⏮ Назад', ButtonStyle.Secondary, idle),
    panelButton('toggle', paused ? '▶ Продолжить' : '⏸ Пауза', ButtonStyle.Primary, idle),
    panelButton('skip', '⏭ Далее', ButtonStyle.Secondary, idle),
    panelButton('stop', '⏹ Стоп', ButtonStyle.Danger, disconnected),
    panelButton('queue', '📋 Очередь', ButtonStyle.Secondary, false),
  );
  const extras = new ActionRowBuilder<ButtonBuilder>().addComponents(
    panelButton('shuffle', '🔀 Перемешать', ButtonStyle.Secondary, snapshot.queue.length < 2),
    panelButton('loop', `🔁 Повтор: ${LOOP_SHORT[snapshot.loop]}`, ButtonStyle.Secondary, false),
    panelButton('favorite', '⭐ В избранное', ButtonStyle.Secondary, idle),
    panelButton('voldown', '🔉 −', ButtonStyle.Secondary, false),
    panelButton('volup', '🔊 +', ButtonStyle.Secondary, false),
  );
  return [controls, extras];
}

function panelButton(
  action: PanelAction,
  label: string,
  style: ButtonStyle,
  disabled: boolean,
): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(buildCustomId('panel', action))
    .setLabel(label)
    .setStyle(style)
    .setDisabled(disabled);
}
