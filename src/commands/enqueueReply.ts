import { nowPlayingLine } from '../app/engineAnnouncements.js';
import type { EnqueueResult } from '../music/engine/musicEngine.js';
import { chatTitle, formatDuration } from '../utils/format.js';

export interface EnqueuedTrack {
  readonly title: string;
  readonly durationSec: number | null;
}

/**
 * The reply to /play, /replay and a confirmed playlist. When the first track could not
 * start, the reply says so, instead of reporting a queue position for a track that is gone.
 */
export function describeEnqueue(tracks: readonly EnqueuedTrack[], result: EnqueueResult): string {
  const firstTrack = tracks[0] ?? { title: '', durationSec: null };
  const first = chatTitle(firstTrack.title);
  const count = tracks.length;
  const position = result.positions[0] ?? 0;

  if (result.failure !== null) {
    return count === 1
      ? `Не удалось воспроизвести «${first}»: ${result.failure}`
      : `Добавлено треков: ${String(count)}. «${first}» не удалось воспроизвести: ${result.failure}`;
  }
  if (result.startedNow) {
    const playing = nowPlayingLine(firstTrack.title, firstTrack.durationSec);
    return count === 1 ? playing : `📥 Добавлено треков: ${String(count)}.\n${playing}`;
  }
  return count === 1
    ? `📥 Добавлено в очередь: «${first}» · \`${formatDuration(firstTrack.durationSec)}\` · позиция ${String(position)}.`
    : `📥 Добавлено треков: ${String(count)}, начиная с позиции ${String(position)}.`;
}
