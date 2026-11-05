import { Events, type Client } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { createClient } from '../../src/discord/bot.js';

/**
 * Live checks against the real Discord gateway. They are skipped unless MELODY_LIVE_TESTS=1
 * and DISCORD_TOKEN are set. They never run in continuous integration by default, and they
 * never print the token. See tests/live/README.md for the setup steps.
 */
const token = process.env.DISCORD_TOKEN ?? '';
const enabled = process.env.MELODY_LIVE_TESTS === '1' && token !== '';
const guildId = process.env.DISCORD_GUILD_ID ?? '';
const voiceChannelId = process.env.MELODY_LIVE_VOICE_CHANNEL_ID ?? '';

function waitForReady(client: Client, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('The client did not become ready in time.'));
    }, timeoutMs);
    client.once(Events.ClientReady, () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe.skipIf(!enabled)('live Discord gateway', () => {
  it('logs in with the configured token and sees the configured guild', async () => {
    const client = createClient();
    try {
      const ready = waitForReady(client, 60_000);
      await client.login(token);
      await ready;

      expect(client.user).not.toBeNull();
      if (guildId !== '') {
        await client.guilds.fetch(guildId);
        expect(client.guilds.cache.has(guildId)).toBe(true);
      }
    } finally {
      await client.destroy();
    }
  }, 120_000);
});

describe.skipIf(!enabled || guildId === '' || voiceChannelId === '')(
  'live voice connection',
  () => {
    it('joins the configured voice channel with DAVE and reaches the ready state', async () => {
      // The voice path is exercised by the engine in production. This test only checks that the
      // connection reaches the ready state, which requires the DAVE handshake with Discord.
      const { DiscordVoicePort } = await import('../../src/discord/voice/discordVoice.js');
      const client = createClient();
      try {
        const ready = waitForReady(client, 60_000);
        await client.login(token);
        await ready;

        const port = new DiscordVoicePort(client, { info: () => undefined, warn: () => undefined });
        const connection = await port.connect(guildId, voiceChannelId);
        expect(connection.channelId).toBe(voiceChannelId);
        connection.destroy();
      } finally {
        await client.destroy();
      }
    }, 180_000);
  },
);
