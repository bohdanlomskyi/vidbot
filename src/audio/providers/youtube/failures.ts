import { type AppErrorCode, AppError } from '../../../utils/errors.js';

export interface ClassifiedFailure {
  readonly error: AppError;
  /**
   * True when the failure points at the service or at the bot rather than at one video.
   * Only systemic failures count toward the circuit breaker, so one private video can
   * never switch YouTube off for everyone.
   */
  readonly systemic: boolean;
}

interface Rule {
  readonly pattern: RegExp;
  readonly code: AppErrorCode;
  readonly message: string;
  readonly systemic: boolean;
}

// Order matters: the first matching rule wins. Messages never include raw yt-dlp output.
const RULES: readonly Rule[] = [
  {
    pattern: /private video/i,
    code: 'SOURCE_UNAVAILABLE',
    message: 'Видео приватное, бот не может его получить.',
    systemic: false,
  },
  {
    pattern: /video unavailable|has been removed|removed by the uploader|no longer available/i,
    code: 'SOURCE_UNAVAILABLE',
    message: 'Видео недоступно или удалено.',
    systemic: false,
  },
  {
    pattern: /sign in to confirm your age|age[- ]restricted/i,
    code: 'SOURCE_RESTRICTED',
    message: 'Видео с возрастным ограничением не поддерживается: для него нужен вход в аккаунт.',
    systemic: false,
  },
  {
    pattern: /not a bot/i,
    code: 'SOURCE_RESTRICTED',
    message: 'YouTube запросил подтверждение, что вы не бот. Воспроизведение временно недоступно.',
    systemic: true,
  },
  {
    pattern: /music premium|premium members|members[- ]only|join this channel/i,
    code: 'SOURCE_RESTRICTED',
    message: 'Видео доступно только по подписке или участникам канала.',
    systemic: false,
  },
  {
    pattern: /available in your country|blocked it in your country|geo[- ]?restricted/i,
    code: 'SOURCE_RESTRICTED',
    message: 'Видео недоступно в регионе, где работает сервер.',
    systemic: false,
  },
  {
    pattern: /requested format is not available|no video formats found/i,
    code: 'SOURCE_UNAVAILABLE',
    message: 'Для видео не найден подходящий аудиопоток.',
    systemic: false,
  },
  {
    pattern: /http error 429|too many requests/i,
    code: 'SOURCE_UNAVAILABLE',
    message: 'YouTube временно ограничил запросы. Попробуйте позже.',
    systemic: true,
  },
  {
    pattern: /unable to extract|nsig|signature extraction|challenge solver|javascript runtime/i,
    code: 'SOURCE_UNAVAILABLE',
    message:
      'Не удалось обработать ответ YouTube. Возможно, нужна новая версия yt-dlp или JavaScript-рантайм.',
    systemic: true,
  },
  {
    pattern: /timed out|timeout/i,
    code: 'SOURCE_UNAVAILABLE',
    message: 'YouTube не ответил вовремя.',
    systemic: true,
  },
];

const FALLBACK: Rule = {
  pattern: /./,
  code: 'SOURCE_UNAVAILABLE',
  message: 'Не удалось получить аудио из YouTube.',
  systemic: true,
};

export function classifyYtDlpFailure(stderr: string): ClassifiedFailure {
  const rule = RULES.find((candidate) => candidate.pattern.test(stderr)) ?? FALLBACK;
  return {
    error: new AppError(rule.code, rule.message, { retryable: rule.systemic }),
    systemic: rule.systemic,
  };
}

export interface VideoMetadata {
  readonly title: string;
  readonly artist: string | null;
  readonly durationSec: number;
  readonly thumbnailUrl: string | null;
}

const LIVE_STATES = new Set(['is_live', 'is_upcoming', 'post_live']);
const RESTRICTED_AVAILABILITY = new Set(['needs_auth', 'subscriber_only', 'premium_only']);

/** Validates yt-dlp's metadata output and rejects anything the bot cannot play safely. */
export function parseVideoMetadata(
  json: string,
  options: { maxDurationSec: number },
): VideoMetadata {
  const data = parseObject(json);

  if (data.is_live === true || LIVE_STATES.has(String(data.live_status))) {
    throw new AppError('SOURCE_UNAVAILABLE', 'Прямые трансляции не поддерживаются.');
  }
  if (RESTRICTED_AVAILABILITY.has(String(data.availability))) {
    throw new AppError(
      'SOURCE_RESTRICTED',
      'Видео доступно только после входа в аккаунт или по подписке.',
    );
  }

  const duration =
    typeof data.duration === 'number' && Number.isFinite(data.duration) ? data.duration : null;
  if (duration === null || duration <= 0) {
    throw new AppError('SOURCE_UNAVAILABLE', 'Не удалось определить длительность видео.');
  }
  if (duration > options.maxDurationSec) {
    const maxMinutes = Math.floor(options.maxDurationSec / 60);
    throw new AppError(
      'TRACK_TOO_LONG',
      `Видео слишком длинное. Максимальная длительность: ${String(maxMinutes)} мин.`,
    );
  }

  const thumbnail =
    typeof data.thumbnail === 'string' && data.thumbnail.startsWith('https://')
      ? data.thumbnail
      : null;
  return {
    title: nonEmpty(data.title) ?? 'Видео YouTube',
    artist: nonEmpty(data.uploader) ?? nonEmpty(data.channel),
    durationSec: duration,
    thumbnailUrl: thumbnail,
  };
}

export interface PlaylistEntry {
  readonly id: string;
  readonly title: string;
  readonly durationSec: number | null;
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** Reads a flat playlist listing. Entries without a valid video identifier are skipped. */
export function parsePlaylistEntries(json: string, limit: number): PlaylistEntry[] {
  const data = parseObject(json);
  const entries: unknown[] = Array.isArray(data.entries) ? (data.entries as unknown[]) : [];

  const result: PlaylistEntry[] = [];
  for (const item of entries) {
    if (result.length >= limit) {
      break;
    }
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== 'string' || !VIDEO_ID.test(entry.id)) {
      continue;
    }
    result.push({
      id: entry.id,
      title: nonEmpty(entry.title) ?? 'Видео YouTube',
      durationSec: typeof entry.duration === 'number' ? entry.duration : null,
    });
  }
  return result;
}

function parseObject(json: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new AppError('SOURCE_UNAVAILABLE', 'Не удалось прочитать ответ YouTube.', {
      cause: error,
    });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AppError('SOURCE_UNAVAILABLE', 'Не удалось прочитать ответ YouTube.');
  }
  return parsed as Record<string, unknown>;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}
