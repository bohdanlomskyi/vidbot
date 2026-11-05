import type { Track } from '../models/track.js';
import type { LoopMode } from '../ports.js';
import type { PlaybackState } from '../session/playbackState.js';

export interface NowPlaying {
  readonly track: Track;
  readonly elapsedMs: number;
  readonly paused: boolean;
}

/** A read-only view of a guild session for rendering the panel and command replies. */
export interface GuildSnapshot {
  readonly guildId: string;
  readonly state: PlaybackState;
  readonly voiceChannelId: string | null;
  readonly nowPlaying: NowPlaying | null;
  readonly queue: readonly Track[];
  readonly queueLimit: number;
  readonly loop: LoopMode;
  readonly volume: number;
  readonly listeners: number;
  /** The last user-facing notice, such as a failed track or a lost connection. */
  readonly notice: string | null;
}
