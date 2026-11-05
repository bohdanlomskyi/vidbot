import { Routes } from 'discord.js';
import { COMMAND_DEFINITIONS } from './definitions.js';

export interface RegistrationTarget {
  readonly clientId: string;
  readonly guildId: string | null;
}

export interface RegistrationPlan {
  /** Guild registration takes effect at once. Global registration can take up to an hour to appear. */
  readonly scope: 'guild' | 'global';
  readonly route: `/${string}`;
  readonly body: ReturnType<(typeof COMMAND_DEFINITIONS)[number]['toJSON']>[];
}

/**
 * Chooses where the commands are registered and builds the request body. A configured guild
 * gets guild commands, which appear immediately. Otherwise the commands are global.
 */
export function buildRegistration(
  target: RegistrationTarget,
  options: { readonly global: boolean },
): RegistrationPlan {
  const body = COMMAND_DEFINITIONS.map((command) => command.toJSON());
  if (!options.global && target.guildId !== null) {
    return {
      scope: 'guild',
      route: Routes.applicationGuildCommands(target.clientId, target.guildId),
      body,
    };
  }
  return { scope: 'global', route: Routes.applicationCommands(target.clientId), body };
}
