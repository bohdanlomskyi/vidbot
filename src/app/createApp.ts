import { join } from 'node:path';
import { Events, type Client } from 'discord.js';
import type { Logger } from 'pino';
import type { AppServices } from '../commands/context.js';
import { PendingPlaylists } from '../commands/pendingPlaylists.js';
import { LibraryCatalog } from '../audio/library/catalog.js';
import { UploadService } from '../audio/library/uploads.js';
import { AuthorizedStreamProvider } from '../audio/providers/streamProvider.js';
import {
  type StreamCatalogParseResult,
  loadStreamCatalog,
} from '../audio/providers/streamCatalog.js';
import { LocalAudioProvider } from '../audio/providers/localProvider.js';
import { YouTubeExperimentalProvider } from '../audio/providers/youtubeProvider.js';
import type { AudioProvider } from '../audio/providers/types.js';
import { OpusWorkerEncoder } from '../audio/opus/opusWorkerEncoder.js';
import { probeAudioFile } from '../audio/pipeline/probe.js';
import type { AppConfig } from '../config/load.js';
import { checkDatabase, openDatabase } from '../database/db.js';
import { FavoritesRepository } from '../database/favoritesRepository.js';
import { HistoryRepository } from '../database/historyRepository.js';
import { LibraryRepository } from '../database/libraryRepository.js';
import { migrate } from '../database/migrations.js';
import { GuildSettingsRepository } from '../database/settingsRepository.js';
import { Announcer } from '../discord/announcer.js';
import { ChannelFollower } from '../discord/channelFollower.js';
import { PanelManager } from '../discord/ui/panelManager.js';
import { DiscordAudioPlayer, DiscordVoicePort } from '../discord/voice/discordVoice.js';
import { countListeners } from '../discord/voice/listeners.js';
import { createClient, wireClient } from '../discord/bot.js';
import { MusicEngine } from '../music/engine/musicEngine.js';
import type { SourceKind } from '../music/models/track.js';
import { guildSettingsDefaults } from './guildDefaults.js';
import { SourceRouter } from '../music/sourceRouter.js';
import { SlidingWindowRateLimiter } from '../utils/rateLimiter.js';
import { describeEngineEvent } from './engineAnnouncements.js';
import { handleEngineEvent, toPlaybackSettings } from './engineEvents.js';
import { Heartbeat, type HealthStatus } from './heartbeat.js';
import { scheduleLibraryRescan } from './librarySchedule.js';
import { readToolVersion } from './tools.js';

/** Play history kept per guild. Older rows are trimmed on every insert. */
const HISTORY_RETENTION_PER_GUILD = 200;
const RATE_WINDOW_MS = 10_000;
/** Saved tracks each member can keep. */
const FAVORITES_LIMIT = 100;
/** A rescan asked for by a command is skipped when the library was scanned this recently. */
const RESCAN_MIN_GAP_MS = 15_000;
const PROBE_TIMEOUT_MS = 20_000;
/** Stream timeouts: how long to wait for headers, and how much silence the body may have. */
const STREAM_TIMEOUTS = { responseMs: 15_000, idleMs: 15_000 } as const;

