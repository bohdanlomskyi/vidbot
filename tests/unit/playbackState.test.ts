import { describe, expect, it } from 'vitest';
import { canTransition } from '../../src/music/session/playbackState.js';

describe('playback state transitions', () => {
  it('allows the normal path from idle to playing and back to idle', () => {
    expect(canTransition('idle', 'connecting')).toBe(true);
    expect(canTransition('connecting', 'idle')).toBe(true);
    expect(canTransition('idle', 'buffering')).toBe(true);
    expect(canTransition('buffering', 'playing')).toBe(true);
    expect(canTransition('playing', 'paused')).toBe(true);
    expect(canTransition('paused', 'playing')).toBe(true);
    expect(canTransition('playing', 'idle')).toBe(true);
  });

  it('refuses to start playback in a destroyed session', () => {
    expect(canTransition('destroyed', 'buffering')).toBe(false);
    expect(canTransition('destroyed', 'idle')).toBe(false);
  });

  it('refuses to pause while a track is still buffering', () => {
    expect(canTransition('buffering', 'paused')).toBe(false);
  });

  it('lets a session resume the state it had before a voice loss', () => {
    expect(canTransition('disconnected', 'playing')).toBe(true);
    expect(canTransition('disconnected', 'paused')).toBe(true);
  });

  it('refuses to jump straight from idle to paused', () => {
    expect(canTransition('idle', 'paused')).toBe(false);
  });
});
