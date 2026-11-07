import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { liftOldLimits } from '../setup/envFile.js';

/**
 * Loads `.env` from the working directory when the file exists. Variables that are already set
 * in the environment win, so container and shell settings always override the file.
 *
 * Older versions copied length and size limits into `.env` (15 minutes for YouTube, 30 for a
 * track). A line that still holds such an old default is replaced by the current one first, so
 * an update lifts those limits without the owner editing the file. A value the owner changed is
 * kept. When the file cannot be written, the new values are used for this run only.
 */
export function loadDotEnv(cwd: string): boolean {
  const file = resolve(cwd, '.env');
  if (!existsSync(file)) {
    return false;
  }
  const original = readFileSync(file, 'utf8');
  const lifted = liftOldLimits(original);
  if (lifted.changed.length > 0) {
    try {
      writeFileSync(file, lifted.text, 'utf8');
    } catch {
      const values = new Map(
        lifted.text
          .split(/\r?\n/u)
          .map((line) => line.split('=', 2))
          .filter((pair): pair is [string, string] => pair.length === 2),
      );
      for (const key of lifted.changed) {
        process.env[key] ??= values.get(key);
      }
    }
  }
  process.loadEnvFile(file);
  return true;
}
