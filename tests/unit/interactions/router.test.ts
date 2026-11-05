import { MessageFlags, type Interaction } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryRow } from '../../../src/audio/library/catalog.js';
import type { AppServices } from '../../../src/commands/context.js';
import { routeInteraction } from '../../../src/interactions/router.js';
import { AppError } from '../../../src/utils/errors.js';

const handlers = vi.hoisted(() => ({
  play: vi.fn(),
  panel: vi.fn(),
  queuePage: vi.fn(),
  playlist: vi.fn(),
  setup: vi.fn(),
  setupChannel: vi.fn(),
  setupCreate: vi.fn(),
  settings: vi.fn(),
  sources: vi.fn(),
  help: vi.fn(),
  status: vi.fn(),
}));

vi.mock('../../../src/commands/playback.js', () => ({
  PLAYBACK_COMMANDS: { play: handlers.play },
  handlePanelButton: handlers.panel,
  handleQueuePage: handlers.queuePage,
  handlePlaylistButton: handlers.playlist,
}));
vi.mock('../../../src/commands/admin.js', () => ({
  handleSetup: handlers.setup,
  handleSetupChannel: handlers.setupChannel,
  handleSetupCreate: handlers.setupCreate,
  handleSettings: handlers.settings,
  handleSourcesSelect: handlers.sources,
}));
vi.mock('../../../src/commands/info.js', () => ({
  handleHelp: handlers.help,
  handleStatus: handlers.status,
}));

type Kind = 'chat' | 'button' | 'channelSelect' | 'stringSelect' | 'autocomplete';
type Choice = { readonly name: string; readonly value: string };
type StreamEntry = { readonly id: string; readonly title: string };

interface FakeFields {
  readonly commandName?: string;
  readonly customId?: string;
  readonly deferred?: boolean;
  readonly focused?: { readonly name: string; readonly value: string };
}

function fakeInteraction(kind: Kind, fields: FakeFields = {}) {
  const reply = vi.fn(() => Promise.resolve());
  const followUp = vi.fn(() => Promise.resolve());
  const editReply = vi.fn(() => Promise.resolve());
  const respond = vi.fn<(choices: readonly Choice[]) => Promise<void>>(() => Promise.resolve());
  const raw = {
    type: 2,
    guildId: 'guild-1',
    user: { id: 'user-1' },
    commandName: fields.commandName,
    customId: fields.customId,
    deferred: fields.deferred ?? false,
    replied: false,
    options: { getFocused: () => fields.focused ?? { name: 'source', value: '' } },
    isAutocomplete: () => kind === 'autocomplete',
    isChatInputCommand: () => kind === 'chat',
    isButton: () => kind === 'button',
    isChannelSelectMenu: () => kind === 'channelSelect',
    isStringSelectMenu: () => kind === 'stringSelect',
    isAnySelectMenu: () => kind === 'channelSelect' || kind === 'stringSelect',
    isRepliable: () => kind !== 'autocomplete',
    reply,
    followUp,
    editReply,
    respond,
  };
  return { interaction: raw as unknown as Interaction, reply, followUp, editReply, respond };
}

interface FakeServicesOptions {
  readonly tracks?: readonly LibraryRow[];
  readonly streams?: readonly StreamEntry[];
  readonly allowRequests?: boolean;
  readonly retryAfterMs?: number;
}

function fakeServices(options: FakeServicesOptions = {}) {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const rateLimiter = {
    consume: vi.fn(() => ({
      allowed: options.allowRequests ?? true,
      retryAfterMs: options.retryAfterMs ?? 0,
    })),
  };
  const catalog = {
    search: vi.fn<(query: string, limit: number) => LibraryRow[]>(() => [
      ...(options.tracks ?? []),
    ]),
  };
  const streams = {
    suggest: vi.fn<(query: string, limit: number) => StreamEntry[]>(() => [
      ...(options.streams ?? []),
    ]),
  };
  const services = { logger, rateLimiter, catalog, streams };
  return { services: services as unknown as AppServices, logger, rateLimiter, catalog, streams };
}

