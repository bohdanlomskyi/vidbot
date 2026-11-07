import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { formatEnvValue, liftOldLimits, updateEnvText } from '../../../src/setup/envFile.js';

const EXAMPLE = [
  '# Токен бота',
  'DISCORD_TOKEN=',
  'DISCORD_CLIENT_ID=',
  '',
  '# FFmpeg',
  'FFMPEG_PATH=ffmpeg',
  '# YOUTUBE_PROVIDER_ENABLED=true',
  'YOUTUBE_PROVIDER_ENABLED=false',
  '',
].join('\n');

describe('updateEnvText', () => {
  it('fills existing keys in place and keeps comments, order and other values', () => {
    const updated = updateEnvText(EXAMPLE, {
      DISCORD_TOKEN: 'abc.def.ghi',
      YOUTUBE_PROVIDER_ENABLED: 'true',
    });

    expect(updated.split('\n')).toEqual([
      '# Токен бота',
      'DISCORD_TOKEN=abc.def.ghi',
      'DISCORD_CLIENT_ID=',
      '',
      '# FFmpeg',
      'FFMPEG_PATH=ffmpeg',
      '# YOUTUBE_PROVIDER_ENABLED=true',
      'YOUTUBE_PROVIDER_ENABLED=true',
      '',
    ]);
  });

  it('appends keys the file does not have yet', () => {
    const updated = updateEnvText('A=1\n', { YTDLP_PATH: '/opt/yt-dlp' });

    expect(parseEnv(updated)).toEqual({ A: '1', YTDLP_PATH: '/opt/yt-dlp' });
  });

  it('writes Windows paths with spaces and backslashes so Node reads them back unchanged', () => {
    const path = String.raw`C:\Users\John Doe\new folder\Melody\.tools\ffmpeg\bin\ffmpeg.exe`;

    const updated = updateEnvText(EXAMPLE, { FFMPEG_PATH: path });

    expect(parseEnv(updated).FFMPEG_PATH).toBe(path);
  });

  it('handles Windows line endings', () => {
    const updated = updateEnvText('DISCORD_TOKEN=\r\nB=2\r\n', { DISCORD_TOKEN: 'x' });

    expect(updated).toBe('DISCORD_TOKEN=x\r\nB=2\r\n');
  });
});

describe('formatEnvValue', () => {
  it('leaves plain values bare and quotes the rest', () => {
    expect(formatEnvValue('123456789012345678')).toBe('123456789012345678');
    expect(formatEnvValue('a b')).toBe("'a b'");
    expect(formatEnvValue('a#b')).toBe("'a#b'");
    expect(formatEnvValue(String.raw`C:\tools\new`)).toBe(String.raw`'C:\tools\new'`);
  });

  it('refuses a value that would break the file', () => {
    expect(() => formatEnvValue('line\nbreak')).toThrow(RangeError);
  });
});

describe('liftOldLimits', () => {
  const old = [
    '# Максимальная длительность одного трека в секундах (60–21600).',
    'MAX_TRACK_DURATION_SEC=1800',
    'YOUTUBE_MAX_DURATION_SEC=900',
    'UPLOAD_MAX_MB=25',
    'UPLOAD_QUOTA_MB=2000',
    'STREAM_MAX_BYTES=536870912',
    'DISCORD_TOKEN=keep-me',
    '',
  ].join('\r\n');

  it('replaces the limits that still have their old shipped values, and keeps everything else', () => {
    const { text, changed } = liftOldLimits(old);

    expect(changed).toEqual([
      'MAX_TRACK_DURATION_SEC',
      'YOUTUBE_MAX_DURATION_SEC',
      'UPLOAD_MAX_MB',
      'UPLOAD_QUOTA_MB',
      'STREAM_MAX_BYTES',
    ]);
    expect(text.split('\r\n')).toEqual([
      '# Максимальная длительность одного трека в секундах: 0 — без ограничения, иначе от 60.',
      'MAX_TRACK_DURATION_SEC=0',
      'YOUTUBE_MAX_DURATION_SEC=0',
      'UPLOAD_MAX_MB=500',
      'UPLOAD_QUOTA_MB=20000',
      'STREAM_MAX_BYTES=4294967296',
      'DISCORD_TOKEN=keep-me',
      '',
    ]);
  });

  it('leaves a value the owner chose, and changes nothing a second time', () => {
    const chosen = 'MAX_TRACK_DURATION_SEC=3600\nYOUTUBE_MAX_DURATION_SEC=900\n';

    const once = liftOldLimits(chosen);
    const twice = liftOldLimits(once.text);

    expect(once.text).toBe('MAX_TRACK_DURATION_SEC=3600\nYOUTUBE_MAX_DURATION_SEC=0\n');
    expect(twice.changed).toEqual([]);
    expect(twice.text).toBe(once.text);
  });
});
