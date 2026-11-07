/**
 * Panel edits sent to Discord in a busy server while one track plays: members move between
 * other voice channels, someone mutes in the bot's channel, and a few refreshes are asked
 * for with nothing changed. Every edit is a Discord API request under a rate limit.
 * The engine, panel manager and gateway wiring are the real ones; only Discord is faked.
 *
 *   npx tsx bench/discordApi.bench.ts
 */
import { PassThrough } from 'node:stream';
import type { Client } from 'discord.js';
import type { AppServices } from '../src/commands/context.js';
import type { GuildSettingsRepository } from '../src/database/settingsRepository.js';
import { wireClient } from '../src/discord/bot.js';
import { PanelManager } from '../src/discord/ui/panelManager.js';
import { MusicEngine } from '../src/music/engine/musicEngine.js';

const GUILD = '100000000000000001';
const BOT_CHANNEL = '100000000000000002';
const wait = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

let edits = 0;
const channel = {
  id: '100000000000000003',
  guildId: GUILD,
  isTextBased: () => true,
  isDMBased: () => false,
  send: () => Promise.resolve({ id: '100000000000000004' }),
  messages: {
    edit: () => {
      edits += 1;
      return Promise.resolve();
    },
  },
};
const stored = { textChannelId: channel.id, panelMessageId: '100000000000000004' };
const settings = {
  get: () => ({ ...stored }),
  setPanel: () => undefined,
  clearPanelMessage: () => undefined,
};
const playback = {
  queueLimit: 100,
  maxTrackSec: 1800,
  idleTimeoutSec: 300,
  emptyTimeoutSec: 60,
  defaultVolume: 70,
  skipVotePercent: 0,
  stayConnected: false,
};

const handlers = new Map<string, (...args: unknown[]) => void>();
const client = {
  on: (event: string, handler: (...args: unknown[]) => void) => handlers.set(event, handler),
  once: (event: string, handler: (...args: unknown[]) => void) => handlers.set(event, handler),
  channels: { cache: new Map([[channel.id, channel]]) },
} as unknown as Client;

const holder: { panel?: PanelManager } = {};
const engine = new MusicEngine({
  voice: {
    connect: (_guildId, channelId) =>
      Promise.resolve({
        channelId,
        subscribe: () => undefined,
        onLost: () => undefined,
        destroy: () => undefined,
      }),
  },
  createPlayer: () => ({
    play: () => undefined,
    stop: () => undefined,
    pause: () => undefined,
    resume: () => undefined,
    setVolume: () => undefined,
    destroy: () => undefined,
  }),
  providers: () => ({
    kind: 'local',
    enabled: true,
    canHandle: () => true,
    resolve: () => Promise.resolve([]),
    validate: () => Promise.resolve(),
    getPlayableStream: () =>
      Promise.resolve({
        stream: new PassThrough(),
        ended: new Promise(() => undefined),
        close: () => Promise.resolve(),
      }),
    dispose: () => Promise.resolve(),
  }),
  listeners: () => 1,
  settings: () => playback,
  onChange: (snapshot) => {
    holder.panel?.requestRefresh(snapshot.guildId);
  },
});
const panel = new PanelManager({
  client,
  engine,
  settings: settings as unknown as GuildSettingsRepository,
  botName: 'Melody',
  logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  refreshDelayMs: 5,
});
holder.panel = panel;
const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
wireClient(client, { engine, logger, panel } as unknown as AppServices);

function voiceUpdate(userId: string, from: string | null, to: string | null): void {
  const state = (channelId: string | null) => ({
    id: userId,
    channelId,
    guild: { id: GUILD },
    client: { user: { id: 'bot' } },
  });
  handlers.get('voiceStateUpdate')?.(state(from), state(to));
}

await engine.enqueue({
  guildId: GUILD,
  voiceChannelId: BOT_CHANNEL,
  requesterId: 'user',
  tracks: [
    {
      source: 'local',
      sourceRef: 'a',
      title: 'Song',
      artist: null,
      durationSec: 200,
      thumbnailUrl: null,
      originalUrl: null,
      metadata: {},
    },
  ],
});
await wait(50);
edits = 0;

for (let index = 0; index < 20; index += 1) {
  voiceUpdate(`member-${String(index)}`, '100000000000000007', '100000000000000008');
  await wait(20);
}
for (let index = 0; index < 5; index += 1) {
  voiceUpdate('listener', BOT_CHANNEL, BOT_CHANNEL);
  await wait(20);
}
for (let index = 0; index < 3; index += 1) {
  panel.requestRefresh(GUILD);
  await wait(20);
}
await wait(100);
console.log(`Panel edits for 20 moves elsewhere, 5 mutes and 3 idle refreshes: ${String(edits)}`);
panel.dispose();
await engine.shutdown();