function row(
  id: string,
  title: string,
  artist: string | null,
  durationSec: number | null,
): LibraryRow {
  return {
    id,
    relativePath: `${title}.mp3`,
    folder: '',
    title,
    artist,
    durationSec,
    sizeBytes: 1,
    mtimeMs: 1,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('autocomplete', () => {
  it('offers library tracks first and stream entries after them', async () => {
    const { services } = fakeServices({
      tracks: [row('lib-0123456789ab', 'Song', 'Band', 200)],
      streams: [{ id: 'radio-news', title: 'Radio News' }],
    });
    const { interaction, respond } = fakeInteraction('autocomplete', {
      commandName: 'play',
      focused: { name: 'source', value: 'so' },
    });

    await routeInteraction(interaction, services);

    expect(respond).toHaveBeenCalledWith([
      { name: 'Song — Band (3:20)', value: 'lib-0123456789ab' },
      { name: 'Поток: Radio News', value: 'radio-news' },
    ]);
  });

  it('answers an empty query without searching', async () => {
    const { services, catalog, streams } = fakeServices({
      tracks: [row('lib-0123456789ab', 'Song', null, null)],
    });
    const { interaction, respond } = fakeInteraction('autocomplete', {
      commandName: 'play',
      focused: { name: 'source', value: '   ' },
    });

    await routeInteraction(interaction, services);

    expect(respond).toHaveBeenCalledWith([]);
    expect(catalog.search).not.toHaveBeenCalled();
    expect(streams.suggest).not.toHaveBeenCalled();
  });

  it('answers other options and other commands with an empty list', async () => {
    const { services, catalog } = fakeServices({
      tracks: [row('lib-0123456789ab', 'Song', null, null)],
    });
    const other = fakeInteraction('autocomplete', {
      commandName: 'play',
      focused: { name: 'volume', value: 'so' },
    });
    const command = fakeInteraction('autocomplete', {
      commandName: 'queue',
      focused: { name: 'source', value: 'so' },
    });

    await routeInteraction(other.interaction, services);
    await routeInteraction(command.interaction, services);

    expect(other.respond).toHaveBeenCalledWith([]);
    expect(command.respond).toHaveBeenCalledWith([]);
    expect(catalog.search).not.toHaveBeenCalled();
  });

  it('never offers more than 25 choices', async () => {
    const tracks = Array.from({ length: 30 }, (_, index) =>
      row(`lib-${String(index).padStart(12, '0')}`, `Track ${String(index)}`, null, null),
    );
    const { services } = fakeServices({ tracks });
    const { interaction, respond } = fakeInteraction('autocomplete', {
      commandName: 'play',
      focused: { name: 'source', value: 'track' },
    });

    await routeInteraction(interaction, services);

    const offered = respond.mock.calls[0]?.[0] ?? [];
    expect(offered).toHaveLength(25);
  });

  it('does not spend the rate-limit budget on autocomplete', async () => {
    const { services, rateLimiter } = fakeServices({
      tracks: [row('lib-0123456789ab', 'Song', null, null)],
    });
    const { interaction } = fakeInteraction('autocomplete', {
      commandName: 'play',
      focused: { name: 'source', value: 'so' },
    });

    await routeInteraction(interaction, services);

    expect(rateLimiter.consume).not.toHaveBeenCalled();
  });

  it('contains search failures, logs them, and still resolves', async () => {
    const { services, catalog, logger } = fakeServices();
    catalog.search.mockImplementationOnce(() => {
      throw new Error('index is corrupted');
    });
    const { interaction, respond, reply, followUp } = fakeInteraction('autocomplete', {
      commandName: 'play',
      focused: { name: 'source', value: 'so' },
    });

    await expect(routeInteraction(interaction, services)).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) as unknown }),
      expect.any(String),
    );
    expect(respond).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(followUp).not.toHaveBeenCalled();
  });
});

