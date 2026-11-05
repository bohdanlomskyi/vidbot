import { describe, expect, it } from 'vitest';
import { COMMAND_DEFINITIONS } from '../../src/commands/definitions.js';

interface JsonOption {
  readonly name: string;
  readonly description: string;
  readonly options?: readonly JsonOption[];
}

function allOptions(options: readonly JsonOption[] = []): JsonOption[] {
  return options.flatMap((option) => [option, ...allOptions(option.options)]);
}

describe('slash command definitions', () => {
  const commands = COMMAND_DEFINITIONS.map((definition) => definition.toJSON());

  it('stay within Discord naming rules and the 100-character description limit', () => {
    for (const command of commands) {
      expect(command.name).toMatch(/^[a-z0-9_-]{1,32}$/);
      expect(command.description.length).toBeGreaterThan(0);
      expect(command.description.length).toBeLessThanOrEqual(100);
      for (const option of allOptions(command.options)) {
        expect(option.description.length).toBeLessThanOrEqual(100);
      }
    }
  });

  it('register no more than the 100 top-level commands Discord allows', () => {
    expect(commands.length).toBeLessThanOrEqual(100);
    expect(new Set(commands.map((command) => command.name)).size).toBe(commands.length);
  });

  it('restricts setup and settings to members with Manage Server by default', () => {
    const manageGuild = '32';
    const admin = commands.filter(
      (command) => command.name === 'setup' || command.name === 'settings',
    );

    expect(admin).toHaveLength(2);
    for (const command of admin) {
      expect(command.default_member_permissions).toBe(manageGuild);
    }
  });

  it('keeps option and choice counts within Discord limits', () => {
    const everything = commands.flatMap((command) => [
      command,
      ...allOptions(command.options),
    ]) as readonly {
      readonly options?: readonly unknown[];
      readonly choices?: readonly unknown[];
    }[];

    for (const node of everything) {
      expect(node.options?.length ?? 0).toBeLessThanOrEqual(25);
      expect(node.choices?.length ?? 0).toBeLessThanOrEqual(25);
    }
  });

  it('writes every top-level description in Russian', () => {
    for (const command of commands) {
      expect(command.description).toMatch(/[А-Яа-яЁё]/u);
    }
  });

  it('exposes every command required by the specification', () => {
    const names = new Set(commands.map((command) => command.name));
    const required = [
      'play',
      'pause',
      'resume',
      'skip',
      'stop',
      'queue',
      'nowplaying',
      'remove',
      'clear',
      'shuffle',
      'loop',
      'volume',
      'join',
      'leave',
      'help',
      'status',
      'setup',
      'settings',
      'playlist',
      'move',
      'history',
      'replay',
    ];

    for (const name of required) {
      expect(names.has(name)).toBe(true);
    }
  });
});
