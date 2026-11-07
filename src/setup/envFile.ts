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

/**
 * Limits that older versions wrote into `.env` from `.env.example`, with the value each one
 * had then and the value that replaces it. Only a line that still holds the old value changes,
 * so a limit the owner chose on purpose is kept.
 */
const OLD_LIMITS: readonly (readonly [key: string, old: string, current: string])[] = [
  ['MAX_TRACK_DURATION_SEC', '1800', '0'],
  ['YOUTUBE_MAX_DURATION_SEC', '900', '0'],
  ['UPLOAD_MAX_MB', '25', '500'],
  ['UPLOAD_QUOTA_MB', '2000', '20000'],
  ['STREAM_MAX_BYTES', '536870912', '4294967296'],
];

/** Comments from older `.env.example` files that no longer describe the limits correctly. */
const OLD_COMMENTS: Readonly<Record<string, string>> = {
  '# Максимальная длительность одного трека в секундах (60–21600).':
    '# Максимальная длительность одного трека в секундах: 0 — без ограничения, иначе от 60.',
};

/** Replaces the old shipped limits in a `.env` text. Returns the new text and the changed keys. */
export function liftOldLimits(text: string): { text: string; changed: string[] } {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const changed: string[] = [];
  const lines = text.split(/\r?\n/u).map((line) => {
    const comment = OLD_COMMENTS[line.trim()];
    if (comment !== undefined) {
      return comment;
    }
    const key = KEY_LINE.exec(line)?.[1];
    const limit = OLD_LIMITS.find(([name]) => name === key);
    if (limit === undefined) {
      return line;
    }
    const [name, old, current] = limit;
    const value = line.slice(line.indexOf('=') + 1).trim();
    if (value !== old) {
      return line;
    }
    changed.push(name);
    return `${name}=${current}`;
  });
  return { text: lines.join(newline), changed };
}
