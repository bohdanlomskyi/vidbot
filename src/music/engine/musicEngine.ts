import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { PlayableSource } from '../../audio/providers/types.js';
import type { AudioProvider } from '../../audio/providers/types.js';
import { AppError, toUserMessage } from '../../utils/errors.js';
import { KeyedMutex } from '../../utils/keyedMutex.js';
import type { Track, TrackDraft } from '../models/track.js';
import type {
  AudioPlayerPort,
  EngineEvent,
  LeaveReason,
  ListenerCounter,
  LoopMode,
  ProviderLookup,
  SettingsSource,
  VoiceConnectionPort,
  VoiceLossReason,
  VoicePort,
} from '../ports.js';
import { type CurrentPlayback, GuildSession, type StartResult } from '../session/guildSession.js';
import type { PlaybackState } from '../session/playbackState.js';
import type { GuildSnapshot } from './snapshot.js';

export interface EnqueueRequest {
  readonly guildId: string;
  readonly voiceChannelId: string;
  readonly requesterId: string;
  readonly tracks: readonly TrackDraft[];
}

export interface EnqueueResult {
  readonly positions: readonly number[];
  /** True when the first added track started playing straight away. */
  readonly startedNow: boolean;
  /** Why the first added track could not start, when the bot was idle and it failed. */
  readonly failure: string | null;
}

export interface SkipVoteResult {
  readonly skipped: boolean;
  readonly votes: number;
  readonly required: number;
}

export type EngineLogger = Pick<Logger, 'info' | 'warn' | 'error' | 'debug'>;

export interface MusicEngineOptions {
  readonly voice: VoicePort;
  readonly createPlayer: () => AudioPlayerPort;
  readonly providers: ProviderLookup;
  readonly listeners: ListenerCounter;
  readonly settings: SettingsSource;
  readonly onChange: (snapshot: GuildSnapshot) => void;
  readonly onEvent?: (event: EngineEvent) => void;
  readonly logger?: EngineLogger;
  readonly random?: () => number;
  readonly now?: () => number;
  /** Longest wait for a source to open before the track is given up. */
  readonly bufferTimeoutMs?: number;
}

const BUFFER_TIMEOUT_MS = 20_000;
const BUFFER_TIMEOUT_MESSAGE = 'Не удалось начать воспроизведение вовремя.';
/** Pauses between voice reconnection attempts. The list length is the attempt limit. */
const RECONNECT_DELAYS_MS: readonly number[] = [1_000, 3_000, 8_000];
const NOTHING_PLAYING = 'Сейчас ничего не играет.';

/** What opening a source produced. Loading runs outside the guild lock. */
type LoadOutcome =
  | { readonly kind: 'opened'; readonly playable: PlayableSource }
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'timeout' };

const NOOP_LOGGER: EngineLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

/**
 * Coordinates playback for every guild. Each public operation runs under a per-guild lock,
 * so commands and playback events for one guild are applied one at a time, in arrival order.
 * Guilds never share state. Opening a source, which can take seconds for a network source,
 * runs outside the lock: commands keep working while the next track loads, and the result is
 * applied under the lock only if that track is still current. Events from the player and the
 * voice connection are handled in the background, and a failure there is logged, never thrown.
 */
export class MusicEngine {
  private readonly sessions = new Map<string, GuildSession>();
  private readonly lock = new KeyedMutex();
  private readonly log: EngineLogger;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly bufferTimeoutMs: number;
  private stopped = false;

  constructor(private readonly options: MusicEngineOptions) {
    this.log = options.logger ?? NOOP_LOGGER;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.bufferTimeoutMs = options.bufferTimeoutMs ?? BUFFER_TIMEOUT_MS;
  }

  // ---------- commands ----------

  /**
   * Adds tracks. When the bot was idle, it waits (without holding the guild) until the first
   * track has started or failed, so the caller can report what really happened.
   */
  async enqueue(request: EnqueueRequest): Promise<EnqueueResult> {
    const { positions, loading } = await this.locked(request.guildId, () =>
      this.doEnqueue(request),
    );
    if (loading === null) {
      return { positions, startedNow: false, failure: null };
    }
    const result = await loading.start.promise;
    return {
      positions,
      startedNow: result.outcome === 'started',
      failure: result.outcome === 'failed' ? result.message : null,
    };
  }

