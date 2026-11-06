import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import { REST } from 'discord.js';
import { type CheckStatus, runDiagnostics } from '../app/diagnostics.js';
import { guildSettingsDefaults } from '../app/guildDefaults.js';
import { buildRegistration } from '../commands/registration.js';
import { loadConfig } from '../config/load.js';
import { openDatabase } from '../database/db.js';
import { migrate } from '../database/migrations.js';
import { GuildSettingsRepository } from '../database/settingsRepository.js';
import {
  type DiscordEntity,
  fetchBotApplication,
  fetchBotGuilds,
  inviteUrl,
  looksLikeToken,
  SetupError,
} from '../setup/discord.js';
import { updateEnvText } from '../setup/envFile.js';
import { askSecret, askYesNo, choose, closePrompt, openInBrowser } from '../setup/prompt.js';
import { downloadFfmpeg, downloadYtDlp, findFfmpeg, findYtDlp } from '../setup/tools.js';

/**
 * Interactive setup: `npm run setup`, or install.cmd / setup.cmd on Windows. It asks only for
 * what cannot be found automatically (the bot token, and whether to enable YouTube), derives
 * the rest, writes .env, registers the commands and runs the self-checks. Running it again is
 * safe: every current value is offered as the default.
 */

const PORTAL = 'https://discord.com/developers/applications';
const GUILD_WAIT_MS = 10 * 60_000;
const GUILD_POLL_MS = 3_000;
const LABELS: Record<CheckStatus, string> = { ok: 'ОК', fail: 'ОШИБКА', skip: 'ПРОПУСК' };

