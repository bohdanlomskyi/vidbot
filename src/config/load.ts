import { isValidLengthLimit, MAX_LENGTH_LIMIT_SEC } from '../music/lengthLimit.js';
import path from 'node:path';
import { z } from 'zod';
import type { LogLevel } from '../utils/logger.js';

// Operator-facing validation messages are written in Russian like the rest of the product.
z.config(z.locales.ru());

export interface AppConfig {
  readonly botName: string;
  readonly discord: {
    readonly token: string;
    readonly clientId: string;
    readonly guildId: string | null;
  };
  readonly logLevel: LogLevel;
  readonly paths: {
    readonly databaseFile: string;
    readonly dataDir: string;
    readonly musicDir: string;
    readonly streamCatalogFile: string;
    readonly healthFile: string;
  };
  readonly library: {
    readonly rescanMinutes: number;
  };
  readonly ffmpeg: {
    readonly ffmpegPath: string;
    readonly ffprobePath: string;
  };
  readonly playback: {
    readonly maxQueueSize: number;
    readonly maxTrackSec: number;
    readonly defaultVolume: number;
    readonly idleTimeoutSec: number;
    readonly emptyChannelTimeoutSec: number;
  };
  readonly rateLimit: {
    readonly perUserPer10s: number;
  };
  /** Audio files that members attach to /play. They are kept in the library's uploads folder. */
  readonly uploads: {
    readonly enabled: boolean;
    readonly maxBytes: number;
    readonly quotaBytes: number;
  };
  readonly streams: {
    readonly enabled: boolean;
    readonly maxBytes: number;
  };
  readonly youtube: {
    readonly enabled: boolean;
    readonly ytdlpPath: string;
    readonly jsRuntime: 'node' | 'deno';
    readonly maxDurationSec: number;
    readonly playlistMaxItems: number;
    readonly maxConcurrency: number;
    readonly timeoutSec: number;
  };
}

/** Operator-facing configuration failure. It names the variables but never echoes their values. */
export class ConfigError extends Error {
  constructor(details: string) {
    super(`Некорректная конфигурация: ${details}`);
    this.name = 'ConfigError';
  }
}

// Every optional setting has a default here. Empty values count as unset.
const DEFAULTS: Readonly<Record<string, string>> = {
  BOT_NAME: 'Melody',
  LOG_LEVEL: 'info',
  DATABASE_PATH: 'data/melody.sqlite',
  MUSIC_DIR: 'music',
  MUSIC_RESCAN_MINUTES: '60',
  FFMPEG_PATH: 'ffmpeg',
  FFPROBE_PATH: 'ffprobe',
  MAX_QUEUE_SIZE: '100',
  MAX_TRACK_DURATION_SEC: '0',
  DEFAULT_VOLUME: '70',
  IDLE_TIMEOUT_SEC: '300',
  EMPTY_CHANNEL_TIMEOUT_SEC: '60',
  RATE_LIMIT_PER_10S: '6',
  UPLOADS_ENABLED: 'true',
  UPLOAD_MAX_MB: '500',
  UPLOAD_QUOTA_MB: '20000',
  STREAM_PROVIDER_ENABLED: 'false',
  STREAM_CATALOG_FILE: 'config/streams.json',
  STREAM_MAX_BYTES: '4294967296',
  YOUTUBE_PROVIDER_ENABLED: 'false',
  YTDLP_PATH: 'yt-dlp',
  YTDLP_JS_RUNTIME: 'node',
  YOUTUBE_MAX_DURATION_SEC: '0',
  YOUTUBE_PLAYLIST_MAX_ITEMS: '25',
  YOUTUBE_MAX_CONCURRENCY: '2',
  YOUTUBE_TIMEOUT_SEC: '30',
  HEALTH_FILE: 'data/health.json',
};

const snowflake = z.string().regex(/^\d{17,20}$/, 'должен быть числовым ID Discord (17–20 цифр)');

function integerIn(min: number, max: number) {
  return z
    .string()
    .regex(/^\d+$/, 'должно быть целым неотрицательным числом')
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));
}

/** 0 means no limit; otherwise from one minute to a week. */
const lengthLimit = integerIn(0, MAX_LENGTH_LIMIT_SEC).refine(isValidLengthLimit, {
  message: '0 (без ограничения) или от 60 секунд',
});

const flag = z
  .enum(['true', 'false', '1', '0'], { error: 'допустимы только значения true, false, 1 или 0' })
  .transform((value) => value === 'true' || value === '1');

