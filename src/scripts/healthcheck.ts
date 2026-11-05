import { readFile } from 'node:fs/promises';
import { loadDotEnv } from '../app/env.js';
import { evaluateHealth } from '../app/heartbeat.js';
import { ConfigError, loadConfig } from '../config/load.js';

/** A missing or unreadable file yields null, which evaluateHealth reports as a failure. */
async function readSnapshot(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/**
 * Container health check. Exit code 0 means the bot reports itself ready and recently active.
 * The health file path comes from the same configuration as the bot, so both always agree.
 */
async function main(): Promise<number> {
  loadDotEnv(process.cwd());
  let healthFile: string;
  try {
    healthFile = loadConfig(process.env, process.cwd()).paths.healthFile;
  } catch (error) {
    process.stderr.write(
      `${error instanceof ConfigError ? error.message : 'Не удалось прочитать настройки.'}\n`,
    );
    return 1;
  }

  const verdict = evaluateHealth(await readSnapshot(healthFile), Date.now());
  if (!verdict.ok) {
    process.stderr.write(`Бот не в норме: ${verdict.reason}\n`);
    return 1;
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    process.exitCode = 1;
  },
);
