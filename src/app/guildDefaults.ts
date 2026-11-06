import type { AppConfig } from '../config/load.js';
import type { GuildSettingsDefaults } from '../database/settingsRepository.js';
import type { SourceKind } from '../music/models/track.js';

/** Sources a guild may use until an administrator changes them. Optional providers only when enabled. */
export function defaultSources(config: AppConfig): SourceKind[] {
  const kinds: SourceKind[] = ['local'];
  if (config.streams.enabled) {
    kinds.push('stream');
  }
  if (config.youtube.enabled) {
    kinds.push('youtube');
  }
  return kinds;
}

/** Settings a guild starts with. The bot and the setup wizard must agree on them. */
export function guildSettingsDefaults(config: AppConfig): GuildSettingsDefaults {
  return {
    queueLimit: config.playback.maxQueueSize,
    maxTrackSec: config.playback.maxTrackSec,
    idleTimeoutSec: config.playback.idleTimeoutSec,
    emptyTimeoutSec: config.playback.emptyChannelTimeoutSec,
    defaultVolume: config.playback.defaultVolume,
    allowedSources: defaultSources(config),
  };
}
