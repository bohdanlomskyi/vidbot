import { randomBytes } from 'node:crypto';
import type { TrackDraft } from '../music/models/track.js';

const TTL_MS = 120_000;
const MAX_PENDING = 200;

interface Pending {
  readonly guildId: string;
  readonly userId: string;
  readonly voiceChannelId: string;
  readonly tracks: readonly TrackDraft[];
  /** Queue the tracks in front of the waiting ones. Set by /play with "next". */
  readonly playNext?: boolean;
  readonly expiresAt: number;
}

/**
 * Playlists waiting for confirmation. Entries expire after two minutes, the map is bounded,
 * and each token is bound to one guild and one user, so nobody can confirm someone else's list.
 */
export class PendingPlaylists {
  private readonly items = new Map<string, Pending>();

  constructor(private readonly now: () => number = Date.now) {}

  add(entry: Omit<Pending, 'expiresAt'>): string {
    this.sweep();
    if (this.items.size >= MAX_PENDING) {
      const oldest = this.items.keys().next().value;
      if (oldest !== undefined) {
        this.items.delete(oldest);
      }
    }
    const token = randomBytes(6).toString('base64url');
    this.items.set(token, { ...entry, expiresAt: this.now() + TTL_MS });
    return token;
  }

  /**
   * Returns the entry only to its owner in its guild, and removes it only then. A mismatched or
   * unknown token returns null and leaves any stored entry in place.
   */
  take(token: string, guildId: string, userId: string): Pending | null {
    this.sweep();
    const entry = this.items.get(token);
    if (entry === undefined || entry.guildId !== guildId || entry.userId !== userId) {
      return null;
    }
    this.items.delete(token);
    return entry;
  }

  /** Like `take`, but keeps the entry so a failed attempt can be repeated. */
  peek(token: string, guildId: string, userId: string): Pending | null {
    this.sweep();
    const entry = this.items.get(token);
    return entry === undefined || entry.guildId !== guildId || entry.userId !== userId
      ? null
      : entry;
  }

  remove(token: string): void {
    this.items.delete(token);
  }

  private sweep(): void {
    const now = this.now();
    for (const [token, entry] of this.items) {
      if (entry.expiresAt <= now) {
        this.items.delete(token);
      }
    }
  }
}
