import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '../../utils/errors.js';
import type { LibraryProber } from './catalog.js';
import { AUDIO_EXTENSIONS } from './scanner.js';

/** Folder inside the music library where files sent through Discord are kept. */
export const UPLOADS_FOLDER = 'uploads';

/** Discord serves attachments only from these hosts. Anything else is refused. */
const ATTACHMENT_HOSTS: ReadonlySet<string> = new Set([
  'cdn.discordapp.com',
  'media.discordapp.net',
]);
const DOWNLOAD_TIMEOUT_MS = 90_000;
const MAX_NAME_LENGTH = 60;
const MAX_SAME_NAMES = 50;

export interface UploadServiceOptions {
  readonly musicDir: string;
  readonly maxBytes: number;
  /** Total size of the uploads folder that new files may not push past. */
  readonly quotaBytes: number;
  readonly probe: LibraryProber;
  /** Makes the library notice the new file straight away. */
  readonly refresh: () => Promise<unknown>;
  readonly fetchImpl?: typeof fetch;
}

export interface IncomingFile {
  readonly name: string;
  /** The size Discord reports. It is only a claim: the downloaded bytes are counted too. */
  readonly size: number;
  readonly url: string;
}

export interface StoredUpload {
  /** Relative to the music library, with forward slashes. */
  readonly relativePath: string;
  readonly durationSec: number | null;
}

/**
 * Takes an audio file that a member attached to a command and adds it to the library. Only
 * Discord attachment addresses are fetched. The file is size-limited while it downloads, must
 * be a decodable audio file, lands in a fixed folder under a cleaned name, and never replaces
 * a different file. Anything that fails leaves no partial file behind.
 */
export class UploadService {
  private readonly fetchImpl: typeof fetch;
  /** Picking a name and checking the quota run one upload at a time, so two cannot collide. */
  private naming: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: UploadServiceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async ingest(file: IncomingFile, signal: AbortSignal): Promise<StoredUpload> {
    const extension = path.extname(file.name).toLowerCase();
    if (!AUDIO_EXTENSIONS.has(extension)) {
      throw new AppError(
        'INVALID_INPUT',
        `Этот тип файла не поддерживается. Подойдут: ${[...AUDIO_EXTENSIONS].join(', ')}.`,
      );
    }
    assertAttachmentUrl(file.url);
    if (file.size > this.options.maxBytes) {
      throw tooLarge(this.options.maxBytes);
    }

    const folder = path.join(this.options.musicDir, UPLOADS_FOLDER);
    await mkdir(folder, { recursive: true });
    if ((await folderSize(folder)) + Math.max(0, file.size) > this.options.quotaBytes) {
      throw quotaExceeded();
    }

    const partial = path.join(folder, `.incoming-${randomBytes(6).toString('hex')}.part`);
    try {
      const digest = await this.download(file.url, partial, signal);
      return await this.place(folder, partial, digest, safeBase(file.name), extension);
    } finally {
      await rm(partial, { force: true });
    }
  }

  private async download(url: string, target: string, signal: AbortSignal): Promise<string> {
    const response = await this.fetchImpl(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]),
    });
    if (!response.ok || response.body === null) {
      throw new AppError('SOURCE_UNAVAILABLE', 'Не удалось скачать файл из Discord.');
    }
    const hash = createHash('sha256');
    let received = 0;
    const limit = this.options.maxBytes;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > limit) {
          callback(tooLarge(limit));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(target));
    return hash.digest('hex');
  }

  /** Checks the downloaded file, then moves it to a free name, or reuses an identical file. */
  private async place(
    folder: string,
    partial: string,
    digest: string,
    base: string,
    extension: string,
  ): Promise<StoredUpload> {
    // ffprobe judges by extension and content, so it reads a copy that has the real extension.
    const probed = `${partial}${extension}`;
    await rename(partial, probed);
    let durationSec: number | null;
    try {
      const probe = await this.options.probe(probed).catch(() => null);
      if (probe === null || !probe.hasAudio) {
        throw new AppError('INVALID_INPUT', 'Файл не похож на аудио или повреждён.');
      }
      durationSec = probe.durationSec;
    } catch (error) {
      await rm(probed, { force: true });
      throw error;
    }

    return this.oneAtATime(async () => {
      // Other uploads may have landed meanwhile. The checked file itself is in the folder already.
      if ((await folderSize(folder)) > this.options.quotaBytes) {
        await rm(probed, { force: true });
        throw quotaExceeded();
      }
      for (let attempt = 1; attempt <= MAX_SAME_NAMES; attempt += 1) {
        const name = `${base}${attempt === 1 ? '' : ` (${String(attempt)})`}${extension}`;
        const target = path.join(folder, name);
        const existing = await stat(target).catch(() => null);
        if (existing === null) {
          await rename(probed, target);
          await this.options.refresh();
          return { relativePath: `${UPLOADS_FOLDER}/${name}`, durationSec };
        }
        if (existing.size > 0 && (await sameContent(target, digest))) {
          await rm(probed, { force: true });
          return { relativePath: `${UPLOADS_FOLDER}/${name}`, durationSec };
        }
      }
      await rm(probed, { force: true });
      throw new AppError(
        'INVALID_INPUT',
        'Слишком много файлов с таким именем. Переименуйте файл.',
      );
    });
  }

  private oneAtATime<T>(work: () => Promise<T>): Promise<T> {
    const next = this.naming.then(work);
    this.naming = next.catch(() => undefined);
    return next;
  }
}

function quotaExceeded(): AppError {
  return new AppError(
    'QUOTA_EXCEEDED',
    'Место для загруженных файлов закончилось. Попросите администратора освободить его.',
  );
}

function assertAttachmentUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError('INVALID_INPUT', 'Некорректный адрес вложения.');
  }
  if (url.protocol !== 'https:' || !ATTACHMENT_HOSTS.has(url.hostname.toLowerCase())) {
    throw new AppError('INVALID_INPUT', 'Файл можно загрузить только как вложение Discord.');
  }
}

function tooLarge(maxBytes: number): AppError {
  const megabytes = Math.max(1, Math.floor(maxBytes / 1_048_576));
  return new AppError('INVALID_INPUT', `Файл слишком большой. Максимум: ${String(megabytes)} МБ.`);
}

/** Keeps letters, digits, spaces and a few marks of the file name, and nothing path-like. */
function safeBase(fileName: string): string {
  const withoutExtension = fileName.slice(0, fileName.length - path.extname(fileName).length);
  const lastPart = withoutExtension.split(/[\\/]/u).pop() ?? '';
  const cleaned = lastPart
    .replace(/[^\p{L}\p{N} ._()-]+/gu, '_')
    .replace(/\.{2,}/gu, '.')
    .replace(/\s+/gu, ' ')
    .replace(/^[ ._-]+|[ ._-]+$/gu, '')
    .slice(0, MAX_NAME_LENGTH)
    .trim();
  return cleaned === '' ? 'track' : cleaned;
}

async function folderSize(folder: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (entry.isFile()) {
      total += (await stat(path.join(folder, entry.name))).size;
    }
  }
  return total;
}

async function sameContent(file: string, digest: string): Promise<boolean> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex') === digest;
}
