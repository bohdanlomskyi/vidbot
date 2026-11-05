import { createApp, type App } from './app/createApp.js';
import { loadDotEnv } from './app/env.js';
import { type AppConfig, ConfigError, loadConfig } from './config/load.js';
import { createLogger } from './utils/logger.js';

/** How long shutdown may take before the process exits anyway. */
const SHUTDOWN_GRACE_MS = 15_000;

function readConfig(): AppConfig | null {
  try {
    return loadConfig(process.env, process.cwd());
  } catch (error) {
    // Configuration errors are written for operators and never contain secret values.
    const message =
      error instanceof ConfigError ? error.message : 'Не удалось прочитать настройки.';
    process.stderr.write(`${message}\n`);
    return null;
  }
}

async function main(): Promise<void> {
  loadDotEnv(process.cwd());
  const config = readConfig();
  if (config === null) {
    process.exitCode = 1;
    return;
  }

  const logger = createLogger({ level: config.logLevel, secrets: [config.discord.token] });
  let app: App;
  try {
    app = await createApp(config, logger);
  } catch (error) {
    logger.fatal({ err: error }, 'Melody could not be assembled');
    process.exitCode = 1;
    return;
  }

  let stopping: Promise<void> | undefined;
  const shutdown = (reason: string): void => {
    stopping ??= (async () => {
      logger.info({ reason }, 'Stopping Melody');
      const killer = setTimeout(() => {
        logger.error('Shutdown took too long; forcing exit');
        process.exit(1);
      }, SHUTDOWN_GRACE_MS);
      killer.unref();
      try {
        await app.stop();
      } catch (error) {
        logger.error({ err: error }, 'Shutdown finished with an error');
        process.exitCode = 1;
      }
    })();
    void stopping.then(() => {
      process.exit();
    });
  };

  process.once('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('unhandledRejection', (reason: unknown) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection');
    process.exitCode = 1;
    shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (error: Error) => {
    logger.fatal({ err: error }, 'Uncaught exception');
    process.exitCode = 1;
    shutdown('uncaughtException');
  });

  try {
    await app.start();
    logger.info('Melody is logging in to Discord');
  } catch (error) {
    logger.fatal({ err: error }, 'Melody could not log in to Discord');
    process.exitCode = 1;
    shutdown('startup failed');
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'неизвестная ошибка';
  process.stderr.write(`Melody не смог запуститься: ${message}\n`);
  process.exitCode = 1;
});
