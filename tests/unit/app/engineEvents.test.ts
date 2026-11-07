import { describe, expect, it, vi } from 'vitest';
import { handleEngineEvent, toPlaybackSettings } from '../../../src/app/engineEvents.js';
import type { HistoryEntryInput } from '../../../src/database/historyRepository.js';
import type { GuildSettings } from '../../../src/database/settingsRepository.js';
import type { Track } from '../../../src/music/models/track.js';

const NOW = 1_700_000_000_000;

function track(overrides: Partial<Track> = {}): Track {
  return {
    id: 'entry-1',
    requesterId: 'user-1',
    createdAt: NOW - 1000,
    source: 'local',
    sourceRef: 'lib-0123456789ab',
    title: 'Song',
    artist: 'Band',
    durationSec: 200,
    thumbnailUrl: null,
    originalUrl: null,
    metadata: {},
    ...overrides,
  };
}

function deps(options: { historyFails?: boolean } = {}) {
  const add = vi.fn<(guildId: string, entry: HistoryEntryInput) => void>(() => {
    if (options.historyFails === true) {
      throw new Error('database is locked');
    }
  });
  const logger = { info: vi.fn(), warn: vi.fn() };
  return { history: { add }, logger, now: () => NOW };
}

describe('handleEngineEvent', () => {
  it('records a started track with its source, reference, requester and start time', () => {
    const d = deps();

    handleEngineEvent({ type: 'track_started', guildId: 'guild-1', track: track() }, d);

    expect(d.history.add).toHaveBeenCalledWith('guild-1', {
      title: 'Song',
      artist: 'Band',
      source: 'local',
      sourceRef: 'lib-0123456789ab',
      requesterId: 'user-1',
      playedAt: NOW,
    });
  });

  it('keeps playback going when the history write fails', () => {
    const d = deps({ historyFails: true });

    expect(() => {
      handleEngineEvent({ type: 'track_started', guildId: 'guild-1', track: track() }, d);
    }).not.toThrow();
    expect(d.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: 'guild-1' }),
      expect.any(String),
    );
  });

  it('logs a failed track with its title and the user-facing reason', () => {
    const d = deps();

    handleEngineEvent(
      { type: 'track_failed', guildId: 'guild-1', title: 'Song', message: 'Источник недоступен.' },
      d,
    );

    expect(d.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: 'guild-1',
        title: 'Song',
        reason: 'Источник недоступен.',
      }),
      expect.any(String),
    );
    expect(d.history.add).not.toHaveBeenCalled();
  });

  it('logs why the bot left a voice channel', () => {
    const d = deps();

    handleEngineEvent({ type: 'left_channel', guildId: 'guild-1', reason: 'idle' }, d);

    expect(d.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: 'guild-1', reason: 'idle' }),
      expect.any(String),
    );
  });

  it('logs a lost voice connection as a warning', () => {
    const d = deps();

    handleEngineEvent({ type: 'connection_lost', guildId: 'guild-1' }, d);

    expect(d.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: 'guild-1' }),
      expect.any(String),
    );
  });
});

describe('toPlaybackSettings', () => {
  it('passes only the playback limits to the engine', () => {
    const settings: GuildSettings = {
      guildId: 'guild-1',
      textChannelId: null,
      panelMessageId: null,
      djRoleId: null,
      controlPolicy: 'everyone',
      idleTimeoutSec: 300,
      emptyTimeoutSec: 60,
      queueLimit: 100,
      maxTrackSec: 1800,
      defaultVolume: 70,
      skipVotePercent: 50,
      allowedSources: ['local'],
      announceMode: 'all',
      stayConnected: true,
    };

    expect(toPlaybackSettings(settings)).toEqual({
      queueLimit: 100,
      maxTrackSec: 1800,
      idleTimeoutSec: 300,
      emptyTimeoutSec: 60,
      defaultVolume: 70,
      skipVotePercent: 50,
      stayConnected: true,
    });
  });
});
