import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ChannelSelectMenuBuilder,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ChannelSelectMenuInteraction,
  type GuildMember,
  type StringSelectMenuInteraction,
  type Guild,
  type GuildTextBasedChannel,
} from 'discord.js';
import { buildCustomId } from '../security/customIds.js';
import type { SourceKind } from '../music/models/track.js';
import { AppError } from '../utils/errors.js';
import { formatDuration } from '../utils/format.js';
import { deferEphemeral, requireGuildMember, sayEphemeral, type AppServices } from './context.js';

const PANEL_CHANNEL_NAME = 'melody-music';
const REQUIRED_PANEL_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
];

const ANNOUNCE_TEXT = {
  all: 'Бот будет писать в чат о каждом действии и событии.',
  important: 'Бот будет писать в чат только о важном: треки, отключения, ошибки.',
  off: 'Бот не будет писать в чат о действиях. Панель плеера останется.',
} as const;

const SOURCE_LABELS: Readonly<Record<SourceKind, string>> = {
  local: 'Библиотека сервера',
  stream: 'Доверенные потоки',
  youtube: 'YouTube (экспериментально)',
};

/** Administrator actions also re-check the permission server-side. Discord's default is only a UI hint. */
function assertAdmin(member: GuildMember): void {
  if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    throw new AppError('NOT_ALLOWED', 'Настройка доступна администраторам сервера.');
  }
}

function assertPanelChannelUsable(guild: Guild, channel: GuildTextBasedChannel): void {
  const me = guild.members.me;
  if (me === null || !me.permissionsIn(channel).has(REQUIRED_PANEL_PERMISSIONS)) {
    throw new AppError(
      'PERMISSION_MISSING',
      'В выбранном канале боту нужны права: просмотр канала, отправка сообщений и встраивание ссылок.',
    );
  }
}

/** `/setup`: choose an existing text channel, or create one when the bot is allowed to. */
export async function handleSetup(interaction: ChatInputCommandInteraction): Promise<void> {
  await deferEphemeral(interaction);
  const { guild, member } = await requireGuildMember(interaction);
  assertAdmin(member);

  const picker = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId(buildCustomId('setup', 'channel'))
      .setPlaceholder('Выберите текстовый канал')
      .setChannelTypes(ChannelType.GuildText)
      .setMinValues(1)
      .setMaxValues(1),
  );
  const rows: ActionRowBuilder<ChannelSelectMenuBuilder | ButtonBuilder>[] = [picker];
  if (guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels) === true) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(buildCustomId('setup', 'create'))
          .setLabel(`Создать канал «${PANEL_CHANNEL_NAME}»`)
          .setStyle(ButtonStyle.Secondary),
      ),
    );
  }
  await interaction.editReply({
    content: 'Выберите канал, где будет панель управления музыкой. Бот будет обновлять её сам.',
    components: rows,
  });
}

export async function handleSetupChannel(
  interaction: ChannelSelectMenuInteraction,
  services: AppServices,
): Promise<void> {
  await interaction.deferUpdate();
  const { guild, member, guildId } = await requireGuildMember(interaction);
  assertAdmin(member);

  const channelId = interaction.values[0];
  const channel =
    channelId === undefined ? undefined : (guild.channels.cache.get(channelId) ?? undefined);
  if (channel === undefined || !channel.isTextBased() || !('guildId' in channel)) {
    throw new AppError('INVALID_INPUT', 'Выберите текстовый канал сервера.');
  }
  assertPanelChannelUsable(guild, channel);
  await services.panel.create(guildId, channel);
  await interaction.editReply({
    content: `Панель создана в канале <#${channel.id}>.`,
    components: [],
  });
}

