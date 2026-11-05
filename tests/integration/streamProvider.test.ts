import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseStreamCatalog } from '../../src/audio/providers/streamCatalog.js';
import { AuthorizedStreamProvider } from '../../src/audio/providers/streamProvider.js';
import type { AddressGuard } from '../../src/audio/providers/streamFetcher.js';
import type { Track } from '../../src/music/models/track.js';
import { countBytes, createSineFixture } from '../helpers/ffmpeg.js';

const FFMPEG = process.env.MELODY_FFMPEG_PATH ?? 'ffmpeg';
const BYTES_PER_SECOND = 48_000 * 2 * 2;

// The test server listens on loopback, which the production guard must refuse. Tests
// inject this guard so requests reach the local server. URL policy and redirect checks
// still run in full.
const LOOPBACK_GUARD: AddressGuard = () => ({ ok: true, address: '127.0.0.1', family: 4 });

interface EntrySpec {
  readonly id: string;
  /** Server path the catalog entry points at. */
  readonly path: string;
  readonly live: boolean;
  readonly durationSec?: number;
}

describe('AuthorizedStreamProvider against a local HTTP server', () => {
  let dir: string;
  let server: Server;
  let port: number;
  let toneBytes: Buffer;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'melody-stream-'));
    const toneFile = path.join(dir, 'tone.wav');
    await createSineFixture(FFMPEG, toneFile, 2);
    toneBytes = await readFile(toneFile);

    server = createServer((request, response) => {
      switch (request.url) {
        case '/tone.wav':
          response.writeHead(200, { 'content-type': 'audio/wav' });
          response.end(toneBytes);
          return;
        case '/page':
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end('<html></html>');
          return;
        case '/redirect-private':
          response.writeHead(302, { location: 'https://169.254.169.254/latest/meta-data/' });
          response.end();
          return;
        case '/redirect-local':
          response.writeHead(302, { location: `http://localhost:${String(port)}/tone.wav` });
          response.end();
          return;
        case '/big':
          // A valid WAV, so decoding would succeed if the byte cap were missing.
          response.writeHead(200, { 'content-type': 'audio/wav' });
          response.end(toneBytes);
          return;
        case '/stall':
        case '/cancel':
          // Sends a little audio, then keeps the connection open without finishing.
          response.writeHead(200, { 'content-type': 'audio/wav' });
          response.write(toneBytes.subarray(0, 1024));
          return;
        case '/never':
          return;
        default:
          response.writeHead(404);
          response.end();
      }
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    await rm(dir, { recursive: true, force: true });
  });

  function providerFor(
    spec: EntrySpec,
    options: { maxBytes?: number; responseMs?: number; idleMs?: number } = {},
  ): AuthorizedStreamProvider {
    const parsed = parseStreamCatalog({
      streams: [
        {
          id: spec.id,
          title: spec.id,
          url: `http://localhost:${String(port)}${spec.path}`,
          allowHttp: true,
          allowedPorts: [port],
          live: spec.live,
          durationSec: spec.durationSec,
        },
      ],
    });
    expect(parsed.problems).toEqual([]);

    return new AuthorizedStreamProvider({
      entries: parsed.entries,
      enabled: true,
      ffmpegPath: FFMPEG,
      maxBytes: options.maxBytes ?? 5 * 1024 * 1024,
      timeouts: { responseMs: options.responseMs ?? 1_000, idleMs: options.idleMs ?? 2_000 },
      addressGuard: LOOPBACK_GUARD,
    });
  }

  function asTrack(sourceRef: string): Track {
    return {
      id: 'queue-entry-1',
      source: 'stream',
      sourceRef,
      title: sourceRef,
      artist: null,
      durationSec: null,
      thumbnailUrl: null,
      originalUrl: null,
      requesterId: 'user-1',
      createdAt: 0,
      metadata: {},
    };
  }

  it('plays an allowlisted stream by catalog identifier and decodes it to PCM', async () => {
    const provider = providerFor({ id: 'tone', path: '/tone.wav', live: false, durationSec: 2 });
    const signal = new AbortController().signal;

    const [draft] = await provider.resolve('tone', { signal });
    expect(draft?.source).toBe('stream');

    const playable = await provider.getPlayableStream(asTrack('tone'), signal);
    const bytes = await countBytes(playable.stream);

    expect(await playable.ended).toEqual({ status: 'completed' });
    expect(Math.abs(bytes - 2 * BYTES_PER_SECOND)).toBeLessThan(BYTES_PER_SECOND / 100);
  });

  it('refuses a page that is not audio', async () => {
    const provider = providerFor({ id: 'page', path: '/page', live: true });

    await expect(
      provider.getPlayableStream(asTrack('page'), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  });

  it('does not follow a redirect into the metadata address', async () => {
    const provider = providerFor({ id: 'redirect-private', path: '/redirect-private', live: true });

    await expect(
      provider.getPlayableStream(asTrack('redirect-private'), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'SOURCE_RESTRICTED' });
  });

  it('follows a redirect to another host that the policy allows', async () => {
    const provider = providerFor({ id: 'redirect-local', path: '/redirect-local', live: true });
    const playable = await provider.getPlayableStream(
      asTrack('redirect-local'),
      new AbortController().signal,
    );
    const bytes = await countBytes(playable.stream);

    expect(bytes).toBeGreaterThan(BYTES_PER_SECOND / 2);
    expect(await playable.ended).toEqual({ status: 'completed' });
  });

  it('fails the playback when a finite stream exceeds the byte limit', async () => {
    const provider = providerFor(
      { id: 'big', path: '/big', live: false, durationSec: 1 },
      { maxBytes: 1_000 },
    );
    const playable = await provider.getPlayableStream(asTrack('big'), new AbortController().signal);
    await countBytes(playable.stream);

    expect(await playable.ended).toEqual({
      status: 'failed',
      message: 'Поток превысил допустимый размер.',
    });
  });

  it('times out when the server never answers', async () => {
    const provider = providerFor({ id: 'never', path: '/never', live: true }, { responseMs: 300 });

    await expect(
      provider.getPlayableStream(asTrack('never'), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('ends the playback with a failure when the stream stalls mid-way', async () => {
    const provider = providerFor({ id: 'stall', path: '/stall', live: true }, { idleMs: 300 });
    const playable = await provider.getPlayableStream(
      asTrack('stall'),
      new AbortController().signal,
    );

    expect((await playable.ended).status).toBe('failed');
  });

  it('stops the stream and reports a stop when playback is cancelled', async () => {
    const provider = providerFor({ id: 'cancel', path: '/cancel', live: true }, { idleMs: 60_000 });
    const controller = new AbortController();
    const playable = await provider.getPlayableStream(asTrack('cancel'), controller.signal);

    controller.abort();

    expect(await playable.ended).toEqual({ status: 'stopped' });
  });
});