const root = process.cwd();
const toolsDir = path.join(root, '.tools');
const out = (text = ''): void => {
  process.stdout.write(`${text}\n`);
};
const step = (title: string): void => {
  out();
  out(`── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
};

async function readEnvText(): Promise<string> {
  const envFile = path.join(root, '.env');
  if (existsSync(envFile)) {
    return readFile(envFile, 'utf8');
  }
  const example = path.join(root, '.env.example');
  return existsSync(example) ? readFile(example, 'utf8') : '';
}

async function obtainToken(current: string | undefined): Promise<{
  token: string;
  app: DiscordEntity;
}> {
  step('1. Токен бота');
  if (current !== undefined && current !== '') {
    try {
      const app = await fetchBotApplication(current);
      out(`Токен уже задан, бот: «${app.name}».`);
      if (await askYesNo('Оставить этот токен?', true)) {
        return { token: current, app };
      }
    } catch (error) {
      out(error instanceof SetupError ? error.message : 'Сохранённый токен не подошёл.');
    }
  }

  out('Где взять токен:');
  out(`  1) Откройте ${PORTAL} и создайте приложение (New Application)`);
  out('     или выберите существующее.');
  out('  2) Слева «Bot» → «Reset Token» → «Copy».');
  out('  3) Вставьте токен сюда (Ctrl+V или правая кнопка мыши) и нажмите Enter.');
  out('  Токен — это пароль бота. Не отправляйте его никому и не показывайте на скриншотах.');
  if (await askYesNo('Открыть Developer Portal в браузере?', true)) {
    openInBrowser(PORTAL);
  }
  for (;;) {
    const token = (await askSecret('Токен бота')).replace(/^Bot\s+/iu, '');
    if (token === '') {
      throw new SetupError('INVALID_TOKEN', 'Токен не введён. Настройка прервана.');
    }
    if (!looksLikeToken(token)) {
      out('Это не похоже на токен бота: в нём три части через точку. Возможно, скопирован');
      out('Application ID или Client Secret. Нужен «Bot» → «Reset Token».');
      continue;
    }
    try {
      const app = await fetchBotApplication(token);
      out(`Токен подходит, бот: «${app.name}». Client ID определён автоматически: ${app.id}.`);
      return { token, app };
    } catch (error) {
      out(error instanceof Error ? error.message : 'Не удалось проверить токен.');
      if (error instanceof SetupError && error.code === 'NETWORK') {
        throw error;
      }
    }
  }
}

async function chooseGuild(
  token: string,
  app: DiscordEntity,
  current: string | undefined,
): Promise<DiscordEntity> {
  step('2. Сервер Discord');
  const link = inviteUrl(app.id);
  let guilds = await fetchBotGuilds(token);
  if (guilds.length === 0) {
    out('Бота ещё нет ни на одном сервере. Откроется страница приглашения:');
    out(`  ${link}`);
    out('Выберите свой сервер и нажмите «Авторизовать». Нужны права «Управлять сервером».');
    openInBrowser(link);
    out('Жду, пока бот появится на сервере… (Ctrl+C — прервать)');
    const deadline = Date.now() + GUILD_WAIT_MS;
    while (guilds.length === 0) {
      if (Date.now() > deadline) {
        throw new SetupError(
          'DISCORD',
          'Бот так и не появился на сервере. Запустите настройку снова.',
        );
      }
      await sleep(GUILD_POLL_MS);
      guilds = await fetchBotGuilds(token);
    }
  }

  let guild: DiscordEntity;
  if (guilds.length === 1 && guilds[0] !== undefined) {
    guild = guilds[0];
    out(`Бот на сервере «${guild.name}».`);
  } else {
    out('Бот есть на нескольких серверах. На каком из них команды должны появиться сразу?');
    const preferred = Math.max(
      0,
      guilds.findIndex((item) => item.id === current),
    );
    const index = await choose(
      'Номер сервера',
      guilds.map((item) => item.name),
      preferred,
    );
    guild = guilds[index] ?? guilds[0] ?? { id: '', name: '' };
  }
  out(`Пригласить бота на другой сервер: ${link}`);
  return guild;
}

async function configureFfmpeg(
  env: Record<string, string | undefined>,
): Promise<Record<string, string>> {
  step('3. FFmpeg (декодирование звука)');
  const configured = {
    ffmpeg: env.FFMPEG_PATH ?? 'ffmpeg',
    ffprobe: env.FFPROBE_PATH ?? 'ffprobe',
  };
  let found = await findFfmpeg(toolsDir, configured);
  if (found === null && process.platform === 'win32') {
    out('FFmpeg не найден. Его можно скачать автоматически (около 100 МБ, с gyan.dev,');
    out('ссылка с официального сайта ffmpeg.org; контрольная сумма проверяется).');
    if (await askYesNo('Скачать FFmpeg?', true)) {
      found = await downloadFfmpeg(toolsDir);
    }
  }
  if (found === null) {
    out('FFmpeg не найден, без него звука не будет. Установите его и запустите настройку снова:');
    out('  Debian/Ubuntu: sudo apt install ffmpeg');
    out('  macOS:         brew install ffmpeg');
    out('  Windows:       запустите install.cmd ещё раз и согласитесь на загрузку');
    return {};
  }
  out(`FFmpeg работает: ${found.ffmpeg}`);
  return { FFMPEG_PATH: found.ffmpeg, FFPROBE_PATH: found.ffprobe };
}

async function configureYoutube(
  env: Record<string, string | undefined>,
): Promise<Record<string, string>> {
  step('4. YouTube (необязательно)');
  const enabledNow =
    env.YOUTUBE_PROVIDER_ENABLED === 'true' || env.YOUTUBE_PROVIDER_ENABLED === '1';
  out('Условия YouTube запрещают скачивать и воспроизводить его контент ботами без');
  out('письменного разрешения YouTube или правообладателей. Подробнее: docs/youtube.md.');
  const enable = await askYesNo(
    'У вас есть такое разрешение, и вы хотите включить YouTube?',
    enabledNow,
  );
  if (!enable) {
    out('YouTube выключен. Бот играет музыку из папки music.');
    return { YOUTUBE_PROVIDER_ENABLED: 'false' };
  }
  let ytdlp = await findYtDlp(toolsDir, env.YTDLP_PATH ?? 'yt-dlp');
  if (ytdlp === null) {
    out('yt-dlp не найден. Скачиваю официальную сборку с GitHub (контрольная сумма проверяется).');
    ytdlp = await downloadYtDlp(toolsDir);
    out('Первый запуск yt-dlp может занять до минуты.');
    if ((await findYtDlp(toolsDir, ytdlp)) === null) {
      out('yt-dlp скачан, но не запускается. Проверьте антивирус и запустите настройку снова.');
    }
  }
  out(`yt-dlp: ${ytdlp}`);
  return { YOUTUBE_PROVIDER_ENABLED: 'true', YTDLP_PATH: ytdlp };
}

async function registerCommands(env: Record<string, string>): Promise<void> {
  step('5. Команды бота');
  const config = loadConfig(env, root);
  const plan = buildRegistration(config.discord, { global: false });
  const rest = new REST({ version: '10' }).setToken(config.discord.token);
  const result: unknown = await rest.put(plan.route, { body: plan.body });
  out(
    `Команд зарегистрировано: ${String(Array.isArray(result) ? result.length : 0)}. Они уже видны на сервере.`,
  );
}

/** When YouTube was switched on, the chosen server is allowed to use it straight away. */
function allowYoutubeOnGuild(env: Record<string, string>, guildId: string): void {
  const config = loadConfig(env, root);
  if (!config.youtube.enabled) {
    return;
  }
  const db = openDatabase(config.paths.databaseFile);
  try {
    migrate(db);
    const settings = new GuildSettingsRepository(db, guildSettingsDefaults(config));
    const allowed = settings.get(guildId).allowedSources;
    if (!allowed.includes('youtube')) {
      settings.patch(guildId, { allowedSources: [...allowed, 'youtube'] });
    }
    out(
      'На сервере разрешены источники: библиотека и YouTube (меняется командой /settings sources).',
    );
  } finally {
    db.close();
  }
}

async function selfCheck(env: Record<string, string>): Promise<number> {
  step('6. Проверка');
  const results = await runDiagnostics(env, root);
  for (const result of results) {
    out(`[${LABELS[result.status]}] ${result.name}: ${result.detail}`);
  }
  return results.filter((result) => result.status === 'fail').length;
}

function definedOnly(values: NodeJS.Dict<string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

async function main(): Promise<void> {
  out('Melody: настройка. Нажимайте Enter, чтобы принять значение в [скобках].');
  let text = await readEnvText();
  const env: Record<string, string | undefined> = parseEnv(text);

  const { token, app } = await obtainToken(env.DISCORD_TOKEN);
  const guild = await chooseGuild(token, app, env.DISCORD_GUILD_ID);
  const updates: Record<string, string> = {
    DISCORD_TOKEN: token,
    DISCORD_CLIENT_ID: app.id,
    DISCORD_GUILD_ID: guild.id,
    ...(await configureFfmpeg(env)),
    ...(await configureYoutube(env)),
  };

  text = updateEnvText(text, updates);
  await writeFile(path.join(root, '.env'), text, 'utf8');
  out();
  out('Настройки сохранены в файл .env.');
  const saved = definedOnly(parseEnv(text));

  try {
    await registerCommands(saved);
  } catch (error) {
    out(`Команды не зарегистрированы: ${error instanceof Error ? error.message : 'ошибка'}`);
    out('Повторить: npm run commands:register');
  }
  allowYoutubeOnGuild(saved, guild.id);
  await addTestTone(saved);
  const failures = await selfCheck(saved);

  step('Готово');
  if (failures > 0) {
    out(
      `Проверок с ошибками: ${String(failures)}. Подсказки — в README, раздел «Если что-то не так».`,
    );
  }
  out('Дальше:');
  out(
    process.platform === 'win32'
      ? '  1) Запустите бота: start.cmd (или ярлык «Melody» на рабочем столе).'
      : '  1) Запустите бота: ./start.sh',
  );
  out(`  2) В Discord на сервере «${guild.name}» напишите /setup и выберите канал для панели.`);
  out('  3) Зайдите в голосовой канал и напишите /play test-tone — это проверочный сигнал.');
  out('     Свою музыку положите в папку music (mp3, flac, ogg, wav, m4a и другие),');
  out('     а если включён YouTube, давайте /play ссылку на видео.');
}

/** A ten-second 440 Hz tone, synthesized by FFmpeg, so the first /play works out of the box. */
async function addTestTone(env: Record<string, string>): Promise<void> {
  const ffmpeg = env.FFMPEG_PATH;
  if (ffmpeg === undefined) {
    return;
  }
  const directory = path.resolve(root, env.MUSIC_DIR ?? 'music', 'examples');
  const output = path.join(directory, 'test-tone.wav');
  if (existsSync(output)) {
    return;
  }
  await mkdir(directory, { recursive: true });
  const ok = await new Promise<boolean>((resolve) => {
    execFile(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-n',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=10',
        '-ac',
        '2',
        '-ar',
        '48000',
        output,
      ],
      { windowsHide: true, timeout: 60_000 },
      (error) => {
        resolve(error === null);
      },
    );
  });
  if (ok) {
    out('Добавлен проверочный трек «test-tone» (сигнал 440 Гц, 10 секунд).');
  }
}

main()
  .catch((error: unknown) => {
    out();
    out(error instanceof Error ? error.message : 'Настройка прервана.');
    process.exitCode = 1;
  })
  .finally(closePrompt);
