import type { PlayableSource } from '../../audio/providers/types.js';
import type { Track } from '../models/track.js';
import type { AudioPlayerPort, LoopMode, VoiceConnectionPort } from '../ports.js';
import { TrackQueue } from '../queue/trackQueue.js';
import { canTransition, type PlaybackState } from './playbackState.js';
import { SessionTimers } from './sessionTimers.js';

/** How an attempt to start a track ended. `deferred` means it waits for a voice reconnect. */
export type StartResult =
  | { readonly outcome: 'started' }
  | { readonly outcome: 'failed'; readonly message: string }
  | { readonly outcome: 'cancelled' }
  | { readonly outcome: 'deferred' };

/** The track that is loading or playing, with the handles needed to stop it. */
export interface CurrentPlayback {
  readonly track: Track;
  readonly token: number;
  /** Aborts buffering, and closes the source through the provider's abort handling. */
  readonly controller: AbortController;
  /** Settles once, when the source has been handed to the player or the attempt has ended. */
  readonly start: PromiseWithResolvers<StartResult>;
  playable: PlayableSource | null;
  /** Set once the player reports audio. A track that ends without it never played. */
  started: boolean;
  finished: boolean;
  /** Milliseconds of audible playback accumulated before the latest pause. */
  playedMs: number;
  playingSince: number | null;
}

/**
 * Mutable state of one guild's music session. It holds no decisions. The engine changes it
 * under the per-guild lock, so each field is only touched by one operation at a time.
 */
export class GuildSession {
  state: PlaybackState = 'idle';
  connection: VoiceConnectionPort | null = null;
  voiceChannelId: string | null = null;
  current: CurrentPlayback | null = null;
  pendingReplay: Track | null = null;
  loop: LoopMode = 'off';
  volume: number;
  readonly queue: TrackQueue;
  readonly timers = new SessionTimers();
  readonly votes = new Set<string>();
  lastNotice: string | null = null;
  resumeAfterLoss: 'playing' | 'paused' | 'idle' = 'idle';
  reconnectAttempts = 0;
  private tokenCounter = 0;

  constructor(
    readonly guildId: string,
    readonly player: AudioPlayerPort,
    queueLimit: number,
    volume: number,
  ) {
    this.queue = new TrackQueue(queueLimit);
    this.volume = volume;
  }

  /** A fresh identifier for each playback. Stale callbacks compare against it. */
  nextToken(): number {
    this.tokenCounter += 1;
    return this.tokenCounter;
  }

  transition(to: PlaybackState): boolean {
    if (this.state === to) {
      return true;
    }
    if (!canTransition(this.state, to)) {
      return false;
    }
    this.state = to;
    return true;
  }
}
