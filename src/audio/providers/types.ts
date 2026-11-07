import type { Readable } from 'node:stream';
import type { SourceKind, Track, TrackDraft } from '../../music/models/track.js';

export interface ResolveContext {
  readonly signal: AbortSignal;
  /**
   * True when the resolved track will start playing right away. A provider may then begin
   * opening it already while it resolves, which saves the time of a second lookup.
   */
  readonly willPlayNow?: boolean;
}

/**
 * How a playable source finished. The engine uses this to tell a normal end of
 * track from a cut-off stream, which must not be treated as a successful play.
 */
export type PlaybackEnd =
  | { readonly status: 'completed' }
  | { readonly status: 'stopped' }
  | { readonly status: 'failed'; readonly message: string };

export interface PlayableSource {
  /** Decoded audio: signed 16-bit little-endian PCM, 48 kHz, stereo. */
  readonly stream: Readable;
  /** Settles once: completed, stopped after close(), or failed with a user-safe message. */
  readonly ended: Promise<PlaybackEnd>;
  /** Stops the decoder and any upstream process. Safe to call more than once. */
  close(): Promise<void>;
}

/**
 * The contract every audio source implements. Providers decide what they accept
 * and how it becomes PCM. The engine depends only on this interface, never on a
 * specific source.
 */
export interface AudioProvider {
  readonly kind: SourceKind;
  readonly enabled: boolean;
  /** Synchronous and network-free. True when the provider may try to resolve the input. */
  canHandle(input: string): boolean;
  resolve(input: string, context: ResolveContext): Promise<readonly TrackDraft[]>;
  /** Re-checks a queued track just before playback. Throws AppError when it cannot play. */
  validate(track: Track): Promise<void>;
  getPlayableStream(track: Track, signal: AbortSignal, startSec?: number): Promise<PlayableSource>;
  /**
   * Optional. Starts opening a track that will play soon, so the later getPlayableStream is
   * fast. Best effort: it never throws. Returns false when it declined for now (no free slot,
   * provider off), so the caller may ask again later; true when the track is being opened.
   */
  preload?(track: Track): boolean;
  dispose(): Promise<void>;
}
