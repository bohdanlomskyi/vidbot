import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkDatabase, openDatabase, type SqliteDatabase } from '../../src/database/db.js';
import { HistoryRepository } from '../../src/database/historyRepository.js';
import { LibraryRepository } from '../../src/database/libraryRepository.js';
import { MIGRATIONS, migrate } from '../../src/database/migrations.js';
import {
  GuildSettingsRepository,
  type GuildSettingsDefaults,
} from '../../src/database/settingsRepository.js';
import type { LibraryRow } from '../../src/audio/library/catalog.js';

const DEFAULTS: GuildSettingsDefaults = {
  queueLimit: 100,
  maxTrackSec: 1800,
  idleTimeoutSec: 300,
  emptyTimeoutSec: 60,
  defaultVolume: 70,
  allowedSources: ['local', 'stream'],
};

describe('database schema and migrations', () => {
  it('records every migration once, and running them again changes nothing', () => {
    const db = openDatabase(':memory:');

    const first = migrate(db);
    const second = migrate(db);
    const recorded = db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as {
      count: number;
    };

    expect(first).toEqual(MIGRATIONS.map((migration) => migration.version));
    expect(second).toEqual([]);
    expect(recorded.count).toBe(MIGRATIONS.length);
    db.close();
  });

  it('lifts the old 30-minute default of existing servers and accepts 0 as no limit', () => {
    const db = openDatabase(':memory:');
    migrate(
      db,
      MIGRATIONS.filter((migration) => migration.version <= 4),
    );
    db.prepare(
      "INSERT INTO guild_settings (guild_id, max_track_sec, announce_mode, stay_connected) VALUES ('1', 1800, 'important', 1), ('2', 600, 'all', 0)",
    ).run();

    migrate(db);
    const rows = db
      .prepare(
        'SELECT guild_id, max_track_sec, announce_mode, stay_connected FROM guild_settings ORDER BY guild_id',
      )
      .all();
    const repo = new GuildSettingsRepository(db, { ...DEFAULTS, maxTrackSec: 0 });
    repo.patch('2', { maxTrackSec: 0 });

    expect(rows).toEqual([
      { guild_id: '1', max_track_sec: 0, announce_mode: 'important', stay_connected: 1 },
      { guild_id: '2', max_track_sec: 600, announce_mode: 'all', stay_connected: 0 },
    ]);
    expect(repo.get('2').maxTrackSec).toBe(0);
    expect(repo.get('3').maxTrackSec).toBe(0);
    expect(() => repo.patch('2', { maxTrackSec: 30 })).toThrow();
    expect(checkDatabase(db)).toEqual({ ok: true, detail: 'ok' });
    db.close();
  });

  it('reports a healthy database after normal use', () => {
    const db = openDatabase(':memory:');
    migrate(db);

    expect(checkDatabase(db)).toEqual({ ok: true, detail: 'ok' });
    db.close();
  });
});

describe('file-backed database', () => {
  let dir: string;
  let file: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'melody-db-'));
    file = path.join(dir, 'nested', 'melody.sqlite');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('enables write-ahead logging and foreign keys, creating the directory if needed', () => {
    const db = openDatabase(file);
    migrate(db);

    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('keeps guild settings across a restart and applies defaults on first read', () => {
    const first = openDatabase(file);
    migrate(first);
    const settings = new GuildSettingsRepository(first, DEFAULTS);
    expect(settings.get('guild-1').queueLimit).toBe(DEFAULTS.queueLimit);
    settings.patch('guild-1', { queueLimit: 25, controlPolicy: 'dj' });
    first.close();

    const reopened = openDatabase(file);
    migrate(reopened);
    const after = new GuildSettingsRepository(reopened, DEFAULTS).get('guild-1');

    expect(after).toMatchObject({ queueLimit: 25, controlPolicy: 'dj' });
    reopened.close();
  });
});

describe('GuildSettingsRepository', () => {
  let db: SqliteDatabase;
  let settings: GuildSettingsRepository;

  beforeAll(() => {
    db = openDatabase(':memory:');
    migrate(db);
    settings = new GuildSettingsRepository(db, DEFAULTS);
  });

  afterAll(() => {
    db.close();
  });

  it('rejects a patch the rules do not allow and leaves the stored value unchanged', () => {
    const before = settings.get('guild-validation').queueLimit;

    expect(() => settings.patch('guild-validation', { queueLimit: 0 })).toThrow();
    expect(settings.get('guild-validation').queueLimit).toBe(before);
  });

  it('rejects a channel identifier that is not a Discord snowflake, which the database alone would accept', () => {
    expect(() => settings.patch('guild-snowflake', { textChannelId: 'general' })).toThrow();
    expect(settings.get('guild-snowflake').textChannelId).toBeNull();
  });

  it('keeps the panel message reference and clears it on request', () => {
    settings.setPanel('guild-panel', '111111111111111111', '222222222222222222');
    expect(settings.get('guild-panel').panelMessageId).toBe('222222222222222222');

    settings.clearPanelMessage('guild-panel');
    expect(settings.get('guild-panel').panelMessageId).toBeNull();
  });

  it('stores allowed sources as a list and keeps it intact', () => {
    settings.patch('guild-sources', { allowedSources: ['local', 'youtube'] });

    expect(settings.get('guild-sources').allowedSources).toEqual(['local', 'youtube']);
  });
});

describe('HistoryRepository', () => {
  it('returns the most recent plays first and trims history beyond the retention limit', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const history = new HistoryRepository(db, 3);

    for (const title of ['t1', 't2', 't3', 't4', 't5']) {
      history.add('guild-1', {
        title,
        artist: null,
        source: 'local',
        sourceRef: title,
        requesterId: 'user-1',
        playedAt: 1,
      });
    }

    expect(history.recent('guild-1', 10).map((entry) => entry.title)).toEqual(['t5', 't4', 't3']);
    db.close();
  });

  it('keeps each guild history separate', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const history = new HistoryRepository(db, 10);
    const entry = {
      title: 'Shared',
      artist: null,
      source: 'local',
      sourceRef: 'x',
      requesterId: 'u',
      playedAt: 1,
    };

    history.add('guild-a', entry);
    history.add('guild-b', { ...entry, title: 'Other' });

    expect(history.recent('guild-a', 10).map((item) => item.title)).toEqual(['Shared']);
    db.close();
  });
});

describe('LibraryRepository', () => {
  it('saves, updates, reloads and deletes library rows by identifier', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const library = new LibraryRepository(db);
    const base: LibraryRow = {
      id: 'lib-000000000001',
      relativePath: 'Album/One.mp3',
      folder: 'Album',
      title: 'One',
      artist: null,
      durationSec: 120,
      sizeBytes: 1000,
      mtimeMs: 1,
    };

    library.save([
      base,
      { ...base, id: 'lib-000000000002', relativePath: 'Album/Two.mp3', title: 'Two' },
    ]);
    library.save([{ ...base, title: 'One (remastered)' }]);
    expect(
      library
        .loadAll()
        .map((row) => row.title)
        .sort(),
    ).toEqual(['One (remastered)', 'Two']);

    library.deleteIds(['lib-000000000002']);
    expect(library.loadAll().map((row) => row.id)).toEqual(['lib-000000000001']);
    db.close();
  });
});
