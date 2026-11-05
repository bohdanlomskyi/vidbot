import { EmbedBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { formatDuration } from '../utils/format.js';
import { deferEphemeral, type AppServices } from './context.js';

const HELP_LINES: readonly string[] = [
  '**Воспроизведение**',
  '`/play` — добавить трек: название, ссылка YouTube или идентификатор из каталога',
  '`/pause` · `/resume` · `/skip` — пауза, продолжение, пропуск',
  '`/queue` · `/nowplaying` — очередь и текущий трек',
  '`/remove` · `/clear` · `/shuffle` — правка очереди',
  '`/loop` · `/volume` — повтор и громкость',
  '`/history` · `/replay` — недавние треки и повтор последнего',
  '`/playlist` — плейлист YouTube с подтверждением',
  '',
  '**Голосовой канал**',
  '`/join` — подключить бота к вашему каналу',
  '`/move` — переместить бота (DJ или администратор)',
  '`/stop` · `/leave` — остановить и отключить бота',
  '',
  '**Администрирование**',
  '`/setup` — выбрать канал панели · `/settings` — настройки',
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
      text: 'Все команды отвечают только вам. Панель управления обновляется для всех.',
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
