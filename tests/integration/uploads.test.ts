import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UploadService } from '../../src/audio/library/uploads.js';
import { probeAudioFile } from '../../src/audio/pipeline/probe.js';
import { createSineFixture } from '../helpers/ffmpeg.js';

const FFMPEG = process.env.MELODY_FFMPEG_PATH ?? 'ffmpeg';
const FFPROBE = process.env.MELODY_FFPROBE_PATH ?? 'ffprobe';
const URL = 'https://cdn.discordapp.com/attachments/1/2/song.wav?ex=abc';

function serve(body: Buffer): typeof fetch {
  return () => Promise.resolve(new Response(new Uint8Array(body)));
}

describe('UploadService', () => {
  let dir: string;
  let music: string;
  let tone: Buffer;
  let refreshed: number;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'melody-upload-'));
    music = path.join(dir, 'music');
    await mkdir(music, { recursive: true });
    const file = path.join(dir, 'tone.wav');
    await createSineFixture(FFMPEG, file, 1);
    tone = await readFile(file);
    refreshed = 0;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function service(
    body: Buffer,
    overrides: Partial<ConstructorParameters<typeof UploadService>[0]> = {},
  ): UploadService {
    return new UploadService({
      musicDir: music,
      maxBytes: 5_000_000,
      quotaBytes: 50_000_000,
      probe: (file) => probeAudioFile(FFPROBE, file, 20_000),
      refresh: () => {
        refreshed += 1;
        return Promise.resolve();
      },
      fetchImpl: serve(body),
      ...overrides,
    });
  }

  const signal = (): AbortSignal => new AbortController().signal;

  it('saves a valid audio file under uploads, checks it, and refreshes the library', async () => {
    const stored = await service(tone).ingest(
      { name: 'My Song.wav', size: tone.length, url: URL },
      signal(),
    );

    expect(stored.relativePath).toBe('uploads/My Song.wav');
    expect(stored.durationSec).toBeGreaterThan(0.5);
    expect(await readFile(path.join(music, 'uploads', 'My Song.wav'))).toEqual(tone);
    expect(refreshed).toBe(1);
  });

  it('does not download a file with an unsupported extension', async () => {
    let fetched = false;
    const spy = service(tone, {
      fetchImpl: () => {
        fetched = true;
        return Promise.resolve(new Response('x'));
      },
    });

    await expect(
      spy.ingest({ name: 'virus.exe', size: 10, url: URL }, signal()),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetched).toBe(false);
  });

  it('refuses addresses that are not Discord attachment hosts', async () => {
    await expect(
      service(tone).ingest(
        { name: 'song.wav', size: tone.length, url: 'https://evil.example/song.wav' },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      service(tone).ingest(
        { name: 'song.wav', size: tone.length, url: 'http://cdn.discordapp.com/song.wav' },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('refuses a file larger than the limit, by its declared size and by what really arrives', async () => {
    const small = service(tone, { maxBytes: 1_000 });

    await expect(
      small.ingest({ name: 'song.wav', size: tone.length, url: URL }, signal()),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // The declared size is a claim; the bytes that arrive decide.
    await expect(
      small.ingest({ name: 'song.wav', size: 10, url: URL }, signal()),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await readdir(path.join(music, 'uploads')).catch(() => [])).toEqual([]);
  });

  it('refuses a file that is not audio even with an audio extension, and leaves nothing behind', async () => {
    const junk = Buffer.from('this is plainly not an mp3 file '.repeat(100));

    await expect(
      service(junk).ingest({ name: 'fake.mp3', size: junk.length, url: URL }, signal()),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    expect(await readdir(path.join(music, 'uploads'))).toEqual([]);
    expect(refreshed).toBe(0);
  });

  it('keeps one copy when the same file is uploaded twice', async () => {
    const first = await service(tone).ingest(
      { name: 'song.wav', size: tone.length, url: URL },
      signal(),
    );
    const second = await service(tone).ingest(
      { name: 'song.wav', size: tone.length, url: URL },
      signal(),
    );

    expect(second.relativePath).toBe(first.relativePath);
    expect(await readdir(path.join(music, 'uploads'))).toHaveLength(1);
  });

  it('gives a different file with the same name its own name', async () => {
    const other = Buffer.concat([tone, Buffer.alloc(0)]);
    await service(tone).ingest({ name: 'song.wav', size: tone.length, url: URL }, signal());
    const changed = Buffer.from(other);
    changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 0xff;

    const stored = await service(changed).ingest(
      { name: 'song.wav', size: changed.length, url: URL },
      signal(),
    );

    expect(stored.relativePath).toBe('uploads/song (2).wav');
  });

  it('cannot be tricked into writing outside the uploads folder', async () => {
    const stored = await service(tone).ingest(
      { name: '../../..\\evil/../name.wav', size: tone.length, url: URL },
      signal(),
    );

    expect(stored.relativePath.startsWith('uploads/')).toBe(true);
    expect(stored.relativePath.slice('uploads/'.length)).not.toMatch(/[\\/]/u);
    expect(await readdir(dir)).not.toContain('evil');
  });

  it('refuses a new file when the storage quota would be exceeded', async () => {
    await mkdir(path.join(music, 'uploads'), { recursive: true });
    await writeFile(path.join(music, 'uploads', 'old.wav'), Buffer.alloc(900));

    await expect(
      service(tone, { quotaBytes: 1_000 }).ingest(
        { name: 'song.wav', size: tone.length, url: URL },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });
});