describe('rate limiting', () => {
  it('refuses a request over budget, rounds the wait up to whole seconds, and skips the handler', async () => {
    const { services, rateLimiter } = fakeServices({ allowRequests: false, retryAfterMs: 4200 });
    const { interaction, reply } = fakeInteraction('chat', { commandName: 'play' });

    await routeInteraction(interaction, services);

    expect(rateLimiter.consume).toHaveBeenCalledWith('guild-1:user-1');
    expect(handlers.play).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Слишком часто. Подождите 5 с.',
        flags: MessageFlags.Ephemeral,
      }),
    );
  });

  it('never reports a wait shorter than one second', async () => {
    const { services } = fakeServices({ allowRequests: false, retryAfterMs: 0 });
    const { interaction, reply } = fakeInteraction('button', { customId: 'melody:panel:toggle' });

    await routeInteraction(interaction, services);

    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Слишком часто. Подождите 1 с.' }),
    );
    expect(handlers.panel).not.toHaveBeenCalled();
  });
});

describe('dispatch', () => {
  it('routes /play to its playback handler', async () => {
    const { services } = fakeServices();
    const { interaction } = fakeInteraction('chat', { commandName: 'play' });

    await routeInteraction(interaction, services);

    expect(handlers.play).toHaveBeenCalledWith(interaction, services);
  });

  it('routes the administrator and information commands to their own handlers', async () => {
    const { services } = fakeServices();
    const setup = fakeInteraction('chat', { commandName: 'setup' });
    const settings = fakeInteraction('chat', { commandName: 'settings' });
    const help = fakeInteraction('chat', { commandName: 'help' });
    const status = fakeInteraction('chat', { commandName: 'status' });

    await routeInteraction(setup.interaction, services);
    await routeInteraction(settings.interaction, services);
    await routeInteraction(help.interaction, services);
    await routeInteraction(status.interaction, services);

    expect(handlers.setup).toHaveBeenCalledWith(setup.interaction);
    expect(handlers.settings).toHaveBeenCalledWith(settings.interaction, services);
    expect(handlers.help).toHaveBeenCalledWith(help.interaction, services);
    expect(handlers.status).toHaveBeenCalledWith(status.interaction, services);
  });

  it('refuses an unknown chat command with an ephemeral message', async () => {
    const { services } = fakeServices();
    const { interaction, reply } = fakeInteraction('chat', { commandName: 'nope' });

    await routeInteraction(interaction, services);

    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Неизвестная команда.', flags: MessageFlags.Ephemeral }),
    );
  });

  it('routes panel buttons with their action', async () => {
    const { services } = fakeServices();
    const { interaction } = fakeInteraction('button', { customId: 'melody:panel:toggle' });

    await routeInteraction(interaction, services);

    expect(handlers.panel).toHaveBeenCalledWith(interaction, services, 'toggle');
  });

  it('routes queue page buttons with the page number', async () => {
    const { services } = fakeServices();
    const { interaction } = fakeInteraction('button', { customId: 'melody:queue:page:3' });

    await routeInteraction(interaction, services);

    expect(handlers.queuePage).toHaveBeenCalledWith(interaction, services, 3);
  });

  it('routes playlist confirm and cancel buttons with their token', async () => {
    const { services } = fakeServices();
    const confirm = fakeInteraction('button', { customId: 'melody:playlist:confirm:tok123' });
    const cancel = fakeInteraction('button', { customId: 'melody:playlist:cancel:tok123' });

    await routeInteraction(confirm.interaction, services);
    await routeInteraction(cancel.interaction, services);

    expect(handlers.playlist).toHaveBeenNthCalledWith(
      1,
      confirm.interaction,
      services,
      'confirm',
      'tok123',
    );
    expect(handlers.playlist).toHaveBeenNthCalledWith(
      2,
      cancel.interaction,
      services,
      'cancel',
      'tok123',
    );
  });

  it('routes the setup create button and the setup and sources select menus', async () => {
    const { services } = fakeServices();
    const create = fakeInteraction('button', { customId: 'melody:setup:create' });
    const channel = fakeInteraction('channelSelect', { customId: 'melody:setup:channel' });
    const sources = fakeInteraction('stringSelect', { customId: 'melody:settings:sources' });

    await routeInteraction(create.interaction, services);
    await routeInteraction(channel.interaction, services);
    await routeInteraction(sources.interaction, services);

    expect(handlers.setupCreate).toHaveBeenCalledWith(create.interaction, services);
    expect(handlers.setupChannel).toHaveBeenCalledWith(channel.interaction, services);
    expect(handlers.sources).toHaveBeenCalledWith(sources.interaction, services);
  });

  it.each([
    ['a queue page that is not a number', 'button', 'melody:queue:page:abc'],
    ['a setup channel id sent as a button', 'button', 'melody:setup:channel'],
    ['a playlist action that is not confirm or cancel', 'button', 'melody:playlist:maybe:tok123'],
    ['a playlist button without a token', 'button', 'melody:playlist:confirm'],
    ['a custom id from another application', 'button', 'stranger:panel:toggle'],
    ['a select menu with an unknown id', 'stringSelect', 'melody:settings:unknown'],
  ] as const)('refuses %s', async (_label, kind, customId) => {
    const { services } = fakeServices();
    const { interaction, reply } = fakeInteraction(kind, { customId });

    await routeInteraction(interaction, services);

    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
    expect(handlers.panel).not.toHaveBeenCalled();
    expect(handlers.queuePage).not.toHaveBeenCalled();
    expect(handlers.playlist).not.toHaveBeenCalled();
    expect(handlers.setupChannel).not.toHaveBeenCalled();
    expect(handlers.sources).not.toHaveBeenCalled();
  });
});

