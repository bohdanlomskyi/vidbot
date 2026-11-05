import { Client, Events, GatewayIntentBits, type VoiceState } from 'discord.js';
import type { AppServices } from '../commands/context.js';
import { routeInteraction } from '../interactions/router.js';

/**
 * The Discord client asks for two non-privileged intents only: guild metadata and voice
 * states. It does not request the message content intent or member presence, and it never
 * reads messages, so it cannot see what people type outside commands.
 */
export function createClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    allowedMentions: { parse: [] },
  });
}

export function wireClient(client: Client, services: AppServices): void {
  client.once(Events.ClientReady, (ready) => {
    services.logger.info({ guilds: ready.guilds.cache.size }, 'Discord client is ready');
  });
  client.on(Events.InteractionCreate, (interaction) => {
    void routeInteraction(interaction, services);
  });
  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    void onVoiceStateUpdate(oldState, newState, services);
  });
  client.on(Events.Error, (error) => {
    services.logger.error({ err: error }, 'Discord client error');
  });
  client.on(Events.ShardDisconnect, () => {
    services.logger.warn('Discord gateway disconnected; discord.js will reconnect');
  });
}

async function onVoiceStateUpdate(
  oldState: VoiceState,
  newState: VoiceState,
  services: AppServices,
): Promise<void> {
  try {
    const guildId = newState.guild.id;
    if (newState.id === newState.client.user.id) {
      await services.engine.handleBotVoiceChange(guildId, newState.channelId);
      return;
    }
    if (oldState.channelId !== newState.channelId) {
      await services.engine.handleListenersChanged(guildId);
    }
  } catch (error) {
    services.logger.error({ err: error }, 'Voice state handling failed');
  }
}
