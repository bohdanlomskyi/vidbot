import { type Client, Events, GatewayIntentBits, IntentsBitField } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { AppServices } from '../../../src/commands/context.js';
import { createClient, wireClient } from '../../../src/discord/bot.js';
import { routeInteraction } from '../../../src/interactions/router.js';

vi.mock('../../../src/interactions/router.js', () => ({
  routeInteraction: vi.fn(() => Promise.resolve()),
}));

type Listener = (...args: unknown[]) => void;

/** Records the listeners wireClient attaches so a test can fire them directly. */
function captureClient() {
  const listeners = new Map<string, Listener>();
  const register = (event: string, listener: Listener): typeof fake => {
    listeners.set(event, listener);
    return fake;
  };
  const fake = {
    on: vi.fn(register),
    once: vi.fn(register),
  };
  const emit = (event: string, ...args: unknown[]): void => {
    const listener = listeners.get(event);
    if (listener === undefined) {
      throw new Error(`No listener registered for ${event}`);
    }
    listener(...args);
  };
  return { client: fake as unknown as Client, emit };
}

function fakeServices() {
  const engine = {
    handleBotVoiceChange: vi.fn<(guildId: string, channelId: string | null) => Promise<void>>(() =>
      Promise.resolve(),
    ),
    handleListenersChanged: vi.fn<(guildId: string) => Promise<void>>(() => Promise.resolve()),
    voiceChannelOf: vi.fn<(guildId: string) => string | null>(() => 'channel-1'),
  };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { services: { engine, logger } as unknown as AppServices, engine, logger };
}

function voiceState(userId: string, channelId: string | null): unknown {
  return { id: userId, channelId, guild: { id: 'guild-1' }, client: { user: { id: 'bot-1' } } };
}

/** Lets the fire-and-forget handlers run to completion. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

describe('createClient', () => {
  it('requests only the guild and voice-state intents', () => {
    const client = createClient();
    const intents = new IntentsBitField(client.options.intents);

    expect(intents.has(GatewayIntentBits.Guilds)).toBe(true);
    expect(intents.has(GatewayIntentBits.GuildVoiceStates)).toBe(true);
    expect(intents.has(GatewayIntentBits.MessageContent)).toBe(false);
    expect(intents.has(GatewayIntentBits.GuildMembers)).toBe(false);
    expect(intents.has(GatewayIntentBits.GuildPresences)).toBe(false);
    expect(intents.has(GatewayIntentBits.GuildMessages)).toBe(false);
  });
});

describe('wireClient', () => {
  it('forwards every interaction to the router with the shared services', async () => {
    const { client, emit } = captureClient();
    const { services } = fakeServices();
    const interaction = { id: 'interaction-1' };
    wireClient(client, services);

    emit(Events.InteractionCreate, interaction);
    await flush();

    expect(routeInteraction).toHaveBeenCalledWith(interaction, services);
  });

  it('tells the engine when the bot itself is moved or disconnected', async () => {
    const { client, emit } = captureClient();
    const { services, engine } = fakeServices();
    wireClient(client, services);

    emit(
      Events.VoiceStateUpdate,
      voiceState('bot-1', 'channel-1'),
      voiceState('bot-1', 'channel-2'),
    );
    await flush();

    expect(engine.handleBotVoiceChange).toHaveBeenCalledWith('guild-1', 'channel-2');
    expect(engine.handleListenersChanged).not.toHaveBeenCalled();
  });

  it('counts a member joining or leaving the bot channel as a listener change', async () => {
    const { client, emit } = captureClient();
    const { services, engine } = fakeServices();
    wireClient(client, services);

    emit(Events.VoiceStateUpdate, voiceState('user-1', null), voiceState('user-1', 'channel-1'));
    emit(Events.VoiceStateUpdate, voiceState('user-1', 'channel-1'), voiceState('user-1', null));
    await flush();

    expect(engine.handleListenersChanged).toHaveBeenCalledTimes(2);
    expect(engine.handleListenersChanged).toHaveBeenCalledWith('guild-1');
    expect(engine.handleBotVoiceChange).not.toHaveBeenCalled();
  });

  it('ignores members moving between channels the bot is not in', async () => {
    const { client, emit } = captureClient();
    const { services, engine } = fakeServices();
    wireClient(client, services);

    emit(Events.VoiceStateUpdate, voiceState('user-1', null), voiceState('user-1', 'channel-7'));
    emit(
      Events.VoiceStateUpdate,
      voiceState('user-1', 'channel-7'),
      voiceState('user-1', 'channel-8'),
    );
    engine.voiceChannelOf.mockReturnValueOnce(null);
    emit(Events.VoiceStateUpdate, voiceState('user-2', null), voiceState('user-2', 'channel-1'));
    await flush();

    expect(engine.handleListenersChanged).not.toHaveBeenCalled();
  });

  it('ignores voice updates that do not change the channel, such as mute or deafen', async () => {
    const { client, emit } = captureClient();
    const { services, engine } = fakeServices();
    wireClient(client, services);

    emit(
      Events.VoiceStateUpdate,
      voiceState('user-1', 'channel-1'),
      voiceState('user-1', 'channel-1'),
    );
    await flush();

    expect(engine.handleListenersChanged).not.toHaveBeenCalled();
    expect(engine.handleBotVoiceChange).not.toHaveBeenCalled();
  });

  it('logs an engine failure instead of letting it escape the event handler', async () => {
    const { client, emit } = captureClient();
    const { services, engine, logger } = fakeServices();
    engine.handleListenersChanged.mockRejectedValueOnce(new Error('engine is shutting down'));
    wireClient(client, services);

    emit(Events.VoiceStateUpdate, voiceState('user-1', null), voiceState('user-1', 'channel-1'));
    await flush();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) as unknown }),
      expect.any(String),
    );
  });
});
