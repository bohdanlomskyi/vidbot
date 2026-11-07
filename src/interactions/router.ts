import {
  MessageFlags,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type Interaction,
} from 'discord.js';
import {
  handleSetup,
  handleSetupChannel,
  handleSetupCreate,
  handleSettings,
  handleSourcesSelect,
} from '../commands/admin.js';
import type { AppServices } from '../commands/context.js';
import { responderFor } from '../commands/responder.js';
import { handleFavorites } from '../commands/favorites.js';
import { handleHelp, handleStatus } from '../commands/info.js';
import {
  handlePanelButton,
  handlePlaylistButton,
  handleQueuePage,
  PLAYBACK_COMMANDS,
} from '../commands/playback.js';
import { handleSearchButton, handleSearchCommand } from '../commands/search.js';
import { parseCustomId } from '../security/customIds.js';
import { AppError, isAppError, toUserMessage } from '../utils/errors.js';
import { formatDuration, truncate } from '../utils/format.js';

const AUTOCOMPLETE_LIMIT = 25;
const LIBRARY_SUGGESTIONS = 15;
const STREAM_SUGGESTIONS = 10;
const RATE_LIMIT_TEXT = 'Слишком часто. Подождите ';

/**
 * Entry point for every Discord interaction. It applies the per-user rate limit, dispatches
 * to the handler for the command or component, and turns any failure into a short,
 * ephemeral message. Unexpected failures are logged with their details. Users see only
 * the generic text.
 */
export async function routeInteraction(
  interaction: Interaction,
  services: AppServices,
): Promise<void> {
  try {
    if (interaction.isAutocomplete()) {
      await autocomplete(interaction, services);
      return;
    }

    checkRateLimit(interaction, services);
    if (interaction.isChatInputCommand()) {
      await dispatchCommand(interaction, services);
      return;
    }
    if (interaction.isButton()) {
      await dispatchButton(interaction, services);
      return;
    }
    if (interaction.isChannelSelectMenu()) {
      const parsed = parseCustomId(interaction.customId);
      if (parsed?.feature === 'setup' && parsed.action === 'channel') {
        await handleSetupChannel(interaction, services);
        return;
      }
    }
    if (interaction.isStringSelectMenu()) {
      const parsed = parseCustomId(interaction.customId);
      if (parsed?.feature === 'settings' && parsed.action === 'sources') {
        await handleSourcesSelect(interaction, services);
        return;
      }
    }
    throw new AppError('INVALID_INPUT', 'Это действие больше не доступно.');
  } catch (error) {
    await reportFailure(interaction, services, asMissingOption(error) ?? error);
  }
}

function checkRateLimit(interaction: Interaction, services: AppServices): void {
  const key = `${interaction.guildId ?? 'direct'}:${interaction.user.id}`;
  const decision = services.rateLimiter.consume(key);
  if (!decision.allowed) {
    const seconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
    throw new AppError('RATE_LIMITED', `${RATE_LIMIT_TEXT}${String(seconds)} с.`);
  }
}

async function dispatchCommand(
  interaction: Parameters<typeof handleSetup>[0],
  services: AppServices,
): Promise<void> {
  switch (interaction.commandName) {
    case 'setup':
      await handleSetup(interaction);
      return;
    case 'settings':
      await handleSettings(interaction, services);
      return;
    case 'help':
      await handleHelp(interaction, services);
      return;
    case 'search':
      await handleSearchCommand(interaction, services);
      return;
    case 'favorites':
      await handleFavorites(interaction, services);
      return;
    case 'status':
      await handleStatus(interaction, services);
      return;
    default: {
      const handler = PLAYBACK_COMMANDS[interaction.commandName];
      if (handler === undefined) {
        throw new AppError('INVALID_INPUT', 'Неизвестная команда.');
      }
      await handler(interaction, services);
    }
  }
}

