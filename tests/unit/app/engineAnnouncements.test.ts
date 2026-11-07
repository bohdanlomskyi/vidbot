import { describe, expect, it } from 'vitest';
import { describeEngineEvent } from '../../../src/app/engineAnnouncements.js';
import type { EngineEvent } from '../../../src/music/ports.js';

const GUILD = 'g1';

describe('describeEngineEvent', () => {
  it('says why a track could not be played', () => {
    const event: EngineEvent = {
      type: 'track_failed',
      guildId: GUILD,
      title: 'Song',
      message: 'Видео недоступно или удалено.',
    };

    expect(describeEngineEvent(event)).toEqual({
      kind: 'important',
      text: '⚠️ Не удалось воспроизвести «Song»: Видео недоступно или удалено.',
    });
  });

  it('escapes markdown in the track title', () => {
    const described = describeEngineEvent({
      type: 'track_failed',
      guildId: GUILD,
      title: '[x](https://evil.example)',
      message: 'ошибка',
    });

    expect(described?.text).toContain('\\[x\\](https://evil.example)');
  });

  it.each([
    ['idle', 'бездействия'],
    ['empty', 'никого'],
    ['kicked', 'отключили'],
    ['lost', 'соединение'],
  ] as const)('announces leaving the channel because of %s', (reason, fragment) => {
    const described = describeEngineEvent({ type: 'left_channel', guildId: GUILD, reason });

    expect(described?.kind).toBe('important');
    expect(described?.text.toLowerCase()).toContain(fragment);
  });

  it('stays silent when a command or the shutdown ended the session', () => {
    expect(
      describeEngineEvent({ type: 'left_channel', guildId: GUILD, reason: 'stopped' }),
    ).toBeNull();
    expect(
      describeEngineEvent({ type: 'left_channel', guildId: GUILD, reason: 'shutdown' }),
    ).toBeNull();
  });

  it('reports a lost and a restored connection', () => {
    expect(describeEngineEvent({ type: 'connection_lost', guildId: GUILD })?.text).toContain(
      'Соединение',
    );
    expect(describeEngineEvent({ type: 'connection_restored', guildId: GUILD })?.text).toContain(
      'восстановлено',
    );
  });

  it('reports the end of the queue as a minor note', () => {
    expect(describeEngineEvent({ type: 'queue_finished', guildId: GUILD })).toEqual({
      kind: 'info',
      text: '✅ Очередь закончилась.',
    });
  });

  it('names the channel the bot was moved to', () => {
    expect(describeEngineEvent({ type: 'moved', guildId: GUILD, channelId: '123' })).toEqual({
      kind: 'important',
      text: '↔️ Меня переместили в канал <#123>.',
    });
  });

  it('leaves a started track to the player panel', () => {
    const started: EngineEvent = {
      type: 'track_started',
      guildId: GUILD,
      track: {
        id: 't',
        source: 'local',
        sourceRef: 'x',
        title: 'Song',
        artist: null,
        durationSec: 10,
        thumbnailUrl: null,
        originalUrl: null,
        metadata: {},
        requesterId: 'u',
        createdAt: 0,
      },
    };

    expect(describeEngineEvent(started)).toBeNull();
  });
});