  pause(guildId: string): Promise<void> {
    return this.locked(guildId, () => {
      const session = this.requireSession(guildId);
      const playback = session.current;
      if (playback === null || session.state !== 'playing') {
        throw new AppError('INVALID_INPUT', 'Сейчас нечего ставить на паузу.');
      }
      session.player.pause();
      this.accumulate(playback);
      this.setState(session, 'paused');
      this.afterChange(session);
      return Promise.resolve();
    });
  }

  resume(guildId: string): Promise<void> {
    return this.locked(guildId, () => {
      const session = this.requireSession(guildId);
      const playback = session.current;
      if (playback === null || session.state !== 'paused') {
        throw new AppError('INVALID_INPUT', 'Воспроизведение сейчас не на паузе.');
      }
      session.player.resume();
      playback.playingSince = this.now();
      this.setState(session, 'playing');
      this.afterChange(session);
      return Promise.resolve();
    });
  }

  /** Skips the current track. Returns null when a track that was still loading was cancelled. */
  skip(guildId: string): Promise<Track | null> {
    return this.locked(guildId, async () => {
      const session = this.requireSession(guildId);
      const skipped = await this.discardCurrent(session, true);
      if (skipped === null && session.queue.size === 0 && session.pendingReplay === null) {
        throw new AppError('NOT_FOUND', NOTHING_PLAYING);
      }
      this.playNext(session);
      this.afterChange(session);
      return skipped;
    });
  }

  /** Counts a listener's vote. Skips when the guild's threshold is reached. */
  voteSkip(guildId: string, userId: string): Promise<SkipVoteResult> {
    return this.locked(guildId, async () => {
      const session = this.requireSession(guildId);
      if (session.current === null) {
        throw new AppError('NOT_FOUND', NOTHING_PLAYING);
      }
      const settings = this.options.settings(guildId);
      const required = Math.max(1, Math.ceil((this.listenersOf(session) * settings.skipVotePercent) / 100));
      session.votes.add(userId);
      const votes = session.votes.size;
      if (votes < required) {
        return { skipped: false, votes, required };
      }
      await this.discardCurrent(session, true);
      this.playNext(session);
      this.afterChange(session);
      return { skipped: true, votes, required };
    });
  }

  stop(guildId: string): Promise<void> {
    return this.locked(guildId, async () => {
      const session = this.sessions.get(guildId);
      if (session !== undefined) {
        await this.teardown(session, 'stopped', 'Воспроизведение остановлено.');
      }
    });
  }

  leave(guildId: string): Promise<void> {
    return this.stop(guildId);
  }

  restart(guildId: string): Promise<void> {
    return this.locked(guildId, async () => {
      const session = this.requireSession(guildId);
      const track = await this.discardCurrent(session, false);
      if (track === null) {
        throw new AppError('NOT_FOUND', NOTHING_PLAYING);
      }
      session.pendingReplay = track;
      this.playNext(session);
      this.afterChange(session);
    });
  }

  clear(guildId: string): Promise<number> {
    return this.locked(guildId, () => {
      const session = this.sessions.get(guildId);
      if (session === undefined) {
        return Promise.resolve(0);
      }
      const removed = session.queue.clear().length;
      this.afterChange(session);
      return Promise.resolve(removed);
    });
  }

  remove(guildId: string, position: number): Promise<Track> {
    return this.locked(guildId, () => {
      const session = this.requireSession(guildId);
      const removed = session.queue.remove(position);
      this.afterChange(session);
      return Promise.resolve(removed);
    });
  }

  shuffle(guildId: string): Promise<void> {
    return this.locked(guildId, () => {
      const session = this.sessionFor(guildId);
      session.queue.shuffle(this.random);
      this.afterChange(session);
      return Promise.resolve();
    });
  }

  setLoop(guildId: string, mode: LoopMode): Promise<void> {
    return this.locked(guildId, () => {
      const session = this.sessionFor(guildId);
      session.loop = mode;
      this.afterChange(session);
      return Promise.resolve();
    });
  }

