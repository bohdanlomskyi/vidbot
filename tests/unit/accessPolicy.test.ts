import { describe, expect, it } from 'vitest';
import {
  evaluateAccess,
  type AccessActor,
  type AccessContext,
} from '../../src/security/accessPolicy.js';

const listener: AccessActor = {
  userId: 'u-listener',
  inBotChannel: true,
  inAnyVoiceChannel: true,
  isDj: false,
  isAdmin: false,
};
const outsider: AccessActor = {
  userId: 'u-outside',
  inBotChannel: false,
  inAnyVoiceChannel: true,
  isDj: false,
  isAdmin: false,
};
const noVoice: AccessActor = {
  userId: 'u-idle',
  inBotChannel: false,
  inAnyVoiceChannel: false,
  isDj: false,
  isAdmin: false,
};
const dj: AccessActor = {
  userId: 'u-dj',
  inBotChannel: true,
  inAnyVoiceChannel: true,
  isDj: true,
  isAdmin: false,
};
const admin: AccessActor = {
  userId: 'u-admin',
  inBotChannel: false,
  inAnyVoiceChannel: false,
  isDj: false,
  isAdmin: true,
};

const everyone: AccessContext = {
  policy: 'everyone',
  botConnected: true,
  botBusy: true,
  soleListener: false,
  skipVoteEnabled: false,
};
const djOnly: AccessContext = { ...everyone, policy: 'dj' };

describe('evaluateAccess', () => {
  it('lets listeners pause and resume under the default everyone policy', () => {
    expect(evaluateAccess('pause', listener, everyone)).toEqual({ allowed: true });
    expect(evaluateAccess('resume', listener, everyone)).toEqual({ allowed: true });
  });

  it('refuses playback controls to users outside the bot voice channel', () => {
    expect(evaluateAccess('skip', outsider, everyone)).toEqual({
      allowed: false,
      reason: 'NOT_IN_VOICE',
    });
  });

  it('restricts playback controls to DJs and admins under the dj policy', () => {
    expect(evaluateAccess('pause', listener, djOnly)).toEqual({
      allowed: false,
      reason: 'NOT_ALLOWED',
    });
    expect(evaluateAccess('pause', dj, djOnly)).toEqual({ allowed: true });
  });

  it('lets only DJs, admins or a sole listener clear the queue or stop playback', () => {
    expect(evaluateAccess('clear', listener, everyone)).toEqual({
      allowed: false,
      reason: 'NOT_ALLOWED',
    });
    expect(evaluateAccess('stop', dj, everyone)).toEqual({ allowed: true });
    expect(evaluateAccess('stop', listener, { ...everyone, soleListener: true })).toEqual({
      allowed: true,
    });
  });

  it('lets a listener remove only the tracks they requested', () => {
    expect(evaluateAccess('remove', listener, everyone, { requesterId: 'u-listener' })).toEqual({
      allowed: true,
    });
    expect(evaluateAccess('remove', listener, everyone, { requesterId: 'u-other' })).toEqual({
      allowed: false,
      reason: 'NOT_ALLOWED',
    });
    expect(evaluateAccess('remove', dj, everyone, { requesterId: 'u-other' })).toEqual({
      allowed: true,
    });
  });

  it('requires the administrator permission for setup and settings', () => {
    expect(evaluateAccess('admin', admin, everyone)).toEqual({ allowed: true });
    expect(evaluateAccess('admin', dj, everyone)).toEqual({
      allowed: false,
      reason: 'NOT_ALLOWED',
    });
    expect(evaluateAccess('admin', listener, everyone)).toEqual({
      allowed: false,
      reason: 'NOT_ALLOWED',
    });
  });

  it('refuses to move the bot for plain listeners but allows DJs and admins', () => {
    expect(evaluateAccess('move', listener, everyone)).toEqual({
      allowed: false,
      reason: 'NOT_ALLOWED',
    });
    expect(evaluateAccess('move', dj, everyone)).toEqual({ allowed: true });
    expect(evaluateAccess('move', admin, everyone)).toEqual({ allowed: true });
  });

  it('does not take the bot away from an active session in another channel', () => {
    expect(evaluateAccess('join', outsider, everyone)).toEqual({
      allowed: false,
      reason: 'BOT_BUSY',
    });
    expect(evaluateAccess('join', outsider, { ...everyone, botBusy: false })).toEqual({
      allowed: true,
    });
  });

  it('asks for a vote before a plain listener skips when voting is enabled', () => {
    const voting = { ...everyone, skipVoteEnabled: true };

    expect(evaluateAccess('skip', listener, voting)).toEqual({
      allowed: false,
      reason: 'VOTE_REQUIRED',
    });
    expect(evaluateAccess('skip', dj, voting)).toEqual({ allowed: true });
    expect(evaluateAccess('skip', listener, { ...voting, soleListener: true })).toEqual({
      allowed: true,
    });
  });

  it('refuses to enqueue for users who are not in any voice channel', () => {
    expect(evaluateAccess('enqueue', noVoice, everyone)).toEqual({
      allowed: false,
      reason: 'NOT_IN_VOICE',
    });
  });

  it('lets anyone view the queue, including users outside a voice channel', () => {
    expect(evaluateAccess('view', noVoice, djOnly)).toEqual({ allowed: true });
  });
});
