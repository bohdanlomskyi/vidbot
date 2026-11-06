import { pipeline, type Readable } from 'node:stream';
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionDisconnectReason,
  VoiceConnectionStatus,
  type AudioPlayer,
  type AudioResource,
  type VoiceConnection,
} from '@discordjs/voice';
import type { Client } from 'discord.js';
import type { Logger } from 'pino';
import type { OpusWorkerEncoder } from '../../audio/opus/opusWorkerEncoder.js';
import type {
  AudioPlayerPort,
  PlaybackCallbacks,
  VoiceConnectionPort,
  VoiceLossReason,
  VoicePort,
} from '../../music/ports.js';

/** Voice gateway close code sent when a member disconnects the bot or moves it. */
const CLOSE_CODE_REMOVED = 4014;
const CONNECT_TIMEOUT_MS = 15_000;
const RECOVER_TIMEOUT_MS = 5_000;

/**
 * Joins voice channels through @discordjs/voice. The library supplies DAVE end-to-end
 * encryption and Opus packet transport. This class only manages connection lifetime and maps
 * library events to the engine's ports.
 *
 * Discord allows one voice connection per guild, and the library returns the existing one
 * from joinVoiceChannel. So a guild with a live connection is moved with rejoin(), and the
 * same port object is returned: the engine must never destroy it as an "old" connection.
 */
export class DiscordVoicePort implements VoicePort {
  private readonly live = new Map<string, DiscordVoiceConnection>();

  constructor(
    private readonly client: Client,
    private readonly log: Pick<Logger, 'warn' | 'info'>,
  ) {}

  async connect(guildId: string, channelId: string): Promise<VoiceConnectionPort> {
    const existing = this.live.get(guildId);
    if (existing !== undefined && !existing.destroyed) {
      await existing.moveTo(channelId);
      this.log.info({ guildId }, 'Moved to another voice channel');
      return existing;
    }

    const guild =
      this.client.guilds.cache.get(guildId) ?? (await this.client.guilds.fetch(guildId));
    const connection = joinVoiceChannel({
      guildId,
      channelId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, CONNECT_TIMEOUT_MS);
    } catch (error) {
      connection.destroy();
      this.log.warn({ guildId, err: error }, 'Voice connection did not become ready');
      throw error;
    }
    this.log.info({ guildId }, 'Joined voice channel');
    const wrapper = new DiscordVoiceConnection(connection, channelId, this.log, () => {
      if (this.live.get(guildId) === wrapper) {
        this.live.delete(guildId);
      }
    });
    this.live.set(guildId, wrapper);
    return wrapper;
  }
}

class DiscordVoiceConnection implements VoiceConnectionPort {
  private readonly lossHandlers: ((reason: VoiceLossReason) => void)[] = [];
  private lastChannelId: string;

  constructor(
    private readonly connection: VoiceConnection,
    channelId: string,
    private readonly log: Pick<Logger, 'warn' | 'info'>,
    onDestroyed: () => void,
  ) {
    this.lastChannelId = channelId;
    connection.on('stateChange', (_oldState, newState) => {
      if (newState.status === VoiceConnectionStatus.Disconnected) {
        void this.handleDisconnect(newState);
      } else if (newState.status === VoiceConnectionStatus.Destroyed) {
        onDestroyed();
      }
    });
  }

  /** The library keeps the channel up to date, including after an administrator moves the bot. */
  get channelId(): string {
    this.lastChannelId = this.connection.joinConfig.channelId ?? this.lastChannelId;
    return this.lastChannelId;
  }

  get destroyed(): boolean {
    return this.connection.state.status === VoiceConnectionStatus.Destroyed;
  }

  /** Moves this connection to another channel of the same guild and waits until it is ready. */
  async moveTo(channelId: string): Promise<void> {
    if (this.connection.joinConfig.channelId !== channelId) {
      this.connection.rejoin({ channelId, selfDeaf: true, selfMute: false });
    }
    await entersState(this.connection, VoiceConnectionStatus.Ready, CONNECT_TIMEOUT_MS);
  }

  subscribe(player: AudioPlayerPort): void {
    if (!(player instanceof DiscordAudioPlayer)) {
      throw new TypeError('Only DiscordAudioPlayer can subscribe to a Discord voice connection');
    }
    this.connection.subscribe(player.handle);
  }

