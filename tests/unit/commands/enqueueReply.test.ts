import { describe, expect, it } from 'vitest';
import { describeEnqueue } from '../../../src/commands/enqueueReply.js';

const track = (title: string, durationSec: number | null = 141) => ({ title, durationSec });

describe('describeEnqueue', () => {
  it('says the track is playing when it started straight away', () => {
    expect(
      describeEnqueue([track('Alpha')], { positions: [1], startedNow: true, failure: null }),
    ).toBe('🎶 Сейчас играет: **Alpha** · `2:21`');
  });

  it('gives the queue position of a track added behind others', () => {
    expect(
      describeEnqueue([track('Alpha')], { positions: [3], startedNow: false, failure: null }),
    ).toBe('📥 Добавлено в очередь: «Alpha» · `2:21` · позиция 3.');
  });

  it('reports a failed start instead of claiming the track was queued', () => {
    expect(
      describeEnqueue([track('Alpha')], {
        positions: [1],
        startedNow: false,
        failure: 'YouTube не ответил вовремя.',
      }),
    ).toBe('Не удалось воспроизвести «Alpha»: YouTube не ответил вовремя.');
  });

  it('counts a batch and names the first track that started', () => {
    expect(
      describeEnqueue([track('Alpha'), track('Beta')], {
        positions: [1, 2],
        startedNow: true,
        failure: null,
      }),
    ).toBe('📥 Добавлено треков: 2.\n🎶 Сейчас играет: **Alpha** · `2:21`');
    expect(
      describeEnqueue([track('Alpha'), track('Beta')], {
        positions: [4, 5],
        startedNow: false,
        failure: null,
      }),
    ).toBe('📥 Добавлено треков: 2, начиная с позиции 4.');
  });

  it('keeps the rest of a batch when its first track fails', () => {
    expect(
      describeEnqueue([track('Alpha'), track('Beta'), track('Gamma')], {
        positions: [1, 2, 3],
        startedNow: false,
        failure: 'файл недоступен.',
      }),
    ).toBe('Добавлено треков: 3. «Alpha» не удалось воспроизвести: файл недоступен.');
  });

  it('escapes markdown in a title so a link cannot be smuggled into the chat', () => {
    const text = describeEnqueue([track('[click](https://evil.example) *x*')], {
      positions: [1],
      startedNow: true,
      failure: null,
    });

    expect(text).toContain('\\[click\\](https://evil.example) \\*x\\*');
    expect(text).not.toContain('[click](');
  });
});
