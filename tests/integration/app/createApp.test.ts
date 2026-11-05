import { mkdtemp, rm } from 'node:fs/promises';
import { Events } from 'discord.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../../src/app/createApp.js';
import { loadConfig } from '../../../src/config/load.js';
import { SourceRouter } from '../../../src/music/sourceRouter.js';
import { createLogger } from '../../../src/utils/logger.js';

const TOKEN = 'a'.repeat(40);
const GUILD = '123456789012345679';

describe('createApp', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'melody-app-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('wires every service without connecting to Discord, and stops cleanly', async () => {
    const config = loadConfig(
      {
        DISCORD_TOKEN: TOKEN,
        DISCORD_CLIENT_ID: '123456789012345678',
        DATABASE_PATH: join(dir, 'data', 'melody.sqlite'),
        MUSIC_DIR: join(dir, 'music'),
        HEALTH_FILE: join(dir, 'data', 'health.json'),
      },
      dir,
    );
    const app = await createApp(config, createLogger({ level: 'silent', secrets: [TOKEN] }));

    try {
      expect(app.services.status.databaseOk).toBe(true);
      expect(app.services.status.ffmpegVersion).toMatch(/^ffmpeg version /);
      expect(app.services.engine.snapshot(GUILD).state).toBe('idle');
      expect(app.services.settings.get(GUILD).queueLimit).toBe(config.playback.maxQueueSize);
      expect(app.services.sources).toBeInstanceOf(SourceRouter);
    } finally {
      await app.stop();
    }
  });

  it('stops receiving interactions and voice events as soon as shutdown begins', async () => {
    const config = loadConfig(
      {
        DISCORD_TOKEN: TOKEN,
        DISCORD_CLIENT_ID: '123456789012345678',
        DATABASE_PATH: join(dir, 'data', 'melody.sqlite'),
        MUSIC_DIR: join(dir, 'music'),
        HEALTH_FILE: join(dir, 'data', 'health.json'),
      },
      dir,
    );
    const app = await createApp(config, createLogger({ level: 'silent', secrets: [TOKEN] }));
    expect(app.client.listenerCount(Events.InteractionCreate)).toBe(1);
    expect(app.client.listenerCount(Events.VoiceStateUpdate)).toBe(1);

    await app.stop();

    expect(app.client.listenerCount(Events.InteractionCreate)).toBe(0);
    expect(app.client.listenerCount(Events.VoiceStateUpdate)).toBe(0);
  });
});
