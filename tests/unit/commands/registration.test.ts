import { describe, expect, it } from 'vitest';
import { COMMAND_DEFINITIONS } from '../../../src/commands/definitions.js';
import { buildRegistration } from '../../../src/commands/registration.js';

const CLIENT = '123456789012345678';
const GUILD = '223456789012345678';

describe('buildRegistration', () => {
  it('targets the configured guild when a guild id is set', () => {
    const plan = buildRegistration({ clientId: CLIENT, guildId: GUILD }, { global: false });

    expect(plan.scope).toBe('guild');
    expect(plan.route).toBe(`/applications/${CLIENT}/guilds/${GUILD}/commands`);
  });

  it('registers globally when no guild id is configured', () => {
    const plan = buildRegistration({ clientId: CLIENT, guildId: null }, { global: false });

    expect(plan.scope).toBe('global');
    expect(plan.route).toBe(`/applications/${CLIENT}/commands`);
  });

  it('registers globally when the global flag is passed, even if a guild is configured', () => {
    const plan = buildRegistration({ clientId: CLIENT, guildId: GUILD }, { global: true });

    expect(plan.scope).toBe('global');
    expect(plan.route).toBe(`/applications/${CLIENT}/commands`);
  });

  it('sends every command definition, in order', () => {
    const plan = buildRegistration({ clientId: CLIENT, guildId: GUILD }, { global: false });

    expect(plan.body.map((command) => command.name)).toEqual(
      COMMAND_DEFINITIONS.map((command) => command.name),
    );
  });
});
