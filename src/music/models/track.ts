export type SourceKind = 'local' | 'stream' | 'youtube';

/** Values stored in `Track.metadata`. Never put secrets, tokens or stream URLs here. */
export type MetadataValue = string | number | boolean | null;

/** What a provider returns about a track. The queue adds identity and the requester. */
export interface TrackDraft {
  readonly source: SourceKind;
  /** Stable provider reference: a library identifier, a catalog identifier, or a video identifier. */
  readonly sourceRef: string;
  readonly title: string;
  readonly artist: string | null;
  /** Null for live streams with no fixed length. */
  readonly durationSec: number | null;
  readonly thumbnailUrl: string | null;
  /** Only URLs that are safe to show in Discord. Stream URLs are never stored here. */
  readonly originalUrl: string | null;
  readonly metadata: Readonly<Record<string, MetadataValue>>;
}

/** A queued track with its unique entry identifier, requester and creation time. */
export interface Track extends TrackDraft {
  readonly id: string;
  readonly requesterId: string;
  readonly createdAt: number;
}
