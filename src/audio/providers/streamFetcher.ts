import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { pipeline, Transform, type Readable } from 'node:stream';
import {
  type AddressSelection,
  checkStreamUrl,
  type ResolvedRecord,
  selectPublicAddress,
  type StreamUrlPolicy,
} from '../../security/urlPolicy.js';
import { AppError } from '../../utils/errors.js';

/** Decides which resolved addresses may be connected to. Production uses selectPublicAddress. */
export type AddressGuard = (records: readonly ResolvedRecord[]) => AddressSelection;

export interface StreamTimeouts {
  /** Time allowed until response headers arrive. */
  readonly responseMs: number;
  /** Longest silence allowed while the body is being read. */
  readonly idleMs: number;
}

export interface OpenStreamOptions {
  readonly url: URL;
  readonly policy: StreamUrlPolicy;
  readonly signal: AbortSignal;
  /** Byte cap for finite streams. Null for live streams. */
  readonly maxBytes: number | null;
  readonly timeouts: StreamTimeouts;
  readonly addressGuard?: AddressGuard;
  readonly userAgent?: string;
}

export interface OpenedStream {
  /** The capped response body. Failures arrive as 'error' events on this stream. */
  readonly body: Readable;
  readonly contentType: string | null;
  close(): void;
}

const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const BLOCKED_ADDRESS_CODE = 'EBLOCKEDADDRESS';

/**
 * Validates a redirect target against the same policy as the original URL.
 * Redirects are followed by hand, so a public URL cannot bounce the bot to a
 * private address or to an unlisted host.
 */
export function nextRedirectTarget(
  current: URL,
  location: string | null,
  policy: StreamUrlPolicy,
): URL {
  if (location === null || location.trim() === '') {
    throw new AppError('SOURCE_RESTRICTED', 'Источник перенаправил без адреса.');
  }

  let target: URL;
  try {
    target = new URL(location, current);
  } catch {
    throw new AppError('SOURCE_RESTRICTED', 'Источник вернул некорректное перенаправление.');
  }

  if (!checkStreamUrl(target.href, policy).ok) {
    throw new AppError(
      'SOURCE_RESTRICTED',
      'Перенаправление ведёт на адрес, запрещённый политикой безопасности.',
    );
  }
  return target;
}

export type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | { address: string; family: number }[],
  family?: number,
) => void;

export type LookupFunction = (
  hostname: string,
  options: { readonly all?: boolean },
  callback: LookupCallback,
) => void;

export interface GuardedLookupOptions {
  readonly resolve: (hostname: string) => Promise<readonly ResolvedRecord[]>;
  readonly guard: AddressGuard;
}

/**
 * Builds a DNS lookup function for the HTTP client. The address that the connection
 * uses is the one that passed the guard, which blocks DNS rebinding between the check
 * and the connection. A refused address produces an error and no connection.
 */
export function createGuardedLookup(options: GuardedLookupOptions): LookupFunction {
  return (hostname, lookupOptions, callback) => {
    const wantsList = lookupOptions.all === true;

    options.resolve(hostname).then(
      (records) => {
        const selection = options.guard(records);
        if (!selection.ok) {
          const error = Object.assign(
            new Error('Адрес источника запрещён политикой безопасности.'),
            {
              code: BLOCKED_ADDRESS_CODE,
            },
          );
          if (wantsList) {
            callback(error, []);
          } else {
            callback(error, '', 0);
          }
          return;
        }
        if (wantsList) {
          callback(null, [{ address: selection.address, family: selection.family }]);
        } else {
          callback(null, selection.address, selection.family);
        }
      },
      (error: unknown) => {
        const failure = error instanceof Error ? error : new Error('DNS lookup failed');
        if (wantsList) {
          callback(failure, []);
        } else {
          callback(failure, '', 0);
        }
      },
    );
  };
}

/** Resolves every address for a host name, so the guard can see the whole answer. */
export async function resolveHostname(hostname: string): Promise<ResolvedRecord[]> {
  const records = await dns.promises.lookup(hostname, { all: true, order: 'verbatim' });
  return records.map((record) => ({ address: record.address, family: record.family }));
}

/**
 * Opens a streaming GET request. Redirects are checked one by one. A non-audio response,
 * an error status, a timeout or an oversized body raises an AppError.
 */