export async function handleSetupCreate(
  interaction: ButtonInteraction,
  services: AppServices,
): Promise<void> {
  await interaction.deferUpdate();
  const { guild, member, guildId } = await requireGuildMember(interaction);
  assertAdmin(member);
  if (guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels) !== true) {
    throw new AppError(
      'PERMISSION_MISSING',
      'Для создания канала боту нужно право «Управление каналами».',
    );
  }

  const channel = await guild.channels.create({
    name: PANEL_CHANNEL_NAME,
    type: ChannelType.GuildText,
    topic:
      'Музыкальная панель Melody. Используйте кнопки под сообщением или команды /play и /help.',
    reason: 'Создан командой /setup для панели музыки',
  });
  await services.panel.create(guildId, channel);
  await interaction.editReply({
    content: `Создан канал <#${channel.id}>, панель готова.`,
    components: [],
  });
}

/** `/settings`: every subcommand validates its value through the repository before saving. */
export async function handleSettings(
  interaction: ChatInputCommandInteraction,
  services: AppServices,
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'sources') {
    await showSourcesMenu(interaction, services);
    return;
  }

  await deferEphemeral(interaction);
  const { member, guildId } = await requireGuildMember(interaction);
  assertAdmin(member);

  const settings = services.settings;
  const patch = (update: Parameters<typeof settings.patch>[1]): string => {
    settings.patch(guildId, update);
    services.panel.requestRefresh(guildId);
    return '';
  };

  let message: string;
  switch (subcommand) {
    case 'show':
      await interaction.editReply({
        embeds: [settingsEmbed(services, guildId)],
        allowedMentions: { parse: [] },
      });
      return;
    case 'idle-timeout':
      patch({ idleTimeoutSec: interaction.options.getInteger('seconds', true) });
      message = `Отключение после простоя: ${String(interaction.options.getInteger('seconds', true))} с.`;
      break;
    case 'empty-timeout':
      patch({ emptyTimeoutSec: interaction.options.getInteger('seconds', true) });
      message = `Отключение, если канал пуст: ${String(interaction.options.getInteger('seconds', true))} с.`;
      break;
    case 'queue-limit':
      patch({ queueLimit: interaction.options.getInteger('size', true) });
      message = `Размер очереди: ${String(interaction.options.getInteger('size', true))}.`;
      break;
    case 'max-duration':
      patch({ maxTrackSec: interaction.options.getInteger('minutes', true) * 60 });
      message = `Максимальная длительность трека: ${String(interaction.options.getInteger('minutes', true))} мин.`;
      break;
    case 'default-volume':
      patch({ defaultVolume: interaction.options.getInteger('value', true) });
      message = `Громкость по умолчанию: ${String(interaction.options.getInteger('value', true))} %.`;
      break;
    case 'dj-role': {
      const role = interaction.options.getRole('role');
      patch({ djRoleId: role?.id ?? null });
      message = role !== null ? `DJ-роль: ${role.name}.` : 'DJ-роль снята.';
      break;
    }
    case 'policy': {
      const mode = interaction.options.getString('mode', true) === 'dj' ? 'dj' : 'everyone';
      patch({ controlPolicy: mode });
      message =
        mode === 'dj'
          ? 'Управлять могут только DJ и администраторы.'
          : 'Управлять может любой слушатель канала.';
      break;
    }
    case 'skip-vote': {
      const percent = interaction.options.getInteger('percent', true);
      patch({ skipVotePercent: percent });
      message =
        percent === 0
          ? 'Голосование за пропуск выключено.'
          : `Пропуск по голосованию: ${String(percent)} % слушателей.`;
      break;
    }
    case 'announce': {
      const raw = interaction.options.getString('mode', true);
      const mode = raw === 'important' || raw === 'off' ? raw : 'all';
      patch({ announceMode: mode });
      message = ANNOUNCE_TEXT[mode];
      break;
    }
    case 'stay-247': {
      const enabled = interaction.options.getBoolean('enabled', true);
      patch({ stayConnected: enabled });
      // Timers are re-evaluated now, so a bot that sits idle starts or stops its countdown at once.
      await services.engine.handleListenersChanged(guildId);
      message = enabled
        ? 'Режим 24/7 включён: бот не покидает канал при простое и пустоте. Выключить: /settings stay-247 enabled:False.'
        : 'Режим 24/7 выключен: бот снова отключается по таймерам.';
      break;
    }
    default:
      throw new AppError('INVALID_INPUT', 'Неизвестная настройка.');
  }
  await sayEphemeral(interaction, message);
}

