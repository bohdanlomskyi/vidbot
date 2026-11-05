import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Loads `.env` from the working directory when the file exists. Variables that are already set
 * in the environment win, so container and shell settings always override the file.
 */
export function loadDotEnv(cwd: string): boolean {
  const file = resolve(cwd, '.env');
  if (!existsSync(file)) {
    return false;
  }
  process.loadEnvFile(file);
  return true;
}