  onLost(handler: (reason: VoiceLossReason) => void): void {
    this.lossHandlers.push(handler);
  }

  destroy(): void {
    if (!this.destroyed) {
      this.connection.destroy();
    }
  }

  private async handleDisconnect(state: {
    reason?: VoiceConnectionDisconnectReason;
    closeCode?: number;
  }): Promise<void> {
    const removed =
      state.reason === VoiceConnectionDisconnectReason.WebSocketClose &&
      state.closeCode === CLOSE_CODE_REMOVED;

    // The library may reconnect on its own. Only report a loss when that fails.
    try {
      await Promise.race([
        entersState(this.connection, VoiceConnectionStatus.Signalling, RECOVER_TIMEOUT_MS),
        entersState(this.connection, VoiceConnectionStatus.Connecting, RECOVER_TIMEOUT_MS),
      ]);
      return;
    } catch {
      // Not recovering. Fall through and report the loss.
    }
    if (this.destroyed) {
      return;
    }
    this.log.warn({ removed }, 'Voice connection lost');
    const reason: VoiceLossReason = removed ? 'kicked' : 'disconnected';
    for (const handler of this.lossHandlers) {
      handler(reason);
    }
  }
}

export interface PlayerResource {
  readonly resource: AudioResource;
  /** Changes the gain of this resource from now on. */
  readonly setGain: (gain: number) => void;
}

/**
 * Builds the audio resource for decoded PCM. With the worker, Opus is encoded off the main
 * thread and the player receives finished packets. Without it, @discordjs/voice encodes on
 * the main thread and applies the gain with its inline volume transformer.
 */
export function createPlayerResource(
  pcm: Readable,
  gain: number,
  encoder: OpusWorkerEncoder | null,
): PlayerResource {
  if (encoder !== null) {
    const encoded = encoder.open(gain);
    // pipeline destroys both ends on failure, so the player sees a broken source as an error.
    pipeline(pcm, encoded.stream, () => undefined);
    const resource = createAudioResource(encoded.stream, { inputType: StreamType.Opus });
    return { resource, setGain: encoded.setGain };
  }
  const resource = createAudioResource(pcm, { inputType: StreamType.Raw, inlineVolume: true });
  resource.volume?.setVolume(gain);
  return {
    resource,
    setGain: (next) => {
      resource.volume?.setVolume(next);
    },
  };
}

interface ActivePlayback {
  readonly resource: AudioResource;
  readonly setGain: (gain: number) => void;
  readonly callbacks: PlaybackCallbacks;
  started: boolean;
}

/**
 * Wraps an @discordjs/voice AudioPlayer. Each playback gets its own callbacks. When a
 * playback is replaced or stopped its events are ignored, so a late event cannot advance
 * the queue.
 */
export class DiscordAudioPlayer implements AudioPlayerPort {
  readonly handle: AudioPlayer;
  private active: ActivePlayback | null = null;
  private gain = 1;

  constructor(private readonly encoder: OpusWorkerEncoder | null = null) {
    this.handle = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    this.handle.on('stateChange', (oldState, newState) => {
      const playback = this.active;
      if (playback === null) {
        return;
      }
      if (newState.status === AudioPlayerStatus.Playing && !playback.started) {
        playback.started = true;
        playback.callbacks.onStart();
        return;
      }
      if (
        newState.status === AudioPlayerStatus.Idle &&
        oldState.status !== AudioPlayerStatus.Idle &&
        'resource' in oldState &&
        oldState.resource === playback.resource
      ) {
        this.active = null;
        playback.callbacks.onEnd();
      }
    });
    this.handle.on('error', (error) => {
      const playback = this.active;
      if (playback !== null && error.resource === playback.resource) {
        this.active = null;
        playback.callbacks.onError(error);
      }
    });
  }

  play(stream: Readable, callbacks: PlaybackCallbacks): void {
    const { resource, setGain } = createPlayerResource(stream, this.gain, this.encoder);
    this.active = { resource, setGain, callbacks, started: false };
    this.handle.play(resource);
  }

  stop(): void {
    this.active = null;
    this.handle.stop(true);
  }

  pause(): void {
    this.handle.pause();
  }

  resume(): void {
    this.handle.unpause();
  }

  setVolume(gain: number): void {
    this.gain = gain;
    this.active?.setGain(gain);
  }

  destroy(): void {
    this.active = null;
    this.handle.stop(true);
  }
}