const envSchema = z.object({
  BOT_NAME: z.string().trim().min(1).max(32),
  DISCORD_TOKEN: z
    .string()
    .min(30, 'токен не короче 30 символов')
    .regex(/^\S+$/, 'токен не должен содержать пробелов'),
  DISCORD_CLIENT_ID: snowflake,
  DISCORD_GUILD_ID: snowflake.optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
  DATABASE_PATH: z.string().min(1),
  MUSIC_DIR: z.string().min(1),
  MUSIC_RESCAN_MINUTES: integerIn(0, 1440),
  FFMPEG_PATH: z.string().min(1),
  FFPROBE_PATH: z.string().min(1),
  MAX_QUEUE_SIZE: integerIn(1, 500),
  MAX_TRACK_DURATION_SEC: lengthLimit,
  DEFAULT_VOLUME: integerIn(0, 100),
  IDLE_TIMEOUT_SEC: integerIn(10, 3_600),
  EMPTY_CHANNEL_TIMEOUT_SEC: integerIn(10, 600),
  RATE_LIMIT_PER_10S: integerIn(1, 60),
  UPLOADS_ENABLED: flag,
  UPLOAD_MAX_MB: integerIn(1, 500),
  UPLOAD_QUOTA_MB: integerIn(10, 100_000),
  STREAM_PROVIDER_ENABLED: flag,
  STREAM_CATALOG_FILE: z.string().min(1),
  STREAM_MAX_BYTES: integerIn(1_048_576, 4_294_967_296),
  YOUTUBE_PROVIDER_ENABLED: flag,
  YTDLP_PATH: z.string().min(1),
  YTDLP_JS_RUNTIME: z.enum(['node', 'deno']),
  YOUTUBE_MAX_DURATION_SEC: lengthLimit,
  YOUTUBE_PLAYLIST_MAX_ITEMS: integerIn(0, 100),
  YOUTUBE_MAX_CONCURRENCY: integerIn(1, 4),
  YOUTUBE_TIMEOUT_SEC: integerIn(5, 120),
  HEALTH_FILE: z.string().min(1),
});

/**
 * Builds the typed application configuration from environment variables.
 * Relative paths are resolved against `cwd`. Invalid input throws ConfigError.
 */
export function loadConfig(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): AppConfig {
  const merged: Record<string, string> = { ...DEFAULTS };
  for (const [key, value] of Object.entries(env)) {
    const trimmed = value?.trim();
    if (trimmed !== undefined && trimmed !== '') {
      merged[key] = trimmed;
    }
  }

  const parsed = envSchema.safeParse(merged);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(details);
  }

  const data = parsed.data;
  const databaseFile = path.resolve(cwd, data.DATABASE_PATH);

  return {
    botName: data.BOT_NAME,
    discord: {
      token: data.DISCORD_TOKEN,
      clientId: data.DISCORD_CLIENT_ID,
      guildId: data.DISCORD_GUILD_ID ?? null,
    },
    logLevel: data.LOG_LEVEL,
    paths: {
      databaseFile,
      dataDir: path.dirname(databaseFile),
      musicDir: path.resolve(cwd, data.MUSIC_DIR),
      streamCatalogFile: path.resolve(cwd, data.STREAM_CATALOG_FILE),
      healthFile: path.resolve(cwd, data.HEALTH_FILE),
    },
    library: {
      rescanMinutes: data.MUSIC_RESCAN_MINUTES,
    },
    ffmpeg: {
      ffmpegPath: data.FFMPEG_PATH,
      ffprobePath: data.FFPROBE_PATH,
    },
    playback: {
      maxQueueSize: data.MAX_QUEUE_SIZE,
      maxTrackSec: data.MAX_TRACK_DURATION_SEC,
      defaultVolume: data.DEFAULT_VOLUME,
      idleTimeoutSec: data.IDLE_TIMEOUT_SEC,
      emptyChannelTimeoutSec: data.EMPTY_CHANNEL_TIMEOUT_SEC,
    },
    rateLimit: {
      perUserPer10s: data.RATE_LIMIT_PER_10S,
    },
    uploads: {
      enabled: data.UPLOADS_ENABLED,
      maxBytes: data.UPLOAD_MAX_MB * 1_048_576,
      quotaBytes: data.UPLOAD_QUOTA_MB * 1_048_576,
    },
    streams: {
      enabled: data.STREAM_PROVIDER_ENABLED,
      maxBytes: data.STREAM_MAX_BYTES,
    },
    youtube: {
      enabled: data.YOUTUBE_PROVIDER_ENABLED,
      ytdlpPath: data.YTDLP_PATH,
      jsRuntime: data.YTDLP_JS_RUNTIME,
      maxDurationSec: data.YOUTUBE_MAX_DURATION_SEC,
      playlistMaxItems: data.YOUTUBE_PLAYLIST_MAX_ITEMS,
      maxConcurrency: data.YOUTUBE_MAX_CONCURRENCY,
      timeoutSec: data.YOUTUBE_TIMEOUT_SEC,
    },
  };
}
