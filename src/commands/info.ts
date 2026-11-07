import { EmbedBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { formatDuration } from '../utils/format.js';
import { deferEphemeral, type AppServices } from './context.js';

const HELP_LINES: readonly string[] = [
  '**Как включить музыку**',
  '`/play` — название (бот найдёт на YouTube и предложит 5 вариантов), ссылка YouTube или трек из библиотеки',
  '`/play file:` — **свой файл**: перетащите mp3, wav, flac, ogg или m4a в поле «file»',
  '`/search` — поиск на YouTube с выбором из 5 · `/play next:True` — поставить следующим',
  '',
  '**Управление** (то же есть кнопками под плеером)',
  '`/pause` · `/resume` · `/skip` · `/previous` · `/skipto`',
  '`/queue` · `/nowplaying` (перенести плеер в этот чат)',
  '`/remove` · `/clear` · `/shuffle` · `/loop` · `/volume`',
  '`/history` · `/replay` · `/playlist` (плейлист YouTube)',
  '`/favorites` — ваше избранное: ⭐ на плеере сохраняет трек',
  '',
  '**Голосовой канал**',
  '`/join` · `/move` (DJ) · `/stop` · `/leave`',
  '',
  '**Администрирование**',
  '`/setup` — закрепить канал плеера · `/settings` — настройки, сообщения бота (`announce`), режим 24/7 (`stay-247`)',
];

export async function handleHelp(
  interaction: ChatInputCommandInteraction,
  services: AppServices,
): Promise<void> {
  await deferEphemeral(interaction);
  const embed = new EmbedBuilder()
    .setTitle(`🎵 ${services.config.botName}: команды`)
    .setDescription(HELP_LINES.join('\n'))
    .setFooter({
      text: 'Бот пишет в чат о своих действиях. Сообщения об ошибках видны только вам.',
    });
  await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}

/** Shows readiness only. Tokens, file paths and user data are never included. */
export async function handleStatus(
  interaction: ChatInputCommandInteraction,
  services: AppServices,
): Promise<void> {
  await deferEphemeral(interaction);
  const uptimeSec = (Date.now() - services.startedAt) / 1000;
  const embed = new EmbedBuilder().setTitle(`📊 ${services.config.botName}: состояние`).addFields(
    { name: 'Работает', value: formatDuration(uptimeSec), inline: true },
    {
      name: 'База данных',
      value: services.status.databaseOk ? 'в порядке' : 'требует проверки',
      inline: true,
    },
    { name: 'FFmpeg', value: services.status.ffmpegVersion ?? 'не найден', inline: true },
    { name: 'Библиотека', value: `${String(services.catalog.size)} треков`, inline: true },
    {
      name: 'Доверенные потоки',
      value: services.streams.enabled ? 'включены' : 'выключены',
      inline: true,
    },
    {
      name: 'YouTube (экспериментально)',
      value: services.youtube.enabled ? 'включён' : 'выключен оператором',
      inline: true,
    },
  );
  await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}
