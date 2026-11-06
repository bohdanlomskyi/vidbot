/**
 * Edits a `.env` file the way a person would: a key that already has a line gets its value
 * replaced on that line, and comments, blank lines and the order of keys stay as they were.
 * Values are written so that Node's own parser (process.loadEnvFile) reads them back exactly.
 */

const KEY_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u;
const PLAIN_VALUE = /^[A-Za-z0-9_./:@+-]*$/u;

/**
 * Plain values stay bare. Anything else is single-quoted, where Node keeps backslashes and
 * spaces literally, which matters for Windows paths such as C:\new\ffmpeg.exe.
 */
export function formatEnvValue(value: string): string {
  if (/[\r\n]/u.test(value)) {
    throw new RangeError('A .env value cannot contain a line break');
  }
  if (PLAIN_VALUE.test(value)) {
    return value;
  }
  if (!value.includes("'")) {
    return `'${value}'`;
  }
  if (!value.includes('`')) {
    return `\`${value}\``;
  }
  throw new RangeError('A .env value cannot contain both kinds of quotes');
}

export function updateEnvText(text: string, updates: Readonly<Record<string, string>>): string {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/u);
  const pending = new Map(Object.entries(updates));

  for (let index = 0; index < lines.length; index += 1) {
    const key = KEY_LINE.exec(lines[index] ?? '')?.[1];
    if (key === undefined || !pending.has(key)) {
      continue;
    }
    lines[index] = `${key}=${formatEnvValue(pending.get(key) ?? '')}`;
    pending.delete(key);
  }

  if (pending.size > 0) {
    // Keep the final newline at the very end of the file.
    const trailing = lines.at(-1) === '' ? lines.pop() : undefined;
    for (const [key, value] of pending) {
      lines.push(`${key}=${formatEnvValue(value)}`);
    }
    if (trailing !== undefined) {
      lines.push(trailing);
    }
  }
  return lines.join(newline);
}
