import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/load.js';

const CWD = path.resolve('/srv/melody');
const CLIENT_ID = '123456789012345678';
const TOKEN = 'config-fixture-token-0123456789abcdefghijklmnop';

function env(extra: Record<string, string> = {}): Record<string, string> {
  return { DISCORD_TOKEN: TOKEN, DISCORD_CLIENT_ID: CLIENT_ID, ...extra };
}

describe('loadConfig', () => {
  it('keeps the experimental YouTube and stream providers disabled when no flags are set', () => {
    const config = loadConfig(env(), CWD);

    expect(config.youtube.enabled).toBe(false);
    expect(config.streams.enabled).toBe(false);
  });

  it('uses an explicit queue limit instead of the default', () => {
    expect(loadConfig(env({ MAX_QUEUE_SIZE: '25' }), CWD).playback.maxQueueSize).toBe(25);
  });

  it('rejects a queue limit above the hard maximum of 500', () => {
    expect(() => loadConfig(env({ MAX_QUEUE_SIZE: '501' }), CWD)).toThrow(ConfigError);
    expect(() => loadConfig(env({ MAX_QUEUE_SIZE: '501' }), CWD)).toThrow(/MAX_QUEUE_SIZE/);
  });

  it('rejects numeric values that are not plain integers', () => {
    expect(() => loadConfig(env({ DEFAULT_VOLUME: '12abc' }), CWD)).toThrow(/DEFAULT_VOLUME/);
  });

  it('accepts only the documented boolean spellings', () => {
    expect(loadConfig(env({ STREAM_PROVIDER_ENABLED: 'true' }), CWD).streams.enabled).toBe(true);
    expect(loadConfig(env({ STREAM_PROVIDER_ENABLED: '1' }), CWD).streams.enabled).toBe(true);
    expect(loadConfig(env({ STREAM_PROVIDER_ENABLED: 'false' }), CWD).streams.enabled).toBe(false);
    expect(() => loadConfig(env({ STREAM_PROVIDER_ENABLED: 'yes' }), CWD)).toThrow(
      /STREAM_PROVIDER_ENABLED/,
    );
  });

  it('treats an empty optional variable as unset', () => {
    expect(loadConfig(env({ DISCORD_GUILD_ID: '' }), CWD).discord.guildId).toBeNull();
  });

  it('rejects a token that contains whitespace without echoing the value back', () => {
    let caught: unknown;
    try {
      loadConfig({ DISCORD_TOKEN: 'SECRETPART with spaces', DISCORD_CLIENT_ID: CLIENT_ID }, CWD);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as Error).message).toMatch(/DISCORD_TOKEN/);
    expect((caught as Error).message).not.toContain('SECRETPART');
  });

  it('requires the client ID to be a numeric snowflake', () => {
    expect(() => loadConfig(env({ DISCORD_CLIENT_ID: 'abc' }), CWD)).toThrow(/DISCORD_CLIENT_ID/);
  });

  it('resolves relative paths against the working directory it is given', () => {
    const config = loadConfig(env({ DATABASE_PATH: 'data/test.sqlite' }), CWD);

    expect(config.paths.databaseFile).toBe(path.resolve(CWD, 'data/test.sqlite'));
  });
});