  setVolume(guildId: string, percent: number): Promise<void> {
    return this.locked(guildId, () => {
      const session = this.sessionFor(guildId);
      const clamped = Math.min(100, Math.max(0, Math.round(percent)));
      session.volume = clamped;
      session.player.setVolume(clamped / 100);
      this.afterChange(session);
      return Promise.resolve();
    });
  }

  move(guildId: string, channelId: string): Promise<void> {
    return this.locked(guildId, async () => {
      const session = this.sessionFor(guildId);
      if (session.connection?.channelId === channelId) {
        return;
      }
      await this.connect(session, channelId);
      this.afterChange(session);
    });
  }

  join(guildId: string, channelId: string): Promise<void> {
    return this.locked(guildId, async () => {
      const session = this.sessionFor(guildId);
      await this.ensureChannel(session, channelId);
      this.afterChange(session);
    });
  }

  // ---------- events from the Discord layer ----------

  /** Re-evaluates the auto-disconnect timers after members join or leave the channel. */
  handleListenersChanged(guildId: string): Promise<void> {
    return this.locked(guildId, () => {
      const session = this.sessions.get(guildId);
      if (session !== undefined) {
        this.afterChange(session);
      }
      return Promise.resolve();
    });
  }

  /** The bot's own voice state changed: an administrator moved or removed it. */
  handleBotVoiceChange(guildId: string, channelId: string | null): Promise<void> {
    return this.locked(guildId, async () => {
      const session = this.sessions.get(guildId);
      if (session === undefined || session.connection === null) {
        return;
      }
      if (channelId === null) {
        await this.teardown(session, 'kicked', 'Бота отключили от голосового канала.');
        return;
      }
      if (session.connection.channelId === channelId) {
        return;
      }
      try {
        await this.connect(session, channelId);
      } catch {
        await this.teardown(session, 'lost', 'Не удалось перейти в канал, куда переместили бота.');
        return;
      }
      this.afterChange(session);
    });
  }

  // ---------- reads ----------

