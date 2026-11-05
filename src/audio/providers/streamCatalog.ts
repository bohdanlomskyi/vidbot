import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import {
  checkStreamUrl,
  type StreamUrlPolicy,
  type UrlRejectionReason,
} from '../../security/urlPolicy.js';

const CATALOG_ID = /^[a-z0-9][a-z0-9-]{2,39}$/;
const MAX_CATALOG_BYTES = 256 * 1024;
const MAX_ENTRIES = 200;

export interface StreamCatalogEntry {
  readonly id: string;
  readonly title: string;
  readonly artist: string | null;
  /** Kept in memory only. Never shown to users and never written to logs. */
  readonly url: URL;
  readonly policy: StreamUrlPolicy;
  readonly live: boolean;
  readonly durationSec: number | null;
  readonly thumbnailUrl: string | null;
}

export interface StreamCatalogParseResult {
  readonly entries: readonly StreamCatalogEntry[];
  /** Operator-facing problems, one per rejected entry. They name the entry but never its URL. */
  readonly problems: readonly string[];
}

const entrySchema = z.object({
  id: z
    .string()
    .regex(CATALOG_ID, 'идентификатор: строчные латинские буквы, цифры и дефис, 3–40 символов')
    .refine((id) => !id.startsWith('lib-'), 'идентификатор не может начинаться с lib-'),
  title: z.string().trim().min(1).max(100),
  artist: z.string().trim().max(100).optional(),
  url: z.string().min(1).max(2048),
  allowHttp: z.boolean().default(false),
  allowedHosts: z.array(z.string().trim().toLowerCase().min(1).max(253)).min(1).max(10).optional(),
  allowedPorts: z.array(z.number().int().min(1).max(65535)).min(1).max(5).optional(),
  live: z.boolean().default(false),
  durationSec: z.number().int().positive().max(86_400).nullable().optional(),
  thumbnailUrl: z.string().max(2048).optional(),
});

const documentSchema = z.object({
  streams: z.array(z.unknown()).max(MAX_ENTRIES),
});

const REASON_TEXT: Readonly<Record<UrlRejectionReason, string>> = {
  TOO_LONG: 'адрес слишком длинный',
  INVALID_URL: 'адрес не является корректной ссылкой',
  UNSUPPORTED_SCHEME: 'разрешён только https (http допускается при allowHttp: true)',
  CREDENTIALS_NOT_ALLOWED: 'в адресе не должно быть логина и пароля',
  PORT_NOT_ALLOWED: 'порт адреса не указан в allowedPorts',
  PRIVATE_ADDRESS: 'адрес указывает на локальную, закрытую или служебную сеть',
  HOST_NOT_ALLOWED: 'хост адреса отсутствует в allowedHosts',
};

/**
 * Validates an operator-written stream catalog. Each entry is checked on its own, so one
 * broken entry never hides the others. Duplicate identifiers keep the first entry.
 */
export function parseStreamCatalog(raw: unknown): StreamCatalogParseResult {
  const document = documentSchema.safeParse(raw);
  if (!document.success) {
    return {
      entries: [],
      problems: ['Каталог потоков имеет неверную структуру: ожидается объект с полем "streams".'],
    };
  }

  const entries: StreamCatalogEntry[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  document.data.streams.forEach((item, index) => {
    const parsed = entrySchema.safeParse(item);
    if (!parsed.success) {
      const details = parsed.error.issues.map((issue) => issue.message).join('; ');
      problems.push(`Запись #${String(index + 1)} пропущена: ${details}.`);
      return;
    }

    const data = parsed.data;
    if (seen.has(data.id)) {
      problems.push(`Запись "${data.id}" пропущена: идентификатор уже используется.`);
      return;
    }

    const built = buildEntry(data);
    if (!built.ok) {
      problems.push(`Запись "${data.id}" отклонена: ${REASON_TEXT[built.reason]}.`);
      return;
    }

    seen.add(data.id);
    entries.push(built.entry);
  });

  return { entries, problems };
}

/** Reads and validates the catalog file. A missing file means no streams are configured. */
export async function loadStreamCatalog(file: string): Promise<StreamCatalogParseResult> {
  let text: string;
  try {
    const info = await stat(file);
    if (info.size > MAX_CATALOG_BYTES) {
      return { entries: [], problems: ['Файл каталога потоков слишком большой.'] };
    }
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      return { entries: [], problems: [] };
    }
    return { entries: [], problems: ['Не удалось прочитать файл каталога потоков.'] };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { entries: [], problems: ['Файл каталога потоков содержит некорректный JSON.'] };
  }
  return parseStreamCatalog(raw);
}

type EntryData = z.infer<typeof entrySchema>;

type BuildResult =
  | { readonly ok: true; readonly entry: StreamCatalogEntry }
  | { readonly ok: false; readonly reason: UrlRejectionReason };

function buildEntry(data: EntryData): BuildResult {
  let url: URL;
  try {
    url = new URL(data.url);
  } catch {
    return { ok: false, reason: 'INVALID_URL' };
  }

  const policy: StreamUrlPolicy = {
    allowedHosts: data.allowedHosts ?? [stripBrackets(url.hostname).toLowerCase()],
    allowHttp: data.allowHttp,
    allowedPorts: data.allowedPorts ?? [url.protocol === 'http:' ? 80 : 443],
  };

  const check = checkStreamUrl(url.href, policy);
  if (!check.ok) {
    return { ok: false, reason: check.reason };
  }

  const thumbnailUrl =
    data.thumbnailUrl !== undefined && data.thumbnailUrl.startsWith('https://')
      ? data.thumbnailUrl
      : null;

  return {
    ok: true,
    entry: {
      id: data.id,
      title: data.title,
      artist: data.artist ?? null,
      url,
      policy,
      live: data.live,
      durationSec: data.live ? null : (data.durationSec ?? null),
      thumbnailUrl,
    },
  };
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
