import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type SqliteDatabase } from '../../src/database/db.js';
import { FavoritesRepository } from '../../src/database/favoritesRepository.js';
import { migrate } from '../../src/database/migrations.js';
import {
  GuildSettingsRepository,
  type GuildSettingsDefaults,
} from '../../src/database/settingsRepository.js';
import type { TrackDraft } from '../../src/music/models/track.js';

const DEFAULTS: GuildSettingsDefaults = {
  queueLimit: 100,
  maxTrackSec: 1800,
  idleTimeoutSec: 300,
  emptyTimeoutSec: 60,
  defaultVolume: 70,
  allowedSources: ['local'],
};

function draft(ref: string, title = `Track ${ref}`): TrackDraft {
  return {
    source: 'youtube',
    sourceRef: ref,
    title,
    artist: 'Channel',
    durationSec: 141,
    thumbnailUrl: 'https://i.ytimg.com/a.jpg',
    originalUrl: `https://www.youtube.com/watch?v=${ref}`,
    metadata: {},
  };
}

describe('FavoritesRepository', () => {
  let db: SqliteDatabase;
  let favorites: FavoritesRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    migrate(db);
    favorites = new FavoritesRepository(db, 3);
  });

  afterEach(() => {
    db.close();
  });

  it('saves a track for one user and lists it newest first', () => {
    favorites.add('user-1', draft('AAAAAAAAAAA'));
    favorites.add('user-1', draft('BBBBBBBBBBB'));

    const list = favorites.list('user-1');

    expect(list.map((item) => item.draft.sourceRef)).toEqual(['BBBBBBBBBBB', 'AAAAAAAAAAA']);
    expect(list[0]?.draft).toMatchObject({
      source: 'youtube',
      title: 'Track BBBBBBBBBBB',
      artist: 'Channel',
      durationSec: 141,
      thumbnailUrl: 'https://i.ytimg.com/a.jpg',
    });
    expect(favorites.list('user-2')).toEqual([]);
  });

  it('does not save the same track twice and says so', () => {
    expect(favorites.add('user-1', draft('AAAAAAAAAAA'))).toBe('added');
    expect(favorites.add('user-1', draft('AAAAAAAAAAA'))).toBe('exists');

    expect(favorites.list('user-1')).toHaveLength(1);
  });

  it('refuses to go past the limit per user', () => {
    favorites.add('user-1', draft('AAAAAAAAAAA'));
    favorites.add('user-1', draft('BBBBBBBBBBB'));
    favorites.add('user-1', draft('CCCCCCCCCCC'));

    expect(favorites.add('user-1', draft('DDDDDDDDDDD'))).toBe('full');
    expect(favorites.add('user-2', draft('DDDDDDDDDDD'))).toBe('added');
  });

  it('removes by the position shown in the list, only for its owner', () => {
    favorites.add('user-1', draft('AAAAAAAAAAA'));
    favorites.add('user-1', draft('BBBBBBBBBBB'));

    const removed = favorites.removeAt('user-1', 1);

    expect(removed?.sourceRef).toBe('BBBBBBBBBBB');
    expect(favorites.list('user-1').map((item) => item.draft.sourceRef)).toEqual(['AAAAAAAAAAA']);
    expect(favorites.removeAt('user-1', 5)).toBeNull();
    expect(favorites.removeAt('user-2', 1)).toBeNull();
  });
});

describe('new guild settings', () => {
  it('start with announcements on and 24/7 off, and can be changed', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const settings = new GuildSettingsRepository(db, DEFAULTS);

    expect(settings.get('guild-1')).toMatchObject({ announceMode: 'all', stayConnected: false });
    settings.patch('guild-1', { announceMode: 'important', stayConnected: true });

    expect(settings.get('guild-1')).toMatchObject({
      announceMode: 'important',
      stayConnected: true,
    });
    expect(() => settings.patch('guild-1', { announceMode: 'loud' as 'all' })).toThrow();
    db.close();
  });
});
