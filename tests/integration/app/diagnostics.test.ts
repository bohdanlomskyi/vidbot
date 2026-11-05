import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DiagnosticResult, runDiagnostics } from '../../../src/app/diagnostics.js';

const TOKEN = 'b'.repeat(45);

function validEnv(dir: string): Record<string, string> {
  return {
    DISCORD_TOKEN: TOKEN,
    DISCORD_CLIENT_ID: '123456789012345678',
    DATABASE_PATH: join(dir, 'data', 'melody.sqlite'),
    MUSIC_DIR: join(dir, 'music'),
    HEALTH_FILE: join(dir, 'data', 'health.json'),
  };
}

function find(results: readonly DiagnosticResult[], name: string): DiagnosticResult | undefined {
  return results.find((result) => result.name === name);
}

describe('runDiagnostics', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'melody-doctor-'));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'music'), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('passes the checks that a complete environment can satisfy', async () => {
    const results = await runDiagnostics(validEnv(dir), dir);

    expect(results.filter((result) => result.status === 'fail')).toEqual([]);
    expect(find(results, 'Конфигурация')?.status).toBe('ok');
    expect(find(results, 'FFmpeg')?.status).toBe('ok');
    expect(find(results, 'ffprobe')?.status).toBe('ok');
    expect(find(results, 'SQLite')?.status).toBe('ok');
    expect(find(results, 'Opus')?.status).toBe('ok');
    expect(find(results, 'DAVE')?.status).toBe('ok');
    expect(find(results, 'Шифрование')?.status).toBe('ok');
  });

  it('skips the optional YouTube check while the provider is disabled', async () => {
    const results = await runDiagnostics(validEnv(dir), dir);

    expect(find(results, 'yt-dlp')?.status).toBe('skip');
  });

  it('reports a broken configuration and skips the checks that depend on it', async () => {
    const results = await runDiagnostics({ DISCORD_TOKEN: 'too short' }, dir);

    expect(find(results, 'Конфигурация')?.status).toBe('fail');
    expect(find(results, 'SQLite')?.status).toBe('skip');
    expect(find(results, 'FFmpeg')?.status).toBe('skip');
    // Checks that need no configuration still run.
    expect(find(results, 'Opus')?.status).toBe('ok');
  });

  it('never includes the token value in any result', async () => {
    const valid = await runDiagnostics(validEnv(dir), dir);
    const broken = await runDiagnostics(
      { ...validEnv(dir), DISCORD_TOKEN: `${TOKEN} with spaces` },
      dir,
    );

    expect(JSON.stringify(valid)).not.toContain(TOKEN);
    expect(JSON.stringify(broken)).not.toContain(TOKEN);
  });

  it('fails the music directory check when the directory is missing', async () => {
    const env = { ...validEnv(dir), MUSIC_DIR: join(dir, 'does-not-exist') };
    const results = await runDiagnostics(env, dir);

    expect(find(results, 'Каталог музыки')?.status).toBe('fail');
  });
});
