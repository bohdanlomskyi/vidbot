/**
 * Stable machine-readable error categories. The category drives behaviour
 * (for example retry or metrics); the user never sees it directly.
 */
export type AppErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'NOT_ALLOWED'
  | 'NOT_IN_VOICE'
  | 'BOT_BUSY'
  | 'QUEUE_FULL'
  | 'TRACK_TOO_LONG'
  | 'SOURCE_DISABLED'
  | 'SOURCE_UNAVAILABLE'
  | 'SOURCE_RESTRICTED'
  | 'VOICE_FAILED'
  | 'PERMISSION_MISSING'
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'INTERNAL';

export interface AppErrorOptions {
  readonly cause?: unknown;
  readonly retryable?: boolean;
}

/**
 * An error that is safe to show to Discord users. `userMessage` is written in
 * Russian and contains no internal paths, tokens or stack details. The original
 * failure stays available through `cause` for logging.
 */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly userMessage: string;
  readonly retryable: boolean;

  constructor(code: AppErrorCode, userMessage: string, options: AppErrorOptions = {}) {
    super(userMessage, { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.userMessage = userMessage;
    this.retryable = options.retryable ?? false;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Returns the user-facing text for application errors and the fallback for anything else. */
export function toUserMessage(error: unknown, fallback: string): string {
  return isAppError(error) ? error.userMessage : fallback;
}