async function showSourcesMenu(
  interaction: ChatInputCommandInteraction,
  services: AppServices,
): Promise<void> {
  const { member, guildId } = await requireGuildMember(interaction);
  assertAdmin(member);

  const current = services.settings.get(guildId).allowedSources;
  const kinds: SourceKind[] = services.youtube.enabled
    ? ['local', 'stream', 'youtube']
    : ['local', 'stream'];
  const menu = new StringSelectMenuBuilder()
    .setCustomId(buildCustomId('settings', 'sources'))
    .setPlaceholder('Разрешённые источники')
    .setMinValues(1)
    .setMaxValues(kinds.length)
    .addOptions(
      kinds.map((kind) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(SOURCE_LABELS[kind])
          .setValue(kind)
          .setDefault(current.includes(kind)),
      ),
    );

  await interaction.reply({
    content: 'Выберите источники, которые может использовать этот сервер.',
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleSourcesSelect(
  interaction: StringSelectMenuInteraction,
  services: AppServices,
): Promise<void> {
  await interaction.deferUpdate();
  const { member, guildId } = await requireGuildMember(interaction);
  assertAdmin(member);

  const selected = interaction.values.filter(
    (value): value is SourceKind => value === 'local' || value === 'stream' || value === 'youtube',
  );
  const allowed = selected.filter((kind) => kind !== 'youtube' || services.youtube.enabled);
  services.settings.patch(guildId, { allowedSources: allowed });
  services.panel.requestRefresh(guildId);
  await interaction.editReply({
    content: `Разрешённые источники: ${allowed.map((kind) => SOURCE_LABELS[kind]).join(', ')}.`,
    components: [],
  });
}

function settingsEmbed(services: AppServices, guildId: string): EmbedBuilder {
  const settings = services.settings.get(guildId);
  return new EmbedBuilder().setTitle('⚙️ Настройки музыки').addFields(
    {
      name: 'Панель',
      value: settings.textChannelId !== null ? `<#${settings.textChannelId}>` : 'не настроена',
      inline: true,
    },
    {
      name: 'Управление',
      value: settings.controlPolicy === 'dj' ? 'только DJ' : 'все слушатели',
      inline: true,
    },
    {
      name: 'DJ-роль',
      value: settings.djRoleId !== null ? `<@&${settings.djRoleId}>` : 'не задана',
      inline: true,
    },
    { name: 'Простой до отключения', value: formatDuration(settings.idleTimeoutSec), inline: true },
    {
      name: 'Пустой канал до отключения',
      value: formatDuration(settings.emptyTimeoutSec),
      inline: true,
    },
    { name: 'Очередь', value: String(settings.queueLimit), inline: true },
    {
      name: 'Макс. длительность',
      value: `${String(settings.maxTrackSec / 60)} мин.`,
      inline: true,
    },
    { name: 'Громкость по умолчанию', value: `${String(settings.defaultVolume)} %`, inline: true },
    {
      name: 'Пропуск по голосованию',
      value: settings.skipVotePercent === 0 ? 'выключено' : `${String(settings.skipVotePercent)} %`,
      inline: true,
    },
    {
      name: 'Сообщения в чате',
      value:
        settings.announceMode === 'all'
          ? 'всё'
          : settings.announceMode === 'important'
            ? 'только важное'
            : 'выключены',
      inline: true,
    },
    { name: 'Режим 24/7', value: settings.stayConnected ? 'включён' : 'выключен', inline: true },
    {
      name: 'Источники',
      value: settings.allowedSources.map((kind) => SOURCE_LABELS[kind]).join(', '),
      inline: false,
    },
  );
}

/** Used by the router to tell a member has permission before running the handler. */
export const ADMIN_PERMISSION = PermissionFlagsBits.ManageGuild;
export type { GuildTextBasedChannel };
