import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
const WINDOWS = path.join(ROOT, 'scripts', 'windows');
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const read = (file: string): Buffer => readFileSync(path.join(ROOT, file));
const powershellScripts = readdirSync(WINDOWS).filter((name) => name.endsWith('.ps1'));
const launchers = ['install.cmd', 'start.cmd', 'setup.cmd', 'update.cmd'];

function hasOnlyCrlf(content: Buffer): boolean {
  const text = content.toString('utf8');
  return !/(?<!\r)\n/u.test(text);
}

describe('Windows install scripts', () => {
  it('saves every script except the one-liner with a BOM, so Windows PowerShell 5.1 reads Cyrillic correctly', () => {
    for (const name of powershellScripts) {
      const startsWithBom = readFileSync(path.join(WINDOWS, name)).subarray(0, 3).equals(BOM);
      // bootstrap.ps1 is fetched by irm and run by iex, where a BOM is only a risk.
      expect(startsWithBom, name).toBe(name !== 'bootstrap.ps1');
    }
  });

  it('uses Windows line endings in every .ps1 and .cmd file', () => {
    for (const name of powershellScripts) {
      expect(hasOnlyCrlf(readFileSync(path.join(WINDOWS, name))), name).toBe(true);
    }
    for (const name of launchers) {
      expect(hasOnlyCrlf(read(name)), name).toBe(true);
    }
  });

  it('keeps the launchers in plain ASCII and points each one at an existing script', () => {
    for (const name of launchers) {
      const content = read(name);
      expect(
        [...content].every((byte) => byte < 0x80),
        name,
      ).toBe(true);
      const target = /scripts\\windows\\([a-z]+\.ps1)/u.exec(content.toString('ascii'))?.[1];
      expect(target, name).toBe(name.replace('.cmd', '.ps1'));
      expect(existsSync(path.join(WINDOWS, target ?? '')), name).toBe(true);
      expect(content.toString('ascii')).toContain('-ExecutionPolicy Bypass');
    }
  });

  it('lets update.cmd find the guide for a ZIP install, which has no source.txt', () => {
    const readme = read('README.md').toString('utf8');
    const branch =
      /raw\.githubusercontent\.com\/bohdanlomskyi\/vidbot\/(\S+?)\/scripts\/windows\/bootstrap\.ps1/u.exec(
        readme,
      )?.[1];
    const update = readFileSync(path.join(WINDOWS, 'update.ps1'), 'utf8');

    expect(branch).toBeDefined();
    expect(update).toContain(`'${branch ?? ''}'`);
  });

  it('opens the music folder with a plain ASCII launcher', () => {
    const content = read('music.cmd');

    expect([...content].every((byte) => byte < 0x80)).toBe(true);
    expect(hasOnlyCrlf(content)).toBe(true);
    expect(content.toString('ascii')).toContain('explorer');
  });

  it('downloads the Node.js version pinned in .nvmrc and installs without compiling', () => {
    const common = readFileSync(path.join(WINDOWS, 'common.ps1'), 'utf8');
    expect(common).toContain('.nvmrc');
    expect(common).toContain('SHASUMS256.txt');
    expect(common).toContain('npm.cmd ci --ignore-scripts');
    expect(common).toContain("npm.cmd rebuild '@discordjs/opus'");
    expect(read('.nvmrc').toString('utf8').trim()).toMatch(/^24\.\d+\.\d+$/u);
  });

  it('documents a one-line install that points at a script in this repository', () => {
    const readme = read('README.md').toString('utf8');
    const url =
      /irm (https:\/\/raw\.githubusercontent\.com\/bohdanlomskyi\/vidbot\/(\S+?)\/(scripts\/windows\/bootstrap\.ps1)) \| iex/u.exec(
        readme,
      );
    expect(url).not.toBeNull();
    expect(existsSync(path.join(ROOT, url?.[3] ?? ''))).toBe(true);
  });
});

describe('Linux and macOS install scripts', () => {
  it('are executable and use Unix line endings', () => {
    for (const name of ['install.sh', 'start.sh']) {
      expect(statSync(path.join(ROOT, name)).mode & 0o111, name).not.toBe(0);
      expect(read(name).includes(0x0d), name).toBe(false);
    }
  });
});

describe('ignored local state', () => {
  it('keeps downloaded tools out of git and the Docker build context', () => {
    expect(read('.gitignore').toString('utf8')).toMatch(/^\.tools\/$/mu);
    expect(read('.dockerignore').toString('utf8')).toMatch(/^\.tools$/mu);
  });
});
