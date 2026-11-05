import { LibraryCatalog } from '../audio/library/catalog.js';
import { probeAudioFile } from '../audio/pipeline/probe.js';
import { loadDotEnv } from '../app/env.js';
import { loadConfig } from '../config/load.js';
import { openDatabase } from '../database/db.js';
import { LibraryRepository } from '../database/libraryRepository.js';
import { migrate } from '../database/migrations.js';

/** Rescans the music directory and updates the library catalog in the database. */
async function main(): Promise<void> {
  loadDotEnv(process.cwd());
  const config = loadConfig(process.env, process.cwd());
  const db = openDatabase(config.paths.databaseFile);
  migrate(db);
  try {
    const catalog = new LibraryCatalog({
      musicDir: config.paths.musicDir,
      store: new LibraryRepository(db),
      probe: (absolutePath) => probeAudioFile(config.ffmpeg.ffprobePath, absolutePath),
    });
    const summary = await catalog.refresh();
    process.stdout.write(
      `Просмотрено файлов: ${String(summary.scanned)}, обновлено: ${String(summary.updated)}, ` +
        `удалено из каталога: ${String(summary.removed)}, всего треков: ${String(summary.total)}.\n`,
    );
    if (summary.truncated) {
      process.stdout.write('Внимание: сканирование остановлено по лимиту количества файлов.\n');
    }
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Сканирование не выполнено: ${error instanceof Error ? error.message : 'неизвестная ошибка'}\n`,
  );
  process.exitCode = 1;
});
