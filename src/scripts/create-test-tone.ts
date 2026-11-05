import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { loadDotEnv } from '../app/env.js';

const run = promisify(execFile);

/**
 * Generates a ten-second 440 Hz tone with FFmpeg's sine source into music/examples. The tone is
 * synthesized, not downloaded, so it carries no third-party rights. An existing file is kept.
 */
async function main(): Promise<void> {
  loadDotEnv(process.cwd());
  const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
  const directory = resolve(process.cwd(), process.env.MUSIC_DIR ?? 'music', 'examples');
  const output = resolve(directory, 'test-tone.wav');

  if (existsSync(output)) {
    process.stdout.write(`Файл уже существует и не перезаписывается: ${output}\n`);
    return;
  }
  await mkdir(directory, { recursive: true });
  await run(ffmpeg, [
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
  ]);
  process.stdout.write(`Создан тестовый тон: ${output}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Не удалось создать тон: ${error instanceof Error ? error.message : 'неизвестная ошибка'}\n`,
  );
  process.exitCode = 1;
});
