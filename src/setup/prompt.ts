import { spawn } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline/promises';
import { Writable } from 'node:stream';

const YES = new Set(['д', 'да', 'y', 'yes']);
const NO = new Set(['н', 'нет', 'n', 'no']);

/** Passes output to the terminal, except while a secret is being typed. */
class MaskableOutput extends Writable {
  muted = false;

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    if (!this.muted) {
      process.stdout.write(chunk);
    }
    callback();
  }
}

const output = new MaskableOutput();

interface LineReader {
  readonly rl: Interface;
  readonly queue: string[];
  readonly waiters: ((line: string | null) => void)[];
  ended: boolean;
}

let shared: LineReader | null = null;

/**
 * One readline for the whole wizard, with its own queue: lines that arrive before the next
 * question (pasted several at once, or piped in) wait for it instead of being dropped.
 */
function lineReader(): LineReader {
  if (shared !== null) {
    return shared;
  }
  const reader: LineReader = {
    rl: createInterface({
      input: process.stdin,
      output,
      terminal: process.stdin.isTTY && process.stdout.isTTY,
    }),
    queue: [],
    waiters: [],
    ended: false,
  };
  reader.rl.on('line', (line) => {
    const waiter = reader.waiters.shift();
    if (waiter === undefined) {
      reader.queue.push(line);
    } else {
      waiter(line);
    }
  });
  reader.rl.on('close', () => {
    reader.ended = true;
    for (const waiter of reader.waiters.splice(0)) {
      waiter(null);
    }
  });
  reader.rl.on('SIGINT', () => {
    process.stdout.write('\nНастройка прервана.\n');
    process.exit(130);
  });
  shared = reader;
  return reader;
}

async function readLine(promptText: string, beforeTyping?: () => void): Promise<string> {
  const reader = lineReader();
  if (reader.ended) {
    // Input already ended (piped in); answers may still be waiting in the queue.
    process.stdout.write(promptText);
  } else {
    reader.rl.setPrompt(promptText);
    reader.rl.prompt();
  }
  beforeTyping?.();
  const queued = reader.queue.shift();
  if (queued !== undefined) {
    return queued;
  }
  if (reader.ended) {
    throw new Error('Ввод закончился раньше, чем настройка.');
  }
  const line = await new Promise<string | null>((resolve) => {
    reader.waiters.push(resolve);
  });
  if (line === null) {
    throw new Error('Ввод закончился раньше, чем настройка.');
  }
  return line;
}

/** Releases the terminal so the process can exit. */
export function closePrompt(): void {
  shared?.rl.close();
  shared = null;
}

export async function ask(question: string, fallback = ''): Promise<string> {
  const suffix = fallback === '' ? '' : ` [${fallback}]`;
  const answer = (await readLine(`${question}${suffix}: `)).trim();
  return answer === '' ? fallback : answer;
}

export async function askYesNo(question: string, defaultYes: boolean): Promise<boolean> {
  for (;;) {
    const answer = (await ask(`${question} ${defaultYes ? '[Д/н]' : '[д/Н]'}`)).toLowerCase();
    if (answer === '') {
      return defaultYes;
    }
    if (YES.has(answer)) {
      return true;
    }
    if (NO.has(answer)) {
      return false;
    }
    process.stdout.write('Ответьте «д» (да) или «н» (нет).\n');
  }
}

/** Returns a 0-based index into `options`. */
export async function choose(
  question: string,
  options: readonly string[],
  defaultIndex: number,
): Promise<number> {
  options.forEach((option, index) => {
    process.stdout.write(`  ${String(index + 1)}. ${option}\n`);
  });
  for (;;) {
    const answer = await ask(question, String(defaultIndex + 1));
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && index >= 0 && index < options.length) {
      return index;
    }
    process.stdout.write(`Введите число от 1 до ${String(options.length)}.\n`);
  }
}

/** Reads a secret without echoing it. Paste works; the typed text is not shown at all. */
export async function askSecret(question: string): Promise<string> {
  try {
    return (
      await readLine(`${question} (ввод не отображается, это нормально): `, () => {
        output.muted = true;
      })
    ).trim();
  } finally {
    output.muted = false;
    process.stdout.write('\n');
  }
}

/** Opens a link in the default browser. Failure is harmless: the link is printed as well. */
export function openInBrowser(url: string): void {
  // No shell is involved, so characters such as & in the link are passed as they are.
  const [command, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // The link is on screen anyway.
  }
}