export async function openStream(options: OpenStreamOptions): Promise<OpenedStream> {
  const guard = options.addressGuard ?? selectPublicAddress;
  let current = options.url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await requestOnce(current, options, guard);
    const status = response.statusCode ?? 0;

    if (REDIRECT_STATUSES.has(status)) {
      response.resume();
      current = nextRedirectTarget(current, response.headers.location ?? null, options.policy);
      continue;
    }
    if (status !== 200) {
      response.resume();
      throw new AppError('SOURCE_UNAVAILABLE', 'Поток недоступен.');
    }

    const contentType = response.headers['content-type']?.toLowerCase() ?? null;
    if (contentType !== null && isNonAudioContentType(contentType)) {
      response.resume();
      throw new AppError('SOURCE_UNAVAILABLE', 'Источник вернул не аудиопоток.');
    }
    return wrapBody(response, contentType, options);
  }

  throw new AppError('SOURCE_RESTRICTED', 'Слишком много перенаправлений.');
}

function requestOnce(
  url: URL,
  options: OpenStreamOptions,
  guard: AddressGuard,
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const request = client.get(url, {
      headers: {
        'user-agent': options.userAgent ?? 'Melody',
        accept: '*/*',
        'icy-metadata': '0',
      },
      // A stream owns its connection, so it is never returned to a keep-alive pool.
      agent: false,
      lookup: createGuardedLookup({ resolve: resolveHostname, guard }),
      signal: options.signal,
    });

    const timer = setTimeout(() => {
      request.destroy(new AppError('TIMEOUT', 'Источник не ответил вовремя.'));
    }, options.timeouts.responseMs);

    request.once('response', (response) => {
      clearTimeout(timer);
      resolve(response);
    });
    request.on('error', (error: Error) => {
      clearTimeout(timer);
      reject(toAppError(error));
    });
  });
}

function wrapBody(
  response: http.IncomingMessage,
  contentType: string | null,
  options: OpenStreamOptions,
): OpenedStream {
  const limit = options.maxBytes;
  let received = 0;

  const cap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (limit !== null && received > limit) {
        callback(new AppError('SOURCE_UNAVAILABLE', 'Поток превысил допустимый размер.'));
        return;
      }
      callback(null, chunk);
    },
  });

  // Idle detection counts network silence only. While the consumer applies backpressure
  // (for example during a user pause) the response is paused and no bytes are expected,
  // so that time is not treated as a stall.
  let lastActivity = Date.now();
  response.on('data', () => {
    lastActivity = Date.now();
  });
  const idleCheck = setInterval(
    () => {
      if (response.isPaused()) {
        lastActivity = Date.now();
        return;
      }
      if (Date.now() - lastActivity >= options.timeouts.idleMs) {
        response.destroy(new AppError('TIMEOUT', 'Поток перестал передавать данные.'));
      }
    },
    Math.max(50, Math.floor(options.timeouts.idleMs / 4)),
  );
  response.once('close', () => {
    clearInterval(idleCheck);
  });

  const onAbort = (): void => {
    response.destroy();
  };
  options.signal.addEventListener('abort', onAbort, { once: true });

  // pipeline destroys both ends on failure, so the consumer always sees the error.
  pipeline(response, cap, () => {
    options.signal.removeEventListener('abort', onAbort);
  });

  return {
    body: cap,
    contentType,
    close: () => {
      options.signal.removeEventListener('abort', onAbort);
      response.destroy();
      cap.destroy();
    },
  };
}

function isNonAudioContentType(contentType: string): boolean {
  return (
    contentType.startsWith('text/') ||
    contentType.startsWith('application/json') ||
    contentType.startsWith('application/xml') ||
    contentType.startsWith('application/xhtml')
  );
}

function toAppError(error: Error): AppError {
  if (error instanceof AppError) {
    return error;
  }
  if ('code' in error && error.code === BLOCKED_ADDRESS_CODE) {
    return new AppError('SOURCE_RESTRICTED', 'Адрес источника запрещён политикой безопасности.');
  }
  if (error.name === 'AbortError') {
    return new AppError('CANCELLED', 'Загрузка потока отменена.');
  }
  return new AppError('SOURCE_UNAVAILABLE', 'Не удалось подключиться к источнику.', {
    cause: error,
  });
}
