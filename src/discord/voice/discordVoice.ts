import type { Readable } from 'node:stream';
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
 * encryption and Opus encoding. This class only manages connection lifetime and maps
 * library events to the engine's ports.
 */
export class DiscordVoicePort implements VoicePort {
  constructor(
    private readonly client: Client,
    private readonly log: Pick<Logger, 'warn' | 'info'>,
  ) {}

  async connect(guildId: string, channelId: string): Promise<VoiceConnectionPort> {
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
    return new DiscordVoiceConnection(connection, channelId, this.log);
  }
}

class DiscordVoiceConnection implements VoiceConnectionPort {
  private readonly lossHandlers: ((reason: VoiceLossReason) => void)[] = [];

  constructor(
    private readonly connection: VoiceConnection,
    readonly channelId: string,
    private readonly log: Pick<Logger, 'warn' | 'info'>,
  ) {
    connection.on('stateChange', (_oldState, newState) => {
      if (newState.status === VoiceConnectionStatus.Disconnected) {
        void this.handleDisconnect(newState);
      }
    });
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
    this.connection.destroy();
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
    if (this.connection.state.status === VoiceConnectionStatus.Destroyed) {
      return;
    }
    this.log.warn({ removed }, 'Voice connection lost');
    const reason: VoiceLossReason = removed ? 'kicked' : 'disconnected';
    for (const handler of this.lossHandlers) {
      handler(reason);
    }
  }
}

interface ActivePlayback {
  readonly resource: AudioResource;
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

  constructor() {
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
    const resource = createAudioResource(stream, { inputType: StreamType.Raw, inlineVolume: true });
    resource.volume?.setVolume(this.gain);
    this.active = { resource, callbacks, started: false };
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
    this.active?.resource.volume?.setVolume(gain);
  }

  destroy(): void {
    this.active = null;
    this.handle.stop(true);
  }
}
