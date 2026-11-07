import type { ButtonInteraction, ChatInputCommandInteraction } from 'discord.js';
import { searchResultToDraft } from '../audio/providers/youtubeProvider.js';
import { buildSearchPicker, SEARCH_RESULT_LIMIT } from '../discord/ui/searchPicker.js';
import { AppError } from '../utils/errors.js';
import { truncate } from '../utils/format.js';
import {
  type ActionContext,
  chatContext,
  enqueueDrafts,
  prepareToEnqueue,
  privateButtonContext,
} from './actionContext.js';
import type { AppServices } from './context.js';

const SEARCH_TIMEOUT_MS = 25_000;
const MAX_QUERY_LENGTH = 200;

/**
 * Searches YouTube for the text and shows the best matches as numbered buttons. Only the member
 * who searched can pick. The list expires after two minutes.
 */
export async function showSearch(
  ctx: ActionContext,
  interaction: ChatInputCommandInteraction,
  query: string,
  playNext: boolean,
): Promise<void> {
  const { channel, settings } = prepareToEnqueue(ctx);
  if (!settings.allowedSources.includes('youtube') || !ctx.services.youtube.enabled) {
    throw new AppError('SOURCE_DISABLED', 'Поиск по YouTube отключён на этом сервере.');
  }
  if (query.length > MAX_QUERY_LENGTH) {
    throw new AppError(
      'INVALID_INPUT',
      `Запрос слишком длинный: до ${String(MAX_QUERY_LENGTH)} символов.`,
    );
  }

  await ctx.reply(`🔎 Ищу «${truncate(query, 80)}» на YouTube…`);
  const results = await ctx.services.youtube.search(
    query,
    SEARCH_RESULT_LIMIT,
    AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  );
  if (results.length === 0) {
    throw new AppError('NOT_FOUND', `По запросу «${truncate(query, 80)}» ничего не найдено.`);
  }

  const drafts = results.map(searchResultToDraft);
  const token = ctx.services.pendingSearches.add({
    guildId: ctx.guildId,
    userId: ctx.member.id,
    voiceChannelId: channel.id,
    tracks: drafts,
    playNext,
  });
  const picker = buildSearchPicker(query, drafts, token);
  await interaction.editReply({
    content: '',
    embeds: picker.embeds,
    components: picker.components,
    allowedMentions: { parse: [] },
  });
}

/** `/search`: the same list as /play with plain text, whatever the library holds. */
export async function handleSearchCommand(
  interaction: ChatInputCommandInteraction,
  services: AppServices,
): Promise<void> {
  const ctx = await chatContext(interaction, services);
  const query = interaction.options.getString('query', true).trim();
  if (query === '') {
    throw new AppError('INVALID_INPUT', 'Введите, что искать.');
  }
  await showSearch(ctx, interaction, query, false);
}

/** A number or the cancel button on a results list. */
export async function handleSearchButton(
  interaction: ButtonInteraction,
  services: AppServices,
  action: 'pick' | 'cancel',
  token: string,
  index: number,
): Promise<void> {
  await interaction.deferUpdate();
  const ctx = await privateButtonContext(interaction, services);
  const pending = services.pendingSearches.peek(token, ctx.guildId, ctx.member.id);
  if (pending === null) {
    await ctx.reply('Срок выбора истёк или список не ваш. Повторите поиск.');
    return;
  }
  if (action === 'cancel') {
    services.pendingSearches.remove(token);
    await ctx.reply('Поиск отменён.');
    return;
  }

  const draft = pending.tracks[index];
  if (draft === undefined) {
    throw new AppError('INVALID_INPUT', 'Такого варианта в списке нет.');
  }
  // Without this, the buttons would sit there while the track loads, and a second click would queue it twice.
  services.pendingSearches.remove(token);
  await interaction.editReply({
    content: `⏳ Загружаю «${truncate(draft.title, 80)}»…`,
    embeds: [],
    components: [],
  });
  await enqueueDrafts(ctx, [draft], { playNext: pending.playNext === true });
}
