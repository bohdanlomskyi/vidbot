import { access, constants as fsConstants, mkdir, stat } from 'node:fs/promises';
import { loadStreamCatalog } from '../audio/providers/streamCatalog.js';
import { type AppConfig, ConfigError, loadConfig } from '../config/load.js';
import { checkDatabase as runIntegrityCheck, openDatabase } from '../database/db.js';
import { migrate } from '../database/migrations.js';
import { checkCipher, checkDave, checkOpus, type NativeCheck } from './nativeChecks.js';
import { readToolVersion } from './tools.js';

export type CheckStatus = 'ok' | 'fail' | 'skip';

export interface DiagnosticResult {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

const MIN_NODE_VERSION: readonly [number, number, number] = [24, 17, 0];

/** Checks that need a valid configuration. They are skipped with a note when it is broken. */
const CONFIG_DEPENDENT = [
  'FFmpeg',
  'ffprobe',
  'Каталог музыки',
  'Каталог данных',
  'SQLite',
  'yt-dlp',
  'Каталог потоков',
] as const;

/**
 * Runs every self-check the operator needs before starting the bot. The results never contain
 * the Discord token or any other secret: configuration is described only by presence and by
 * non-secret identifiers.
 */
export async function runDiagnostics(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): Promise<DiagnosticResult[]> {
  const results: DiagnosticResult[] = [checkNodeVersion(process.versions.node)];

  const config = readConfig(env, cwd);
  results.push(config.result);
  if (config.config === null) {
    for (const name of CONFIG_DEPENDENT) {
      results.push(skip(name, 'нужна действительная конфигурация'));
    }
  } else {
    results.push(...(await checkConfigured(config.config)));
  }

  results.push(named('Opus', checkOpus()));
  results.push(named('DAVE', await checkDave()));
  results.push(named('Шифрование', checkCipher()));
  return results;
}

async function checkConfigured(config: AppConfig): Promise<DiagnosticResult[]> {
  return [
    await checkTool('FFmpeg', config.ffmpeg.ffmpegPath, ['-version']),
    await checkTool('ffprobe', config.ffmpeg.ffprobePath, ['-version']),
    await checkMusicDirectory(config.paths.musicDir),
    await checkDataDirectory(config.paths.dataDir),
    checkDatabaseFile(config.paths.databaseFile),
    config.youtube.enabled
      ? await checkTool('yt-dlp', config.youtube.ytdlpPath, ['--version'])
      : skip('yt-dlp', 'YouTube отключён оператором'),
    config.streams.enabled
      ? await checkStreamCatalog(config.paths.streamCatalogFile)
      : skip('Каталог потоков', 'потоковые источники отключены'),
  ];
}

export function checkNodeVersion(version: string): DiagnosticResult {
  const [major = 0, minor = 0, patch = 0] = version
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  const [minMajor, minMinor, minPatch] = MIN_NODE_VERSION;
  const meetsMinimum =
    major > minMajor ||
    (major === minMajor && (minor > minMinor || (minor === minMinor && patch >= minPatch)));
  return {
    name: 'Node.js',
    status: meetsMinimum ? 'ok' : 'fail',
    detail: meetsMinimum
      ? `версия ${version}`
      : `нужна версия ${MIN_NODE_VERSION.join('.')} или новее, установлена ${version}`,
  };
}

function readConfig(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): { config: AppConfig | null; result: DiagnosticResult } {
  try {
    const config = loadConfig(env, cwd);
    return {
      config,
      result: {
        name: 'Конфигурация',
        status: 'ok',
        detail: describeConfig(config),
      },
    };
  } catch (error) {
    return {
      config: null,
      result: {
        name: 'Конфигурация',
        status: 'fail',
        detail: error instanceof ConfigError ? error.message : 'не удалось прочитать настройки',
      },
    };
  }
}

function describeConfig(config: AppConfig): string {
  const guild = config.discord.guildId ?? 'не задан, команды будут глобальными';
  return `DISCORD_TOKEN задан (скрыт), приложение ${config.discord.clientId}, сервер ${guild}, журнал ${config.logLevel}`;
}

async function checkTool(
  name: string,
  binary: string,
  args: readonly string[],
): Promise<DiagnosticResult> {
  const version = await readToolVersion(binary, args);
  return version === null
    ? { name, status: 'fail', detail: `не запускается: ${binary}` }
    : { name, status: 'ok', detail: version };
}

async function checkMusicDirectory(directory: string): Promise<DiagnosticResult> {
  const name = 'Каталог музыки';
  try {
    const info = await stat(directory);
    if (!info.isDirectory()) {
      return { name, status: 'fail', detail: `это не каталог: ${directory}` };
    }
    await access(directory, fsConstants.R_OK);
    return { name, status: 'ok', detail: directory };
  } catch {
    return { name, status: 'fail', detail: `каталог не найден или недоступен: ${directory}` };
  }
}

async function checkDataDirectory(directory: string): Promise<DiagnosticResult> {
  const name = 'Каталог данных';
  try {
    await mkdir(directory, { recursive: true });
    await access(directory, fsConstants.W_OK);
    return { name, status: 'ok', detail: directory };
  } catch {
    return { name, status: 'fail', detail: `нельзя создать или записать: ${directory}` };
  }
}

function checkDatabaseFile(file: string): DiagnosticResult {
  const name = 'SQLite';
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    db = openDatabase(file);
    migrate(db);
    const check = runIntegrityCheck(db);
    return check.ok
      ? { name, status: 'ok', detail: `${file}, проверка целостности: ${check.detail}` }
      : { name, status: 'fail', detail: check.detail };
  } catch (error) {
    return {
      name,
      status: 'fail',
      detail: `не открывается: ${error instanceof Error ? error.message : 'ошибка'}`,
    };
  } finally {
    db?.close();
  }
}

async function checkStreamCatalog(file: string): Promise<DiagnosticResult> {
  const name = 'Каталог потоков';
  const parsed = await loadStreamCatalog(file);
  if (parsed.problems.length > 0) {
    return {
      name,
      status: 'fail',
      detail: `записей отклонено: ${String(parsed.problems.length)}. ${parsed.problems[0] ?? ''}`,
    };
  }
  const note = parsed.entries.length === 0 ? ' (файл не найден или пуст)' : '';
  return { name, status: 'ok', detail: `записей: ${String(parsed.entries.length)}${note}` };
}

function named(name: string, check: NativeCheck): DiagnosticResult {
  return { name, status: check.ok ? 'ok' : 'fail', detail: check.detail };
}

function skip(name: string, reason: string): DiagnosticResult {
  return { name, status: 'skip', detail: reason };
}