  snapshot(guildId: string): GuildSnapshot {
    const session = this.sessions.get(guildId);
    if (session !== undefined) {
      return this.snapshotOf(session);
    }
    const settings = this.options.settings(guildId);
    return {
      guildId,
      state: 'idle',
      voiceChannelId: null,
      nowPlaying: null,
      queue: [],
      queueLimit: settings.queueLimit,
      loop: 'off',
      volume: settings.defaultVolume,
      listeners: 0,
      notice: null,
    };
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const session of [...this.sessions.values()]) {
      await this.locked(session.guildId, () => this.teardown(session, 'shutdown'));
      session.player.destroy();
    }
    this.sessions.clear();
  }

  // ---------- internals: locking and lookup ----------

  private locked<T>(guildId: string, task: () => Promise<T>): Promise<T> {
    return this.lock.run(guildId, task);
  }

  /**
   * Runs an event-driven task under the guild lock. Nobody awaits these tasks, so a failure
   * is logged here. An unobserved rejection would otherwise stop the whole process.
   */
  private background(guildId: string, task: () => Promise<void>): void {
    if (this.stopped) {
      return;
    }
    this.locked(guildId, task).catch((error: unknown) => {
      this.log.error({ guildId, err: error }, 'A playback event could not be handled');
    });
  }

  private sessionFor(guildId: string): GuildSession {
    const existing = this.sessions.get(guildId);
    if (existing !== undefined) {
      return existing;
    }
    const settings = this.options.settings(guildId);
    const player = this.options.createPlayer();
    player.setVolume(settings.defaultVolume / 100);
    const session = new GuildSession(guildId, player, settings.queueLimit, settings.defaultVolume);
    this.sessions.set(guildId, session);
    return session;
  }

  private requireSession(guildId: string): GuildSession {
    const session = this.sessions.get(guildId);
    if (session === undefined) {
      throw new AppError('NOT_FOUND', NOTHING_PLAYING);
    }
    return session;
  }

  // ---------- internals: queueing and playback ----------

  private async doEnqueue(
    request: EnqueueRequest,
  ): Promise<{ positions: readonly number[]; loading: CurrentPlayback | null }> {
    const settings = this.options.settings(request.guildId);
    for (const draft of request.tracks) {
      if (draft.durationSec !== null && draft.durationSec > settings.maxTrackSec) {
        throw new AppError(
          'TRACK_TOO_LONG',
          `«${draft.title}» длиннее допустимых ${String(Math.floor(settings.maxTrackSec / 60))} мин.`,
        );
      }
    }

    const session = this.sessionFor(request.guildId);
    session.queue.setCapacity(settings.queueLimit);
    const free = Math.max(0, settings.queueLimit - session.queue.size);
    if (request.tracks.length > free) {
      throw new AppError(
        'QUEUE_FULL',
        `Очередь заполнена: свободно мест ${String(free)} из ${String(settings.queueLimit)}.`,
      );
    }

    await this.ensureChannel(session, request.voiceChannelId);
    const now = this.now();
    const tracks = request.tracks.map((draft) => toTrack(draft, request.requesterId, now));
    const positions = session.queue.enqueue(tracks);

    const loading = session.current === null ? this.playNext(session) : null;
    this.afterChange(session);
    return { positions, loading };
  }

  /**
   * Starts loading the next track and returns it, or returns null when nothing is left.
   * Tracks whose provider is unavailable are reported and passed over.
   */
  private playNext(session: GuildSession): CurrentPlayback | null {
    for (;;) {
      const replay = session.pendingReplay;
      session.pendingReplay = null;
      const track = replay ?? session.queue.shift();
      if (track === undefined) {
        this.setState(session, 'idle');
        return null;
      }
      const provider = this.options.providers(track.source);
      if (provider === undefined || !provider.enabled) {
        this.reportFailure(session, track, 'этот источник сейчас недоступен.');
        continue;
      }
      return this.beginLoading(session, track, provider);
    }
  }

  private beginLoading(
    session: GuildSession,
    track: Track,
    provider: AudioProvider,
  ): CurrentPlayback {
    const playback: CurrentPlayback = {
      track,
      token: session.nextToken(),
      controller: new AbortController(),
      start: Promise.withResolvers<StartResult>(),
      playable: null,
      finished: false,
      playedMs: 0,
      playingSince: null,
    };
    session.current = playback;
    session.votes.clear();
    this.setState(session, 'buffering');
    void this.load(session, playback, provider);
    return playback;
  }

  /**
   * Opens the source outside the guild lock, then applies the result under the lock. On
   * timeout the provider is cancelled, and a source that still opens later is closed, so a
   * slow source cannot leave a decoder or download process behind.
   */
  private async load(
    session: GuildSession,
    playback: CurrentPlayback,
    provider: AudioProvider,
  ): Promise<void> {
    const opening = (async () => {
      await provider.validate(playback.track);
      return provider.getPlayableStream(playback.track, playback.controller.signal);
    })();

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<LoadOutcome>((resolve) => {
      timer = setTimeout(() => {
        resolve({ kind: 'timeout' });
      }, this.bufferTimeoutMs);
    });
    const outcome = await Promise.race<LoadOutcome>([
      opening.then(
        (playable): LoadOutcome => ({ kind: 'opened', playable }),
        (error: unknown): LoadOutcome => ({ kind: 'failed', error }),
      ),
      deadline,
    ]);
    clearTimeout(timer);

    if (outcome.kind === 'timeout') {
      playback.controller.abort();
      opening.then(
        (late) => late.close(),
        () => undefined,
      );
    }
    if (this.stopped) {
      if (outcome.kind === 'opened') {
        await outcome.playable.close();
      }
      playback.start.resolve({ outcome: 'cancelled' });
      return;
    }
    this.background(session.guildId, () => this.attach(session, playback, outcome));
  }

  /** Hands an opened source to the player, unless the track was replaced while it loaded. */
  private async attach(
    session: GuildSession,
    playback: CurrentPlayback,
    outcome: LoadOutcome,
  ): Promise<void> {
    if (session.current !== playback || playback.finished) {
      // A skip, stop or restart replaced this playback while it was loading.
      if (outcome.kind === 'opened') {
        await outcome.playable.close();
      }
      playback.start.resolve({ outcome: 'cancelled' });
      return;
    }

    if (outcome.kind !== 'opened') {
      session.current = null;
      const message =
        outcome.kind === 'timeout'
          ? BUFFER_TIMEOUT_MESSAGE
          : toUserMessage(outcome.error, 'не удалось открыть трек.');
      this.reportFailure(session, playback.track, message);
      playback.start.resolve({ outcome: 'failed', message });
      this.playNext(session);
      this.afterChange(session);
      return;
    }

    const playable = outcome.playable;
    if (session.connection === null) {
      // The voice connection was lost while loading. Keep the track for after the reconnect.
      await playable.close();
      session.current = null;
      session.pendingReplay = playback.track;
      playback.start.resolve({ outcome: 'deferred' });
      this.afterChange(session);
      return;
    }

    const { token } = playback;
    const guildId = session.guildId;
    playback.playable = playable;
    session.player.play(playable.stream, {
      onStart: () => {
        this.background(guildId, () => {
          this.handleStart(session, token);
          return Promise.resolve();
        });
      },
      onEnd: () => {
        this.background(guildId, () => this.finishTrack(session, token, 'completed'));
      },
      onError: (error) => {
        this.log.warn({ guildId, err: error }, 'Audio player reported an error');
        this.background(guildId, () =>
          this.finishTrack(session, token, 'failed', 'ошибка воспроизведения.'),
        );
      },
    });
    void playable.ended.then((end) => {
      if (end.status === 'failed') {
        this.background(guildId, () => this.finishTrack(session, token, 'failed', end.message));
      }
    });
    playback.start.resolve({ outcome: 'started' });
    this.afterChange(session);
  }

  /** Ends the track in `token` exactly once. Stale or duplicate signals are ignored. */
  private async finishTrack(
    session: GuildSession,
    token: number,
    outcome: 'completed' | 'failed',
    message?: string,
  ): Promise<void> {
    const playback = session.current;
    if (playback === null || playback.token !== token || playback.finished) {
      return;
    }
    this.accumulate(playback);
    playback.finished = true;
    session.current = null;
    session.player.stop();
    await playback.playable?.close();

    if (outcome === 'completed') {
      if (session.loop === 'track') {
        session.pendingReplay = playback.track;
      } else if (session.loop === 'queue') {
        session.queue.pushBack(playback.track);
      }
    } else {
      this.reportFailure(session, playback.track, message ?? 'ошибка воспроизведения.');
    }

    this.playNext(session);
    this.afterChange(session);
  }

  private handleStart(session: GuildSession, token: number): void {
    const playback = session.current;
    if (playback === null || playback.token !== token || playback.finished) {
      return;
    }
    playback.playingSince = this.now();
    this.setState(session, 'playing');
    this.emit({ type: 'track_started', guildId: session.guildId, track: playback.track });
    this.afterChange(session);
  }

  /** Discards the current track. With `rotate`, a track in repeat-queue mode goes to the back. */
  private async discardCurrent(session: GuildSession, rotate: boolean): Promise<Track | null> {
    const playback = session.current;
    if (playback === null) {
      return null;
    }
    session.current = null;
    playback.finished = true;
    this.accumulate(playback);
    playback.controller.abort();
    playback.start.resolve({ outcome: 'cancelled' });
    session.player.stop();
    await playback.playable?.close();
    if (rotate && session.loop === 'queue') {
      session.queue.pushBack(playback.track);
    }
    return playback.track;
  }

  // ---------- internals: voice connection ----------

  private async ensureChannel(session: GuildSession, channelId: string): Promise<void> {
    if (session.connection?.channelId === channelId) {
      return;
    }
    if (session.connection !== null && this.isBusy(session)) {
      throw new AppError(
        'BOT_BUSY',
        'Бот уже играет музыку в другом голосовом канале. Подключитесь к нему или попросите DJ переместить бота.',
      );
    }
    await this.connect(session, channelId);
  }

  private async connect(session: GuildSession, channelId: string): Promise<void> {
    const joining = session.state === 'idle';
    if (joining) {
      session.transition('connecting');
    }

    let established: VoiceConnectionPort;
    try {
      established = await this.options.voice.connect(session.guildId, channelId);
    } catch (error) {
      if (session.state === 'connecting') {
        session.transition('idle');
      }
      throw new AppError(
        'VOICE_FAILED',
        'Не удалось подключиться к голосовому каналу. Проверьте права бота: «Подключение» и «Говорить».',
        { cause: error },
      );
    }

    const previous = session.connection;
    session.connection = established;
    session.voiceChannelId = channelId;
    // Discord allows one voice connection per guild, so a move returns the connection that is
    // already live. Only a genuinely new connection gets a loss handler, and only a different
    // previous connection is destroyed.
    if (established !== previous) {
      established.subscribe(session.player);
      established.onLost((reason) => {
        this.background(session.guildId, () => this.handleLoss(session, established, reason));
      });
      previous?.destroy();
    }
    session.timers.cancel('reconnect');
    if (session.state === 'connecting') {
      session.transition('idle');
    }
  }

  private async handleLoss(
    session: GuildSession,
    connection: VoiceConnectionPort,
    reason: VoiceLossReason,
  ): Promise<void> {
    if (session.connection !== connection) {
      return;
    }
    session.connection = null;
    // Release the lost connection's resources. A reconnect creates a new one.
    connection.destroy();

    if (reason === 'kicked') {
      await this.teardown(session, 'kicked', 'Бота отключили от голосового канала.');
      return;
    }

    this.emit({ type: 'connection_lost', guildId: session.guildId });
    if (session.current === null && session.queue.size === 0 && session.pendingReplay === null) {
      this.setState(session, 'idle');
      this.afterChange(session);
      return;
    }

    if (session.state === 'playing' && session.current !== null) {
      session.player.pause();
      this.accumulate(session.current);
    }
    session.resumeAfterLoss = session.state === 'paused' ? 'paused' : 'playing';
    session.reconnectAttempts = 0;
    session.lastNotice = 'Соединение с голосовым каналом потеряно. Пытаюсь переподключиться…';
    this.setState(session, 'disconnected');

    if (!this.scheduleReconnect(session)) {
      await this.giveUp(session);
      return;
    }
    this.afterChange(session);
  }

  private scheduleReconnect(session: GuildSession): boolean {
    const delay = RECONNECT_DELAYS_MS[session.reconnectAttempts];
    if (delay === undefined) {
      return false;
    }
    session.timers.ensure('reconnect', delay, () => {
      this.background(session.guildId, () => this.attemptReconnect(session));
    });
    return true;
  }

  private async attemptReconnect(session: GuildSession): Promise<void> {
    const channelId = session.voiceChannelId;
    if (session.state !== 'disconnected' || session.connection !== null || channelId === null) {
      return;
    }

    session.reconnectAttempts += 1;
    try {
      await this.connect(session, channelId);
    } catch {
      if (this.scheduleReconnect(session)) {
        this.afterChange(session);
      } else {
        await this.giveUp(session);
      }
      return;
    }

    session.lastNotice = 'Соединение с голосовым каналом восстановлено.';
    const playback = session.current;
    if (playback === null) {
      if (session.pendingReplay !== null || session.queue.size > 0) {
        this.playNext(session);
      } else {
        this.setState(session, 'idle');
      }
    } else if (playback.playable === null) {
      this.setState(session, 'buffering');
    } else if (session.resumeAfterLoss === 'paused') {
      this.setState(session, 'paused');
    } else {
      session.player.resume();
      playback.playingSince = this.now();
      this.setState(session, 'playing');
    }
    this.afterChange(session);
  }

  private async giveUp(session: GuildSession): Promise<void> {
    session.timers.cancel('reconnect');
    session.voiceChannelId = null;
    session.lastNotice = 'Не удалось восстановить соединение с голосовым каналом. Очередь очищена.';
    await this.discardCurrent(session, false);
    session.queue.clear();
    session.pendingReplay = null;
    this.setState(session, 'idle');
    this.emit({ type: 'left_channel', guildId: session.guildId, reason: 'lost' });
    this.afterChange(session);
  }

  /** Leaves the channel and clears everything the session holds. Used by stop, timers and removal by an administrator. */
  private async teardown(session: GuildSession, reason: LeaveReason, notice?: string): Promise<void> {
    session.timers.cancelAll();
    await this.discardCurrent(session, false);
    session.queue.clear();
    session.pendingReplay = null;
    session.votes.clear();
    const connection = session.connection;
    session.connection = null;
    session.voiceChannelId = null;
    session.reconnectAttempts = 0;
    connection?.destroy();
    if (notice !== undefined) {
      session.lastNotice = notice;
    }
    this.setState(session, 'idle');
    this.emit({ type: 'left_channel', guildId: session.guildId, reason });
    this.afterChange(session);
  }

  // ---------- internals: timers and snapshots ----------

  private syncTimers(session: GuildSession): void {
    const channelId = session.voiceChannelId;
    const connected = session.connection !== null && channelId !== null;
    const settings = this.options.settings(session.guildId);
    const listeners = connected ? this.options.listeners(session.guildId, channelId) : 0;

    if (connected && listeners === 0) {
      session.timers.ensure('empty', settings.emptyTimeoutSec * 1000, () => {
        this.background(session.guildId, () => this.onEmptyTimeout(session));
      });
    } else {
      session.timers.cancel('empty');
    }

    const idle = session.state === 'idle' && session.current === null && session.queue.size === 0;
    if (connected && idle) {
      session.timers.ensure('idle', settings.idleTimeoutSec * 1000, () => {
        this.background(session.guildId, () => this.onIdleTimeout(session));
      });
    } else {
      session.timers.cancel('idle');
    }
  }

  private async onEmptyTimeout(session: GuildSession): Promise<void> {
    const channelId = session.voiceChannelId;
    if (session.connection === null || channelId === null) {
      return;
    }
    if (this.options.listeners(session.guildId, channelId) > 0) {
      return;
    }
    await this.teardown(session, 'empty', 'В голосовом канале никого не осталось.');
  }

  private async onIdleTimeout(session: GuildSession): Promise<void> {
    if (session.connection === null || session.state !== 'idle' || session.current !== null) {
      return;
    }
    if (session.queue.size > 0) {
      return;
    }
    await this.teardown(session, 'idle', 'Бот отключился из-за бездействия.');
  }

  private listenersOf(session: GuildSession): number {
    const channelId = session.voiceChannelId;
    return session.connection !== null && channelId !== null
      ? this.options.listeners(session.guildId, channelId)
      : 0;
  }

  private isBusy(session: GuildSession): boolean {
    return session.current !== null || session.queue.size > 0 || this.listenersOf(session) > 0;
  }

  private snapshotOf(session: GuildSession): GuildSnapshot {
    const playback = session.current;
    return {
      guildId: session.guildId,
      state: session.state,
      voiceChannelId: session.voiceChannelId,
      nowPlaying:
        playback === null
          ? null
          : {
              track: playback.track,
              elapsedMs: this.elapsedOf(playback),
              paused: session.state === 'paused',
            },
      queue: session.queue.list(),
      queueLimit: session.queue.limit,
      loop: session.loop,
      volume: session.volume,
      listeners: this.listenersOf(session),
      notice: session.lastNotice,
    };
  }

  private afterChange(session: GuildSession): void {
    this.syncTimers(session);
    this.options.onChange(this.snapshotOf(session));
  }

  private elapsedOf(playback: CurrentPlayback): number {
    const running = playback.playingSince !== null ? this.now() - playback.playingSince : 0;
    return playback.playedMs + running;
  }

  private accumulate(playback: CurrentPlayback): void {
    if (playback.playingSince !== null) {
      playback.playedMs += this.now() - playback.playingSince;
      playback.playingSince = null;
    }
  }

  private reportFailure(session: GuildSession, track: Track, message: string): void {
    this.setState(session, 'error');
    session.lastNotice = `Не удалось воспроизвести «${track.title}»: ${message}`;
    this.log.warn({ guildId: session.guildId, source: track.source }, 'Track could not be played');
    this.emit({ type: 'track_failed', guildId: session.guildId, title: track.title, message });
  }

  private setState(session: GuildSession, to: PlaybackState): void {
    if (!session.transition(to)) {
      this.log.debug({ guildId: session.guildId, from: session.state, to }, 'Ignored an invalid state transition');
    }
  }

  private emit(event: EngineEvent): void {
    this.options.onEvent?.(event);
  }
}

function toTrack(draft: TrackDraft, requesterId: string, createdAt: number): Track {
  return { ...draft, id: randomUUID(), requesterId, createdAt };
}
