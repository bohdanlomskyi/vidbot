/**
 * States of one guild session. Every change goes through `canTransition`, so an impossible
 * sequence (for example pausing while a track is still buffering) is refused and logged
 * instead of silently corrupting the session.
 */
export type PlaybackState =
  | 'idle'
  | 'connecting'
  | 'buffering'
  | 'playing'
  | 'paused'
  | 'error'
  | 'disconnected'
  | 'destroyed';

const TRANSITIONS: Readonly<Record<PlaybackState, readonly PlaybackState[]>> = {
  idle: ['connecting', 'buffering', 'disconnected', 'destroyed'],
  connecting: ['idle', 'buffering', 'error', 'disconnected', 'destroyed'],
  buffering: ['playing', 'idle', 'error', 'buffering', 'disconnected', 'destroyed'],
  playing: ['paused', 'buffering', 'idle', 'error', 'disconnected', 'destroyed'],
  paused: ['playing', 'buffering', 'idle', 'error', 'disconnected', 'destroyed'],
  error: ['idle', 'buffering', 'disconnected', 'destroyed'],
  disconnected: ['connecting', 'idle', 'playing', 'paused', 'buffering', 'destroyed'],
  destroyed: [],
};

export function canTransition(from: PlaybackState, to: PlaybackState): boolean {
  return TRANSITIONS[from].includes(to);
}