export interface App {
  readonly services: AppServices;
  readonly client: Client;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Composition root. It builds every service once, wires them together, and returns a
 * handle that starts and stops the bot. Nothing here connects to Discord until start().
 */
export async function createApp(config: AppConfig, logger: Logger): Promise<App> {
  const db = openDatabase(config.paths.databaseFile);
  migrate(db);
  const databaseCheck = checkDatabase(db);
  if (!databaseCheck.ok) {
    logger.error({ detail: databaseCheck.detail }, 'The database failed its integrity check');
  }

  const settings = new GuildSettingsRepository(db, guildSettingsDefaults(config));
  const history = new HistoryRepository(db, HISTORY_RETENTION_PER_GUILD);
  const catalog = new LibraryCatalog({
    musicDir: config.paths.musicDir,
    store: new LibraryRepository(db),
    probe: (absolutePath) =>
      probeAudioFile(config.ffmpeg.ffprobePath, absolutePath, PROBE_TIMEOUT_MS),
  });

  const streamCatalog: StreamCatalogParseResult = config.streams.enabled
    ? await loadStreamCatalog(config.paths.streamCatalogFile)
    : { entries: [], problems: [] };
  for (const problem of streamCatalog.problems) {
    logger.warn({ problem }, 'A stream catalog entry was rejected');
  }

  const local = new LocalAudioProvider({
    catalog,
    musicDir: config.paths.musicDir,
    ffmpegPath: config.ffmpeg.ffmpegPath,
  });
  const streams = new AuthorizedStreamProvider({
    entries: streamCatalog.entries,
    enabled: config.streams.enabled,
    ffmpegPath: config.ffmpeg.ffmpegPath,
    maxBytes: config.streams.maxBytes,
    timeouts: STREAM_TIMEOUTS,
  });
  const youtube = new YouTubeExperimentalProvider({
    enabled: config.youtube.enabled,
    ytdlpPath: config.youtube.ytdlpPath,
    jsRuntime: config.youtube.jsRuntime,
    cacheDir: join(config.paths.dataDir, 'yt-dlp-cache'),
    ffmpegPath: config.ffmpeg.ffmpegPath,
    maxDurationSec: config.youtube.maxDurationSec,
    playlistMaxItems: config.youtube.playlistMaxItems,
    maxConcurrency: config.youtube.maxConcurrency,
    timeoutSec: config.youtube.timeoutSec,
  });
  const sources = new SourceRouter({
    local,
    streams,
    youtube,
    libraryHasTitle: (title) =>
      catalog.search(title, 5).some((row) => row.title.toLowerCase() === title.toLowerCase()),
  });
  const providerByKind: Record<SourceKind, AudioProvider> = { local, stream: streams, youtube };

  // Opus is encoded in a worker thread when it starts; otherwise on the main thread as before.
  const opusEncoder = await OpusWorkerEncoder.start(logger);
  const client: Client = createClient();
  const follower = new ChannelFollower();
  // The panel needs the engine, and the engine notifies the panel. The holder breaks that cycle.
  const panelHolder: { panel?: PanelManager } = {};
  const announcer = new Announcer({
    client,
    settings,
    follower,
    logger,
    onPosted: (guildId, channelId, messageId) => {
      // The player panel moves below every message the bot writes.
      panelHolder.panel?.notePosted(guildId, channelId, messageId);
    },
  });
  /** The track whose start was announced last, per guild, so a repeating track is not announced again. */
  const lastStarted = new Map<string, string>();
  const engine = new MusicEngine({
    voice: new DiscordVoicePort(client, logger),
    createPlayer: () => new DiscordAudioPlayer(opusEncoder),
    providers: (kind) => providerByKind[kind],
    listeners: (guildId, channelId) => countListeners(client, guildId, channelId),
    settings: (guildId) => toPlaybackSettings(settings.get(guildId)),
    onChange: (snapshot) => {
      panelHolder.panel?.requestRefresh(snapshot.guildId);
    },
    onEvent: (event) => {
      handleEngineEvent(event, { history, logger, now: () => Date.now() });
      const note = describeEngineEvent(event, {
        lastStartedTrackId: lastStarted.get(event.guildId) ?? null,
      });
      if (event.type === 'track_started') {
        lastStarted.set(event.guildId, event.track.id);
      } else if (event.type === 'left_channel') {
        lastStarted.delete(event.guildId);
      }
      if (note !== null) {
        void announcer.say(event.guildId, note.kind, note.text);
      }
    },
    logger,
  });
  const panel = new PanelManager({
    client,
    engine,
    settings,
    botName: config.botName,
    logger,
    follower,
  });
  panelHolder.panel = panel;

  const ffmpegVersion = await readToolVersion(config.ffmpeg.ffmpegPath, ['-version']);
  if (ffmpegVersion === null) {
    logger.error(
      { ffmpeg: config.ffmpeg.ffmpegPath },
      'FFmpeg could not be started, so no audio can play',
    );
  }

  let lastLibraryScan = 0;
  async function refreshLibrary(): Promise<void> {
    lastLibraryScan = Date.now();
    try {
      const summary = await catalog.refresh();
      logger.info({ summary }, 'The music library was scanned');
    } catch (error) {
      logger.warn({ err: error }, 'The music library scan failed');
    }
  }

  const uploads = config.uploads.enabled
    ? new UploadService({
        musicDir: config.paths.musicDir,
        maxBytes: config.uploads.maxBytes,
        quotaBytes: config.uploads.quotaBytes,
        probe: (absolutePath) =>
          probeAudioFile(config.ffmpeg.ffprobePath, absolutePath, PROBE_TIMEOUT_MS),
        refresh: () => catalog.refresh(),
      })
    : null;

  const services: AppServices = {
    config,
    logger,
    engine,
    settings,
    history,
    catalog,
    streams,
    youtube,
    sources,
    panel,
    rateLimiter: new SlidingWindowRateLimiter({
      limit: config.rateLimit.perUserPer10s,
      windowMs: RATE_WINDOW_MS,
    }),
    pendingPlaylists: new PendingPlaylists(),
    pendingSearches: new PendingPlaylists(),
    announcer,
    favorites: new FavoritesRepository(db, FAVORITES_LIMIT),
    uploads,
    refreshLibrary: async () => {
      // A track the member just copied into the music folder should be found at once.
      if (Date.now() - lastLibraryScan >= RESCAN_MIN_GAP_MS) {
        await refreshLibrary();
      }
    },
    status: { databaseOk: databaseCheck.ok, ffmpegVersion },
    startedAt: Date.now(),
  };
  wireClient(client, services);

  const heartbeat = new Heartbeat({
    file: config.paths.healthFile,
    currentStatus: (): HealthStatus => (client.isReady() ? 'ready' : 'starting'),
    onError: (error) => {
      logger.warn({ err: error }, 'The health file could not be written');
    },
  });

  let stopping: Promise<void> | undefined;
  let stopRescan: () => void = () => undefined;

  async function shutdown(): Promise<void> {
    stopRescan();
    // New interactions and voice events must not start work while the sessions are torn down.
    client.removeAllListeners(Events.InteractionCreate);
    client.removeAllListeners(Events.VoiceStateUpdate);
    await heartbeat.stop('stopping').catch((error: unknown) => {
      logger.warn({ err: error }, 'The final health file could not be written');
    });
    // The engine's teardown requests panel refreshes, so the panel is disposed after it.
    await engine.shutdown();
    panel.dispose();
    await opusEncoder?.dispose();
    await client.destroy();
    await Promise.all([local.dispose(), streams.dispose(), youtube.dispose()]);
    db.close();
  }

  return {
    services,
    client,
    async start(): Promise<void> {
      heartbeat.start();
      // A large library can take a while to scan, so the first scan runs in the background.
      void refreshLibrary();
      stopRescan = scheduleLibraryRescan({
        minutes: config.library.rescanMinutes,
        refresh: refreshLibrary,
        onError: (error) => {
          logger.warn({ err: error }, 'The scheduled library scan failed');
        },
      });
      await client.login(config.discord.token);
    },
    stop(): Promise<void> {
      stopping ??= shutdown();
      return stopping;
    },
  };
}
