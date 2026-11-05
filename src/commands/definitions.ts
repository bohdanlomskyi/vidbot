import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

/**
 * Slash command definitions. Names are short English identifiers, as the specification
 * requires. Descriptions and option texts are Russian and within Discord's limits. The
 * administrator commands are hidden from other members by default through Manage Server.
 */
export const COMMAND_DEFINITIONS = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Добавить трек в очередь или начать воспроизведение')
    .addStringOption((option) =>
      option
        .setName('source')
        .setDescription('Название трека, идентификатор из каталога или ссылка YouTube')
        .setRequired(true)
        .setAutocomplete(true)
        .setMaxLength(500),
    ),
  new SlashCommandBuilder().setName('pause').setDescription('Поставить воспроизведение на паузу'),
  new SlashCommandBuilder().setName('resume').setDescription('Продолжить воспроизведение'),
  new SlashCommandBuilder().setName('skip').setDescription('Пропустить текущий трек'),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Остановить воспроизведение, очистить очередь и отключиться'),
  new SlashCommandBuilder().setName('queue').setDescription('Показать очередь воспроизведения'),
  new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Показать текущий трек и панель управления'),
  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Удалить трек из очереди по номеру')
    .addIntegerOption((option) =>
      option
        .setName('position')
        .setDescription('Номер трека в очереди')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(500),
    ),
  new SlashCommandBuilder().setName('clear').setDescription('Очистить ожидающую очередь'),
  new SlashCommandBuilder().setName('shuffle').setDescription('Перемешать ожидающую очередь'),
  new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Режим повтора')
    .addStringOption((option) =>
      option
        .setName('mode')
        .setDescription('Что повторять')
        .setRequired(true)
        .addChoices(
          { name: 'Выключен', value: 'off' },
          { name: 'Текущий трек', value: 'track' },
          { name: 'Вся очередь', value: 'queue' },
        ),
    ),
  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Установить громкость от 0 до 100 %')
    .addIntegerOption((option) =>
      option
        .setName('value')
        .setDescription('Громкость в процентах')
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(100),
    ),
  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Подключить бота к вашему голосовому каналу без запуска музыки'),
  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Отключить бота от голосового канала и очистить очередь'),
  new SlashCommandBuilder()
    .setName('move')
    .setDescription('Переместить бота в другой голосовой канал (DJ или администратор)')
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('Голосовой канал назначения')
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice),
    ),
  new SlashCommandBuilder().setName('history').setDescription('Показать недавно сыгранные треки'),
  new SlashCommandBuilder()
    .setName('replay')
    .setDescription('Поставить в очередь последний успешно сыгранный трек'),
  new SlashCommandBuilder()
    .setName('playlist')
    .setDescription('Добавить треки из плейлиста YouTube (нужен включённый модуль YouTube)')
    .addStringOption((option) =>
      option
        .setName('source')
        .setDescription('Ссылка на плейлист YouTube')
        .setRequired(true)
        .setMaxLength(500),
    ),
  new SlashCommandBuilder().setName('help').setDescription('Список команд и краткая инструкция'),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Состояние бота и настроенные источники'),
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Выбрать текстовый канал для панели управления (администраторы)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('settings')
    .setDescription('Настройки музыкального бота (администраторы)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) => sub.setName('show').setDescription('Показать текущие настройки'))
    .addSubcommand((sub) =>
      sub
        .setName('idle-timeout')
        .setDescription('Отключаться после простоя без музыки, в секундах')
        .addIntegerOption((option) =>
          option
            .setName('seconds')
            .setDescription('От 10 до 3600')
            .setRequired(true)
            .setMinValue(10)
            .setMaxValue(3600),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('empty-timeout')
        .setDescription('Отключаться, если в канале никого нет, в секундах')
        .addIntegerOption((option) =>
          option
            .setName('seconds')
            .setDescription('От 10 до 600')
            .setRequired(true)
            .setMinValue(10)
            .setMaxValue(600),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('queue-limit')
        .setDescription('Максимальный размер очереди')
        .addIntegerOption((option) =>
          option
            .setName('size')
            .setDescription('От 1 до 500')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(500),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('max-duration')
        .setDescription('Максимальная длительность трека, в минутах')
        .addIntegerOption((option) =>
          option
            .setName('minutes')
            .setDescription('От 1 до 360')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(360),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('default-volume')
        .setDescription('Громкость, с которой начинается новая сессия')
        .addIntegerOption((option) =>
          option
            .setName('value')
            .setDescription('От 0 до 100')
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(100),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('dj-role')
        .setDescription('Назначить DJ-роль; без роли настройка снимается')
        .addRoleOption((option) =>
          option.setName('role').setDescription('Роль DJ').setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('policy')
        .setDescription('Кто может управлять воспроизведением')
        .addStringOption((option) =>
          option
            .setName('mode')
            .setDescription('Режим управления')
            .setRequired(true)
            .addChoices(
              { name: 'Все слушатели канала', value: 'everyone' },
              { name: 'Только DJ и администраторы', value: 'dj' },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('skip-vote')
        .setDescription('Голосование за пропуск: процент слушателей, 0 — выключено')
        .addIntegerOption((option) =>
          option
            .setName('percent')
            .setDescription('От 0 до 100')
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(100),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('sources').setDescription('Выбрать разрешённые источники аудио'),
    ),
] as const;
