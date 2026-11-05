import type { Client } from 'discord.js';

/**
 * Counts the people listening in a voice channel: members who are not bots and are not the
 * bot itself. The count comes from the voice state cache, so it needs no extra privileged
 * intent and makes no API call. Members whose bot flag is not cached are counted as people.
 */
export function countListeners(client: Client, guildId: string, channelId: string): number {
  const guild = client.guilds.cache.get(guildId);
  if (guild === undefined) {
    return 0;
  }
  let count = 0;
  for (const state of guild.voiceStates.cache.values()) {
    if (state.channelId !== channelId || state.id === client.user?.id) {
      continue;
    }
    if (state.member?.user.bot === true) {
      continue;
    }
    count += 1;
  }
  return count;
}
