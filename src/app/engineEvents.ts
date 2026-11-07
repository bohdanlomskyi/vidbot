import type { Logger } from 'pino';
import type { HistoryEntryInput } from '../database/historyRepository.js';
import type { GuildSettings } from '../database/settingsRepository.js';
import type { EngineEvent, GuildPlaybackSettings } from '../music/ports.js';

export interface EngineEventDeps {
  readonly history: { add(guildId: string, entry: HistoryEntryInput): void };
  readonly logger: Pick<Logger, 'info' | 'warn'>;
  readonly now: () => number;
}

/**
 * Turns engine events into play history and operator logs. It never throws, so a failed
 * database write or log call cannot break playback. Logs carry titles and reasons only,
 * never URLs, tokens or requester identities.
 */
export function handleEngineEvent(event: EngineEvent, deps: EngineEventDeps): void {
  switch (event.type) {
    case 'track_started':
      try {
        deps.history.add(event.guildId, {
          title: event.track.title,
          artist: event.track.artist,
          source: event.track.source,
          sourceRef: event.track.sourceRef,
          requesterId: event.track.requesterId,
          playedAt: deps.now(),
        });
      } catch (error) {
        deps.logger.warn(
          { err: error, guildId: event.guildId },
          'Could not record the play history',
        );
      }
      return;
    case 'track_failed':
      deps.logger.warn(
        { guildId: event.guildId, title: event.title, reason: event.message },
        'Track playback failed',
      );
      return;
    case 'left_channel':
      deps.logger.info({ guildId: event.guildId, reason: event.reason }, 'Left the voice channel');
      return;
    case 'connection_lost':
      deps.logger.warn({ guildId: event.guildId }, 'Voice connection was lost');
      return;
    case 'connection_restored':
      deps.logger.info({ guildId: event.guildId }, 'Voice connection was restored');
      return;
    case 'queue_finished':
      return;
    case 'moved':
      deps.logger.info({ guildId: event.guildId }, 'The bot was moved to another channel');
      return;
  }
}

/** The subset of guild settings the playback engine reads. Source selection stays in the router. */
export function toPlaybackSettings(settings: GuildSettings): GuildPlaybackSettings {
  return {
    queueLimit: settings.queueLimit,
    maxTrackSec: settings.maxTrackSec,
    idleTimeoutSec: settings.idleTimeoutSec,
    emptyTimeoutSec: settings.emptyTimeoutSec,
    defaultVolume: settings.defaultVolume,
    skipVotePercent: settings.skipVotePercent,
    stayConnected: settings.stayConnected,
  };
}
