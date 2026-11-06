import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { buildCustomId } from '../../security/customIds.js';
import type { GuildSnapshot } from '../../music/engine/snapshot.js';
import type { Track } from '../../music/models/track.js';
import type { LoopMode } from '../../music/ports.js';
import { escapeMarkdown, formatDuration, progressBar, truncate } from '../../utils/format.js';

export type PanelAction = 'restart' | 'toggle' | 'skip' | 'stop' | 'queue' | 'loop';

export interface MessagePayload {
  readonly embeds: EmbedBuilder[];
  readonly components: ActionRowBuilder<ButtonBuilder>[];
}

export const QUEUE_PAGE_SIZE = 10;
const UPCOMING_SHOWN = 3;

const LOOP_LABELS: Readonly<Record<LoopMode, string>> = {
  off: 'Повтор: выкл',
  track: 'Повтор: трек',
  queue: 'Повтор: очередь',
};

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
  const artist = track.artist !== null ? `\n${escapeMarkdown(truncate(track.artist, 100))}` : '';

  const embed = new EmbedBuilder()
    .setTitle(panelTitle(snapshot.state, playing.paused))
    .setDescription(`**${escapeMarkdown(truncate(track.title, 200))}**${artist}`)
    .addFields(
      { name: 'Источник', value: SOURCE_LABELS[track.source], inline: true },
      { name: 'Длительность', value: formatDuration(track.durationSec), inline: true },
      {
        name: 'Позиция',
        value: `${formatDuration(elapsedSec)} ${progressBar(ratio, 10)}`,
        inline: true,
      },
      { name: 'Добавил', value: `<@${track.requesterId}>`, inline: true },
      {
        name: 'В очереди',
        value: `${String(snapshot.queue.length)} из ${String(snapshot.queueLimit)}`,
        inline: true,
      },
      { name: 'Повтор', value: LOOP_LABELS[snapshot.loop], inline: true },
    )
    .setFooter({
      text: `${botName} · громкость ${String(snapshot.volume)}% · слушателей: ${String(snapshot.listeners)}`,
    });

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

  const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
    panelButton('restart', '⏮', ButtonStyle.Secondary, idle),
    panelButton('toggle', '⏯', ButtonStyle.Primary, idle),
    panelButton('skip', '⏭', ButtonStyle.Secondary, idle),
    panelButton('stop', '⏹', ButtonStyle.Secondary, disconnected),
  );
  const views = new ActionRowBuilder<ButtonBuilder>().addComponents(
    panelButton('queue', '📋 Очередь', ButtonStyle.Secondary, false),
    panelButton('loop', `🔁 ${LOOP_SHORT[snapshot.loop]}`, ButtonStyle.Secondary, false),
  );
  return [controls, views];
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
