import { describe, expect, it } from 'vitest';
import { describeEngineEvent, nowPlayingLine } from '../../../src/app/engineAnnouncements.js';
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

  describe('a started track', () => {
    const track = {
      id: 't1',
      source: 'local' as const,
      sourceRef: 'x',
      title: 'Lord *Verity*',
      artist: null,
      durationSec: 141,
      thumbnailUrl: null,
      originalUrl: null,
      metadata: {},
      requesterId: 'u1',
      createdAt: 0,
    };
    const started = (announcedByCaller: boolean): EngineEvent => ({
      type: 'track_started',
      guildId: GUILD,
      track,
      announcedByCaller,
    });

    it('is announced with its length and who asked for it', () => {
      expect(describeEngineEvent(started(false))).toEqual({
        kind: 'important',
        text: '🎶 Сейчас играет: **Lord \\*Verity\\*** · `2:21` · <@u1>',
      });
    });

    it('is not announced when the command that queued it already did', () => {
      expect(describeEngineEvent(started(true))).toBeNull();
    });

    it('is not announced again when the same track repeats', () => {
      expect(describeEngineEvent(started(false), { lastStartedTrackId: 't1' })).toBeNull();
    });
  });

  it('formats the now-playing line the same way for commands', () => {
    expect(nowPlayingLine('Song', null)).toBe('🎶 Сейчас играет: **Song** · `прямой эфир`');
  });
});
