import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { parseStreamCatalog } from '../../src/audio/providers/streamCatalog.js';
import { loadConfig } from '../../src/config/load.js';

const ROOT = join(import.meta.dirname, '..', '..');

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

/** Parses KEY=value lines, skipping comments and blank lines. */
function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const separator = trimmed.indexOf('=');
    values[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  return values;
}

/** Every setting the loader understands. The example file must document exactly these. */
const SETTINGS = [
  'DISCORD_TOKEN',
  'DISCORD_CLIENT_ID',
  'DISCORD_GUILD_ID',
  'BOT_NAME',
  'LOG_LEVEL',
  'DATABASE_PATH',
  'HEALTH_FILE',
  'MUSIC_DIR',
  'MUSIC_RESCAN_MINUTES',
  'FFMPEG_PATH',
  'FFPROBE_PATH',
  'MAX_QUEUE_SIZE',
  'MAX_TRACK_DURATION_SEC',
  'DEFAULT_VOLUME',
  'IDLE_TIMEOUT_SEC',
  'EMPTY_CHANNEL_TIMEOUT_SEC',
  'RATE_LIMIT_PER_10S',
  'STREAM_PROVIDER_ENABLED',
  'STREAM_CATALOG_FILE',
  'STREAM_MAX_BYTES',
  'YOUTUBE_PROVIDER_ENABLED',
  'YTDLP_PATH',
  'YTDLP_JS_RUNTIME',
  'YOUTUBE_MAX_DURATION_SEC',
  'YOUTUBE_PLAYLIST_MAX_ITEMS',
  'YOUTUBE_MAX_CONCURRENCY',
  'YOUTUBE_TIMEOUT_SEC',
];

describe('.env.example', () => {
  const example = parseEnvFile(read('.env.example'));

  it('documents exactly the settings the loader understands', () => {
    expect(Object.keys(example).sort()).toEqual([...SETTINGS].sort());
  });

  it('loads as a valid configuration once the two required identifiers are filled in', () => {
    const config = loadConfig(
      { ...example, DISCORD_TOKEN: 'a'.repeat(40), DISCORD_CLIENT_ID: '123456789012345678' },
      ROOT,
    );

    expect(config.streams.enabled).toBe(false);
    expect(config.youtube.enabled).toBe(false);
  });

  it('ships the optional providers disabled', () => {
    expect(example.STREAM_PROVIDER_ENABLED).toBe('false');
    expect(example.YOUTUBE_PROVIDER_ENABLED).toBe('false');
  });

  it('leaves the secrets empty', () => {
    expect(example.DISCORD_TOKEN).toBe('');
  });
});

describe('config/streams.example.json', () => {
  it('passes the same validation the bot applies to the operator catalog', () => {
    const parsed = parseStreamCatalog(JSON.parse(read('config/streams.example.json')) as unknown);

    expect(parsed.problems).toEqual([]);
    expect(parsed.entries.map((entry) => entry.id)).toEqual(['example-stream']);
  });
});

interface ComposeService {
  readonly restart?: string;
  readonly init?: boolean;
  readonly read_only?: boolean;
  readonly cap_drop?: readonly string[];
  readonly security_opt?: readonly string[];
  readonly ports?: unknown;
  readonly privileged?: boolean;
  readonly environment?: Readonly<Record<string, string>>;
  readonly volumes?: readonly string[];
  readonly env_file?: readonly (string | { readonly path: string; readonly required?: boolean })[];
  readonly healthcheck?: { readonly test: readonly string[] };
}

interface ComposeFile {
  readonly services: Readonly<Record<string, ComposeService>>;
  readonly volumes?: Readonly<Record<string, unknown>>;
}

describe('compose.yaml', () => {
  const compose = parse(read('compose.yaml')) as ComposeFile;
  const bot = compose.services.bot;

  it('defines one bot service that restarts unless stopped and reaps child processes', () => {
    expect(bot).toBeDefined();
    expect(bot?.restart).toBe('unless-stopped');
    expect(bot?.init).toBe(true);
  });

  it('hardens the container: read-only root filesystem, no capabilities, no new privileges', () => {
    expect(bot?.read_only).toBe(true);
    expect(bot?.cap_drop).toEqual(['ALL']);
    expect(bot?.security_opt).toContain('no-new-privileges:true');
    expect(bot?.privileged).toBeUndefined();
  });

  it('publishes no ports, because the bot only makes outbound connections', () => {
    expect(bot?.ports).toBeUndefined();
  });

  it('keeps the Discord token out of the file, so it comes from .env at run time', () => {
    expect(Object.keys(bot?.environment ?? {})).not.toContain('DISCORD_TOKEN');
    expect(bot?.env_file).toEqual([{ path: '.env', required: false }]);
  });

  it('mounts music and the stream catalog read-only and keeps data in a named volume', () => {
    const volumes = bot?.volumes ?? [];
    expect(volumes).toContain('./music:/app/music:ro');
    expect(volumes).toContain('./config:/app/config:ro');
    expect(volumes).toContain('melody-data:/app/data');
    expect(compose.volumes).toHaveProperty('melody-data');
  });

  it('checks health with the same script the Dockerfile uses', () => {
    expect(bot?.healthcheck?.test).toEqual(['CMD', 'node', 'dist/scripts/healthcheck.js']);
  });
});

describe('Dockerfile', () => {
  const dockerfile = read('Dockerfile');

  it('pins the Node.js base image to an exact version', () => {
    expect(dockerfile).toMatch(/^ARG NODE_IMAGE=node:\d+\.\d+\.\d+-[a-z0-9.-]+$/mu);
  });

  it('runs as the unprivileged node user', () => {
    expect(dockerfile).toMatch(/^USER node$/mu);
  });

  it('never receives or bakes in the Discord token', () => {
    expect(dockerfile).not.toMatch(/DISCORD_TOKEN/u);
  });

  it('installs FFmpeg and defines a health check', () => {
    expect(dockerfile).toMatch(/apt-get install[^\n]*ffmpeg/u);
    expect(dockerfile).toMatch(/^HEALTHCHECK /mu);
  });

  it('requires a checksum whenever an optional yt-dlp version is requested', () => {
    expect(dockerfile).toMatch(/YTDLP_SHA256 is required when YTDLP_VERSION is set/u);
    expect(dockerfile).toMatch(/sha256sum -c -/u);
  });
});

describe('.dockerignore', () => {
  const lines = read('.dockerignore')
    .split(/\r?\n/u)
    .map((line) => line.trim());

  it('keeps secrets, dependencies and local data out of the build context', () => {
    for (const pattern of ['.env', '.env.*', 'node_modules', 'data', 'music']) {
      expect(lines).toContain(pattern);
    }
  });
});
