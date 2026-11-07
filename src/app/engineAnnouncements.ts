import type { EngineEvent } from '../music/ports.js';
import type { AnnounceKind } from '../discord/announcer.js';
import { chatTitle, formatDuration } from '../utils/format.js';

export interface Announcement {
  readonly kind: AnnounceKind;
  readonly text: string;
}

/** The line that tells the chat which track plays now. Commands use it too. */
export function nowPlayingLine(title: string, durationSec: number | null): string {
  return `🎶 Сейчас играет: **${chatTitle(title)}** · \`${formatDuration(durationSec)}\``;
}

/**
 * What the chat is told about an engine event. Events caused by a command (stop, leave) return
 * null, because the command already announced itself. A started track is announced with a short
 * message, unless the command that queued it reports the start itself or the track repeats.
 */
export function describeEngineEvent(event: EngineEvent): Announcement | null {
  switch (event.type) {
    case 'track_failed':
      return {
        kind: 'important',
        text: `⚠️ Не удалось воспроизвести «${chatTitle(event.title)}»: ${event.message}`,
      };
    case 'left_channel':
      switch (event.reason) {
        case 'idle':
          return {
            kind: 'important',
            text: '💤 Отключился от голосового канала из-за бездействия.',
          };
        case 'empty':
          return {
            kind: 'important',
            text: '👋 В голосовом канале никого не осталось, отключился.',
          };
        case 'kicked':
          return {
            kind: 'important',
            text: '🚪 Меня отключили от голосового канала. Очередь очищена.',
          };
        case 'lost':
          return {
            kind: 'important',
            text: '📡 Соединение с голосовым каналом потеряно и не восстановилось. Очередь очищена.',
          };
        case 'stopped':
        case 'shutdown':
          return null;
      }
      return null;
    case 'connection_lost':
      return {
        kind: 'important',
        text: '📡 Соединение с голосовым каналом потеряно, переподключаюсь…',
      };
    case 'connection_restored':
      return { kind: 'important', text: '✅ Соединение с голосовым каналом восстановлено.' };
    case 'queue_finished':
      return { kind: 'info', text: '✅ Очередь закончилась.' };
    case 'moved':
      return { kind: 'important', text: `↔️ Меня переместили в канал <#${event.channelId}>.` };
    case 'track_started':
      if (event.announcedByCaller || event.repeat) {
        return null;
      }
      return {
        kind: 'important',
        text: `${nowPlayingLine(event.track.title, event.track.durationSec)} · <@${event.track.requesterId}>`,
      };
  }
}
