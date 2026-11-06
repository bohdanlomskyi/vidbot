import type { EnqueueResult } from '../music/engine/musicEngine.js';

/**
 * The reply to /play, /replay and a confirmed playlist. When the first track could not
 * start, the reply says so, instead of reporting a queue position for a track that is gone.
 */
export function describeEnqueue(titles: readonly string[], result: EnqueueResult): string {
  const first = titles[0] ?? '';
  const count = titles.length;
  const position = result.positions[0] ?? 0;

  if (result.failure !== null) {
    return count === 1
      ? `Не удалось воспроизвести «${first}»: ${result.failure}`
      : `Добавлено треков: ${String(count)}. «${first}» не удалось воспроизвести: ${result.failure}`;
  }
  if (result.startedNow) {
    return count === 1
      ? `Сейчас играет: «${first}».`
      : `Добавлено треков: ${String(count)}. Сейчас играет «${first}».`;
  }
  return count === 1
    ? `Добавлено в очередь: «${first}», позиция ${String(position)}.`
    : `Добавлено треков: ${String(count)}, начиная с позиции ${String(position)}.`;
}
