import { PassThrough, type Readable } from 'node:stream';
import type {
  AudioProvider,
  PlaybackEnd,
  PlayableSource,
} from '../../src/audio/providers/types.js';
import type { Track, TrackDraft } from '../../src/music/models/track.js';
import type {
  AudioPlayerPort,
  EngineEvent,
  GuildPlaybackSettings,
  PlaybackCallbacks,
  VoiceConnectionPort,
  VoiceLossReason,
  VoicePort,
} from '../../src/music/ports.js';
import { MusicEngine } from '../../src/music/engine/musicEngine.js';
import type { GuildSnapshot } from '../../src/music/engine/snapshot.js';
import { AppError } from '../../src/utils/errors.js';

/** A voice connection that records subscriptions and lets a test simulate losing it. */
export class FakeConnection implements VoiceConnectionPort {
  subscribedTo: AudioPlayerPort | null = null;
  destroyed = false;
  private readonly lossHandlers: ((reason: VoiceLossReason) => void)[] = [];

  constructor(readonly channelId: string) {}

  subscribe(player: AudioPlayerPort): void {
    this.subscribedTo = player;
  }

  onLost(handler: (reason: VoiceLossReason) => void): void {
    this.lossHandlers.push(handler);
  }

  destroy(): void {
    this.destroyed = true;
    this.subscribedTo = null;
  }

  loseConnection(reason: VoiceLossReason = 'disconnected'): void {
    for (const handler of this.lossHandlers) {
      handler(reason);
    }
  }
}

/** Voice port whose next `failures` connection attempts are rejected. */
export class FakeVoice implements VoicePort {
  readonly connections: FakeConnection[] = [];
  failures = 0;

  connect(_guildId: string, channelId: string): Promise<VoiceConnectionPort> {
    if (this.failures > 0) {
      this.failures -= 1;
      return Promise.reject(new Error('Missing permissions'));
    }
    const connection = new FakeConnection(channelId);
    this.connections.push(connection);
    return Promise.resolve(connection);
  }

  get active(): FakeConnection[] {
    return this.connections.filter((connection) => !connection.destroyed);
  }
}

/** Audio player that exposes the callbacks of each resource so tests can drive it. */
export class FakePlayer implements AudioPlayerPort {
  readonly played: { readonly stream: Readable; readonly callbacks: PlaybackCallbacks }[] = [];
  status: 'idle' | 'playing' | 'paused' = 'idle';
  gain = 1;
  stops = 0;
  destroyed = false;

  get current(): { readonly stream: Readable; readonly callbacks: PlaybackCallbacks } | undefined {
    return this.played.at(-1);
  }

  play(stream: Readable, callbacks: PlaybackCallbacks): void {
    this.played.push({ stream, callbacks });
    this.status = 'playing';
  }

  stop(): void {
    this.stops += 1;
    this.status = 'idle';
  }

  pause(): void {
    this.status = 'paused';
  }

  resume(): void {
    this.status = 'playing';
  }

  setVolume(gain: number): void {
    this.gain = gain;
  }

  destroy(): void {
    this.destroyed = true;
  }

  emitStart(): void {
    this.current?.callbacks.onStart();
  }

  emitEnd(): void {
    this.current?.callbacks.onEnd();
  }
}

/** A playable source whose end is controlled by the test. */
export class FakePlayable implements PlayableSource {
  readonly stream: Readable = new PassThrough();
  closed = false;
  readonly ended: Promise<PlaybackEnd>;
  private resolveEnded: (end: PlaybackEnd) => void = () => undefined;

  constructor(readonly title: string) {
    this.ended = new Promise<PlaybackEnd>((resolve) => {
      this.resolveEnded = resolve;
    });
  }

  finish(status: 'completed' | 'failed' = 'completed'): void {
    this.resolveEnded(
      status === 'completed'
        ? { status: 'completed' }
        : { status: 'failed', message: 'Поток прервался.' },
    );
  }

  close(): Promise<void> {
    this.closed = true;
    this.resolveEnded({ status: 'stopped' });
    return Promise.resolve();
  }
}

/** Provider that opens FakePlayable sources and can refuse titles. */
export class FakeProvider implements AudioProvider {
  readonly kind = 'local' as const;
  readonly enabled = true;
  readonly opened: FakePlayable[] = [];
  readonly failTitles = new Set<string>();

  canHandle(): boolean {
    return true;
  }

  resolve(): Promise<readonly TrackDraft[]> {
    return Promise.reject(new Error('resolve is not used by the engine'));
  }

  validate(): Promise<void> {
    return Promise.resolve();
  }

  getPlayableStream(track: Track, signal: AbortSignal): Promise<PlayableSource> {
    if (signal.aborted) {
      return Promise.reject(new AppError('CANCELLED', 'Воспроизведение отменено.'));
    }
    if (this.failTitles.has(track.title)) {
      return Promise.reject(new AppError('SOURCE_UNAVAILABLE', 'Файл недоступен.'));
    }
    const playable = new FakePlayable(track.title);
    this.opened.push(playable);
    return Promise.resolve(playable);
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

export const DEFAULT_SETTINGS: GuildPlaybackSettings = {
  queueLimit: 100,
  maxTrackSec: 1800,
  idleTimeoutSec: 300,
  emptyTimeoutSec: 60,
  defaultVolume: 70,
  skipVotePercent: 0,
};

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

export function draft(title: string, durationSec: number | null = 200): TrackDraft {
  return {
    source: 'local',
    sourceRef: title,
    title,
    artist: null,
    durationSec,
    thumbnailUrl: null,
    originalUrl: null,
    metadata: {},
  };
}

export interface Harness {
  readonly engine: MusicEngine;
  readonly voice: FakeVoice;
  readonly players: FakePlayer[];
  readonly provider: FakeProvider;
  readonly events: EngineEvent[];
  readonly settings: GuildPlaybackSettings;
  setListeners(count: number): void;
}

export function createHarness(overrides: Partial<GuildPlaybackSettings> = {}): Harness {
  const voice = new FakeVoice();
  const players: FakePlayer[] = [];
  const provider = new FakeProvider();
  const events: EngineEvent[] = [];
  const settings: GuildPlaybackSettings = { ...DEFAULT_SETTINGS, ...overrides };
  let listeners = 0;

  const engine = new MusicEngine({
    voice,
    createPlayer: () => {
      const player = new FakePlayer();
      players.push(player);
      return player;
    },
    providers: (kind) => (kind === 'local' ? provider : undefined),
    listeners: () => listeners,
    settings: () => settings,
    onChange: () => undefined,
    onEvent: (event) => {
      events.push(event);
    },
    logger: silentLogger,
    random: () => 0,
    now: () => Date.now(),
  });

  return {
    engine,
    voice,
    players,
    provider,
    events,
    settings,
    setListeners: (count: number) => {
      listeners = count;
    },
  };
}

/** Lets pending promise callbacks run. Real timers are not faked, so setImmediate works. */
export function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

export type { GuildSnapshot };
