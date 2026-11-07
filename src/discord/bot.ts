import { Client, Events, GatewayIntentBits, Options, type VoiceState } from 'discord.js';
import type { AppServices } from '../commands/context.js';
import { routeInteraction } from '../interactions/router.js';

/**
 * The Discord client asks for non-privileged intents only: guild metadata, voice states, and
 * guild message events. It does not request the message content intent, members or presences,
 * so it never receives what people type outside commands. Message events are used for one
 * thing: knowing which message in a channel is the newest, so the player panel can stay at the
 * bottom of the chat. No message is kept in memory.
 */
export function createClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
    ],
    makeCache: Options.cacheWithLimits({ ...Options.DefaultMakeCacheSettings, MessageManager: 0 }),
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
    if (oldState.channelId === newState.channelId) {
      return;
    }
    // Only the bot's own channel matters. Moves elsewhere in a busy server would otherwise
    // re-check timers and redraw the panel for nothing.
    const botChannel = services.engine.voiceChannelOf(guildId);
    if (
      botChannel !== null &&
      (oldState.channelId === botChannel || newState.channelId === botChannel)
    ) {
      await services.engine.handleListenersChanged(guildId);
    }
  } catch (error) {
    services.logger.error({ err: error }, 'Voice state handling failed');
  }
}
