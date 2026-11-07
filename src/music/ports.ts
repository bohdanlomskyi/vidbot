import type { Readable } from 'node:stream';
import type { AudioProvider } from '../audio/providers/types.js';
import type { SourceKind, Track } from './models/track.js';

/** Why a voice connection was lost. `kicked` means an administrator removed the bot. */
export type VoiceLossReason = 'disconnected' | 'kicked';

export type LeaveReason = 'stopped' | 'idle' | 'empty' | 'kicked' | 'lost' | 'shutdown';

export type LoopMode = 'off' | 'track' | 'queue';

/** A live voice connection. The Discord implementation wraps @discordjs/voice. */
export interface VoiceConnectionPort {
  /** The channel the connection is in now. It changes when the connection is moved. */
  readonly channelId: string;
  subscribe(player: AudioPlayerPort): void;
  onLost(handler: (reason: VoiceLossReason) => void): void;
  destroy(): void;
}

export interface VoicePort {
  /**
   * Resolves once the connection is ready. Rejects when it cannot be made. Discord allows
   * one voice connection per guild: when the guild already has a live connection, it is
   * moved to `channelId` and the same object is returned.
   */
  connect(guildId: string, channelId: string): Promise<VoiceConnectionPort>;
}

/** Callbacks bound to a single playback. Events from an older playback never reach a newer one. */
export interface PlaybackCallbacks {
  readonly onStart: () => void;
  readonly onEnd: () => void;
  readonly onError: (error: Error) => void;
}

export interface AudioPlayerPort {
  /** Plays decoded PCM (signed 16-bit, 48 kHz, stereo). */
  play(stream: Readable, callbacks: PlaybackCallbacks): void;
  /** Stops the current resource without invoking its callbacks. */
  stop(): void;
  pause(): void;
  resume(): void;
  /** Linear gain from 0 to 1. */
  setVolume(gain: number): void;
  destroy(): void;
}

export interface GuildPlaybackSettings {
  readonly queueLimit: number;
  readonly maxTrackSec: number;
  readonly idleTimeoutSec: number;
  readonly emptyTimeoutSec: number;
  readonly defaultVolume: number;
  readonly skipVotePercent: number;
  /** 24/7 mode: stay in the voice channel instead of leaving when idle or when alone. */
  readonly stayConnected: boolean;
}

export type ProviderLookup = (kind: SourceKind) => AudioProvider | undefined;

/** Counts non-bot members in a voice channel. The Discord layer implements it from its cache. */
export type ListenerCounter = (guildId: string, channelId: string) => number;

export type SettingsSource = (guildId: string) => GuildPlaybackSettings;

export type EngineEvent =
  | { readonly type: 'track_started'; readonly guildId: string; readonly track: Track }
  | {
      readonly type: 'track_failed';
      readonly guildId: string;
      readonly title: string;
      readonly message: string;
    }
  | { readonly type: 'left_channel'; readonly guildId: string; readonly reason: LeaveReason }
  | { readonly type: 'connection_lost'; readonly guildId: string }
  | { readonly type: 'connection_restored'; readonly guildId: string }
  /** The last queued track ended by itself and nothing follows. */
  | { readonly type: 'queue_finished'; readonly guildId: string }
  /** An administrator moved the bot to another voice channel. */
  | { readonly type: 'moved'; readonly guildId: string; readonly channelId: string };
