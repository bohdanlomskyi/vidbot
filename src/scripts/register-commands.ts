import { REST } from 'discord.js';
import { loadDotEnv } from '../app/env.js';
import { buildRegistration } from '../commands/registration.js';
import { loadConfig } from '../config/load.js';

/**
 * Registers the slash commands with Discord. Pass --global to register them for every server,
 * even when DISCORD_GUILD_ID is set. Re-running it is safe, because the whole set is replaced.
 */
async function main(): Promise<void> {
  loadDotEnv(process.cwd());
  const config = loadConfig(process.env, process.cwd());
  const plan = buildRegistration(config.discord, { global: process.argv.includes('--global') });

  const rest = new REST({ version: '10' }).setToken(config.discord.token);
  const result: unknown = await rest.put(plan.route, { body: plan.body });
  const count = Array.isArray(result) ? result.length : 0;
  const scope = plan.scope === 'guild' ? 'на сервере' : 'глобально';
  process.stdout.write(`Команд зарегистрировано: ${String(count)} (${scope}).\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'неизвестная ошибка';
  process.stderr.write(`Регистрация не выполнена: ${message}\n`);
  process.exitCode = 1;
});
