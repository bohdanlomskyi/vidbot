import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { downloadVerified, parseChecksums, ytDlpAsset } from '../../../src/setup/downloads.js';

const PAYLOAD = Buffer.from('pretend this is ffmpeg.exe');
const PAYLOAD_SHA = createHash('sha256').update(PAYLOAD).digest('hex');

function serve(body: Buffer): typeof fetch {
  return () => Promise.resolve(new Response(new Uint8Array(body)));
}

describe('parseChecksums', () => {
  it('reads sha256sum listings, including binary-mode markers', () => {
    const sums = parseChecksums(
      `${'a'.repeat(64)}  yt-dlp.exe\n${'B'.repeat(64)} *yt-dlp_linux\nnot a line\n`,
    );

    expect(sums.get('yt-dlp.exe')).toBe('a'.repeat(64));
    expect(sums.get('yt-dlp_linux')).toBe('b'.repeat(64));
  });

  it('reads a file that holds only the hash', () => {
    expect(parseChecksums(`${'c'.repeat(64)}\n`).get('')).toBe('c'.repeat(64));
  });
});

describe('ytDlpAsset', () => {
  it('picks the standalone build for each platform', () => {
    expect(ytDlpAsset('win32', 'x64')).toBe('yt-dlp.exe');
    expect(ytDlpAsset('linux', 'x64')).toBe('yt-dlp_linux');
    expect(ytDlpAsset('linux', 'arm64')).toBe('yt-dlp_linux_aarch64');
    expect(ytDlpAsset('darwin', 'arm64')).toBe('yt-dlp_macos');
  });
});

describe('downloadVerified', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'melody-download-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('saves the file when its SHA-256 matches', async () => {
    const target = path.join(dir, 'tool.exe');

    await downloadVerified(
      { url: 'https://example.test/tool', sha256: PAYLOAD_SHA, target },
      serve(PAYLOAD),
    );

    expect(await readFile(target)).toEqual(PAYLOAD);
  });

  it('refuses and leaves nothing behind when the checksum does not match', async () => {
    const target = path.join(dir, 'tool.exe');

    await expect(
      downloadVerified(
        { url: 'https://example.test/tool', sha256: 'f'.repeat(64), target },
        serve(PAYLOAD),
      ),
    ).rejects.toThrow(/контрольн/u);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(`${target}.part`)).toBe(false);
  });
});