async function dispatchButton(
  interaction: ButtonInteraction,
  services: AppServices,
): Promise<void> {
  const parsed = parseCustomId(interaction.customId);
  if (parsed === null) {
    throw new AppError('INVALID_INPUT', 'Эта кнопка больше не работает.');
  }
  switch (parsed.feature) {
    case 'panel':
      await handlePanelButton(interaction, services, parsed.action);
      return;
    case 'queue': {
      const page = Number(parsed.args[0]);
      if (parsed.action !== 'page' || !Number.isInteger(page)) {
        break;
      }
      await handleQueuePage(interaction, services, page);
      return;
    }
    case 'setup':
      if (parsed.action === 'create') {
        await handleSetupCreate(interaction, services);
        return;
      }
      break;
    case 'search': {
      const [token, index] = parsed.args;
      if (token !== undefined && (parsed.action === 'pick' || parsed.action === 'cancel')) {
        const position = Number(index ?? '0');
        if (Number.isInteger(position)) {
          await handleSearchButton(interaction, services, parsed.action, token, position);
          return;
        }
      }
      break;
    }
    case 'playlist': {
      const token = parsed.args[0];
      if ((parsed.action === 'confirm' || parsed.action === 'cancel') && token !== undefined) {
        await handlePlaylistButton(interaction, services, parsed.action, token);
        return;
      }
      break;
    }
    default:
      break;
  }
  throw new AppError('INVALID_INPUT', 'Эта кнопка больше не работает.');
}

async function autocomplete(
  interaction: AutocompleteInteraction,
  services: AppServices,
): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (interaction.commandName !== 'play' || focused.name !== 'source') {
    await interaction.respond([]);
    return;
  }

  const query = focused.value.trim();
  const choices: { name: string; value: string }[] = [];
  if (query !== '') {
    for (const row of services.catalog.search(query, LIBRARY_SUGGESTIONS)) {
      const artist = row.artist !== null ? ` — ${row.artist}` : '';
      const duration = row.durationSec !== null ? ` (${formatDuration(row.durationSec)})` : '';
      choices.push({ name: truncate(`${row.title}${artist}${duration}`, 100), value: row.id });
    }
    for (const entry of services.streams.suggest(query, STREAM_SUGGESTIONS)) {
      choices.push({ name: truncate(`Поток: ${entry.title}`, 100), value: entry.id });
    }
  }
  await interaction.respond(choices.slice(0, AUTOCOMPLETE_LIMIT));
}

/**
 * Discord throws inside the handler when a required option is missing. That is an input problem,
 * so it becomes a short user message instead of an internal error in the log.
 */
function asMissingOption(error: unknown): AppError | null {
  if (
    error instanceof Error &&
    'code' in error &&
    error.code === 'CommandInteractionOptionNotFound'
  ) {
    return new AppError('INVALID_INPUT', 'Заполните все поля команды и отправьте её снова.', {
      cause: error,
    });
  }
  return null;
}

/** Sends the error text without leaking internals. Answers ephemerally, whatever state the interaction is in. */
async function reportFailure(
  interaction: Interaction,
  services: AppServices,
  error: unknown,
): Promise<void> {
  const text = toUserMessage(error, 'Не удалось выполнить действие. Попробуйте позже.');
  if (isAppError(error)) {
    services.logger.debug({ code: error.code, command: describe(interaction) }, 'Request refused');
  } else {
    services.logger.error({ err: error, command: describe(interaction) }, 'Interaction failed');
  }

  if (interaction.isAutocomplete() || !interaction.isRepliable()) {
    return;
  }
  try {
    const responder = responderFor(interaction);
    if (responder !== undefined) {
      // It knows what was already sent, and waits for a placeholder that is still on its way.
      await responder.private(text);
      return;
    }
    if (interaction.isChatInputCommand() && interaction.deferred) {
      await interaction.editReply({ content: text, embeds: [], components: [] });
      return;
    }
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({
        content: text,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }
    await interaction.reply({
      content: text,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  } catch (replyError) {
    services.logger.warn({ err: replyError }, 'Could not deliver the error message');
  }
}

function describe(interaction: Interaction): string {
  if (interaction.isChatInputCommand()) {
    return interaction.commandName;
  }
  if (interaction.isButton() || interaction.isAnySelectMenu()) {
    return parseCustomId(interaction.customId)?.feature ?? 'component';
  }
  return interaction.type.toString();
}
