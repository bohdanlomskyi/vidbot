import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/database/db.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const TSX = path.join(
  ROOT,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
);
const WIZARD = path.join(ROOT, 'src', 'scripts', 'setup.ts');
const PRELOAD = path.join(ROOT, 'tests', 'helpers', 'fakeDiscordFetch.mjs');
// Shaped like a bot token, but not one: real tokens start with M or N.
const TOKEN = 'xTIzNDU2Nzg5MDEyMzQ1Njc4OQ.GaBc-e.wizardfixturetokenabcdefghijkl';

function runWizard(cwd: string, answers: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, ['--import', PRELOAD, WIZARD], {
      cwd,
      env: { ...process.env, FAKE_DISCORD_TOKEN: TOKEN },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', () => {
      resolve(output);
    });
    child.stdin.end(`${answers.join('\n')}\n`);
  });
}

describe.skipIf(process.platform === 'win32')('setup wizard', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'melody-setup-'));
    await copyFile(path.join(ROOT, '.env.example'), path.join(dir, '.env.example'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('fills .env from the token alone and never prints the token', async () => {
    // Do not open the portal, paste the token, keep YouTube off.
    const output = await runWizard(dir, ['н', TOKEN, 'н']);

    const env = parseEnv(await readFile(path.join(dir, '.env'), 'utf8'));
    expect(env).toMatchObject({
      DISCORD_TOKEN: TOKEN,
      DISCORD_CLIENT_ID: '123456789012345678',
      DISCORD_GUILD_ID: '234567890123456789',
      FFMPEG_PATH: 'ffmpeg',
      FFPROBE_PATH: 'ffprobe',
      YOUTUBE_PROVIDER_ENABLED: 'false',
    });
    expect(output).toContain('«Test Bot»');
    expect(output).toContain('«Home»');
    expect(output).toContain('Настройки сохранены');
    expect(output).not.toContain(TOKEN);
    await expect(
      readFile(path.join(dir, 'music', 'examples', 'test-tone.wav')),
    ).resolves.toBeTruthy();
  }, 120_000);

  it('keeps a valid saved token on a second run and enables YouTube on the chosen server', async () => {
    const fakeYtDlp = path.join(dir, 'fake-yt-dlp');
    await writeFile(fakeYtDlp, '#!/bin/sh\necho 2026.10.26\n');
    await chmod(fakeYtDlp, 0o755);
    await runWizard(dir, ['н', TOKEN, 'н']);
    const first = await readFile(path.join(dir, '.env'), 'utf8');
    await writeFile(
      path.join(dir, '.env'),
      first.replace('YTDLP_PATH=yt-dlp', `YTDLP_PATH=${fakeYtDlp}`),
    );

    // Keep the token, then say yes to YouTube.
    const output = await runWizard(dir, ['д', 'д']);

    const env = parseEnv(await readFile(path.join(dir, '.env'), 'utf8'));
    expect(output).toContain('Токен уже задан');
    expect(env).toMatchObject({ YOUTUBE_PROVIDER_ENABLED: 'true', YTDLP_PATH: fakeYtDlp });
    const db = openDatabase(path.join(dir, 'data', 'melody.sqlite'));
    const row = db
      .prepare('SELECT allowed_sources FROM guild_settings WHERE guild_id = ?')
      .get('234567890123456789') as { allowed_sources: string };
    db.close();
    expect(JSON.parse(row.allowed_sources)).toContain('youtube');
  }, 180_000);
});