describe('failure replies', () => {
  it('shows an application error text to the user ephemerally and does not log it as a failure', async () => {
    const { services, logger } = fakeServices();
    handlers.play.mockRejectedValueOnce(
      new AppError('NOT_IN_VOICE', 'Сначала зайдите в голосовой канал.'),
    );
    const { interaction, reply } = fakeInteraction('chat', { commandName: 'play' });

    await routeInteraction(interaction, services);

    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Сначала зайдите в голосовой канал.',
        flags: MessageFlags.Ephemeral,
      }),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('hides internal error details behind a generic text and logs them', async () => {
    const { services, logger } = fakeServices();
    handlers.play.mockRejectedValueOnce(
      new Error('SQLITE_CORRUPT at /data/melody.sqlite token=abc'),
    );
    const { interaction, reply } = fakeInteraction('chat', { commandName: 'play' });

    await routeInteraction(interaction, services);

    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Не удалось выполнить действие. Попробуйте позже.',
        flags: MessageFlags.Ephemeral,
      }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) as unknown }),
      expect.any(String),
    );
  });

  it('edits the deferred command reply instead of sending a second reply', async () => {
    const { services } = fakeServices();
    handlers.play.mockRejectedValueOnce(new AppError('INVALID_INPUT', 'Нет такой дорожки.'));
    const { interaction, editReply, reply } = fakeInteraction('chat', {
      commandName: 'play',
      deferred: true,
    });

    await routeInteraction(interaction, services);

    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Нет такой дорожки.' }),
    );
    expect(reply).not.toHaveBeenCalled();
  });

  it('sends an ephemeral follow-up when a deferred component fails', async () => {
    const { services } = fakeServices();
    handlers.panel.mockRejectedValueOnce(new AppError('BOT_BUSY', 'Бот занят другим действием.'));
    const { interaction, followUp, reply } = fakeInteraction('button', {
      customId: 'melody:panel:skip',
      deferred: true,
    });

    await routeInteraction(interaction, services);

    expect(followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Бот занят другим действием.',
        flags: MessageFlags.Ephemeral,
      }),
    );
    expect(reply).not.toHaveBeenCalled();
  });

  it('does not throw when the error reply itself cannot be delivered', async () => {
    const { services, logger } = fakeServices();
    handlers.play.mockRejectedValueOnce(new AppError('INTERNAL', 'Внутренняя ошибка.'));
    const { interaction, reply } = fakeInteraction('chat', { commandName: 'play' });
    reply.mockRejectedValueOnce(new Error('Unknown interaction'));

    await expect(routeInteraction(interaction, services)).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) as unknown }),
      expect.any(String),
    );
  });
});
