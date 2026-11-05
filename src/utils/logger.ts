import pino, { type Logger } from 'pino';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface LoggerOptions {
  readonly level: LogLevel;
  /** Exact secret values, such as the Discord token, that must never reach the output. */
  readonly secrets: readonly string[];
  /** Where records go. Defaults to standard output. */
  readonly destination?: { write(chunk: string): unknown };
}

const REDACTED = '[скрыто]';
const SECRET_KEYS = ['token', 'authorization', 'password', 'secret', 'cookie', 'cookies', 'proxy'];
const MIN_SECRET_LENGTH = 8;
const MAX_DEPTH = 6;

/**
 * Creates a structured JSON logger. Two layers protect secrets. Pino redacts
 * fields named like credentials. A masker then replaces the exact secret values
 * in every string, error message and stack, so a token that ends up inside a
 * message is still hidden.
 */
export function createLogger(options: LoggerOptions): Logger {
  const mask = createMasker(options.secrets);
  const redactPaths = SECRET_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]);

  const config: pino.LoggerOptions = {
    level: options.level,
    redact: { paths: redactPaths, censor: REDACTED },
    hooks: {
      logMethod(this: Logger, args, method) {
        method.apply(this, args.map((arg) => mask(arg)) as typeof args);
      },
    },
  };

  return options.destination ? pino(config, options.destination) : pino(config);
}

function createMasker(secrets: readonly string[]): (value: unknown) => unknown {
  const values = secrets.filter((secret) => secret.length >= MIN_SECRET_LENGTH);
  const maskText = (text: string): string =>
    values.reduce((result, secret) => result.split(secret).join(REDACTED), text);

  const visit = (value: unknown, depth: number, seen: WeakSet<object>): unknown => {
    if (typeof value === 'string') {
      return maskText(value);
    }
    if (value instanceof Error) {
      const copy = new Error(maskText(value.message));
      copy.name = value.name;
      if (value.stack !== undefined) {
        copy.stack = maskText(value.stack);
      }
      return copy;
    }
    if (depth >= MAX_DEPTH || value === null || typeof value !== 'object' || seen.has(value)) {
      return value;
    }
    // Class instances are passed through untouched: cloning them would be costly and lossy.
    if (!Array.isArray(value) && !isPlainObject(value)) {
      return value;
    }
    seen.add(value);
    if (Array.isArray(value)) {
      return value.map((item: unknown) => visit(item, depth + 1, seen));
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, visit(item, depth + 1, seen)]),
    );
  };

  return (value) => visit(value, 0, new WeakSet<object>());
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
