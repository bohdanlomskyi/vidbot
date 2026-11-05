import { describe, expect, it } from 'vitest';
import { PendingPlaylists } from '../../../src/commands/pendingPlaylists.js';
import { draft } from '../../helpers/fakeMusic.js';

const TTL_MS = 120_000;
const GUILD = 'guild-1';
const OWNER = 'user-1';

function entry(title = 'Song') {
  return { guildId: GUILD, userId: OWNER, voiceChannelId: 'channel-1', tracks: [draft(title)] };
}

function clock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('PendingPlaylists', () => {
  it('returns the playlist to its owner once, then forgets it', () => {
    const pending = new PendingPlaylists(clock().now);
    const token = pending.add(entry('First'));

    const taken = pending.take(token, GUILD, OWNER);

    expect(taken?.tracks.map((track) => track.title)).toEqual(['First']);
    expect(pending.take(token, GUILD, OWNER)).toBeNull();
  });

  it('refuses another user and keeps the playlist for its owner', () => {
    const pending = new PendingPlaylists(clock().now);
    const token = pending.add(entry());

    expect(pending.take(token, GUILD, 'someone-else')).toBeNull();
    expect(pending.take(token, GUILD, OWNER)).not.toBeNull();
  });

  it('refuses the same user in another guild', () => {
    const pending = new PendingPlaylists(clock().now);
    const token = pending.add(entry());

    expect(pending.take(token, 'guild-2', OWNER)).toBeNull();
  });

  it('expires after two minutes', () => {
    const time = clock();
    const pending = new PendingPlaylists(time.now);
    const token = pending.add(entry());

    time.advance(TTL_MS - 1);
    expect(pending.take(token, GUILD, OWNER)).not.toBeNull();

    const second = pending.add(entry());
    time.advance(TTL_MS);
    expect(pending.take(second, GUILD, OWNER)).toBeNull();
  });

  it('drops the oldest playlist when more than 200 are waiting', () => {
    const pending = new PendingPlaylists(clock().now);
    const tokens = Array.from({ length: 201 }, () => pending.add(entry()));

    expect(pending.take(tokens[0] ?? '', GUILD, OWNER)).toBeNull();
    expect(pending.take(tokens[200] ?? '', GUILD, OWNER)).not.toBeNull();
  });

  it('gives every playlist an unguessable token of URL-safe characters', () => {
    const pending = new PendingPlaylists(clock().now);
    const tokens = Array.from({ length: 200 }, () => pending.add(entry()));

    expect(new Set(tokens).size).toBe(tokens.length);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{8}$/u);
    }
  });

  it('removes a playlist when asked, so a cancelled list cannot be confirmed later', () => {
    const pending = new PendingPlaylists(clock().now);
    const token = pending.add(entry());

    pending.remove(token);

    expect(pending.take(token, GUILD, OWNER)).toBeNull();
  });
});
