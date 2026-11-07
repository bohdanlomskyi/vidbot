/**
 * Remembers, per server, the text channel where someone used the bot last. The player panel and
 * the chat messages about what the bot does go there, unless an administrator has fixed a
 * channel with /setup. It lives in memory: after a restart the next command sets it again.
 */
export class ChannelFollower {
  private readonly channels = new Map<string, string>();

  set(guildId: string, channelId: string): void {
    this.channels.set(guildId, channelId);
  }

  get(guildId: string): string | null {
    return this.channels.get(guildId) ?? null;
  }
}
