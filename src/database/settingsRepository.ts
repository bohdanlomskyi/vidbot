import { isValidLengthLimit } from '../music/lengthLimit.js';
import { z } from 'zod';
import type { SourceKind } from '../music/models/track.js';
import type { SqliteDatabase } from './db.js';

export type ControlPolicy = 'everyone' | 'dj';
/** Which actions the bot writes about in the chat: everything, only important events, or nothing. */
export type AnnounceMode = 'all' | 'important' | 'off';

const SOURCE_KINDS = ['local', 'stream', 'youtube'] as const;
const snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord snowflake');

/** Values for a new guild. They come from the environment configuration. */
export interface GuildSettingsDefaults {
  readonly queueLimit: number;
  readonly maxTrackSec: number;
  readonly idleTimeoutSec: number;
  readonly emptyTimeoutSec: number;
  readonly defaultVolume: number;
  readonly allowedSources: readonly SourceKind[];
}

export interface GuildSettings {
  readonly guildId: string;
  readonly textChannelId: string | null;
  readonly panelMessageId: string | null;
  readonly djRoleId: string | null;
  readonly controlPolicy: ControlPolicy;
  readonly idleTimeoutSec: number;
  readonly emptyTimeoutSec: number;
  readonly queueLimit: number;
  readonly maxTrackSec: number;
  readonly defaultVolume: number;
  readonly skipVotePercent: number;
  readonly allowedSources: readonly SourceKind[];
  readonly announceMode: AnnounceMode;
  /** 24/7 mode: the bot stays in its voice channel instead of leaving when idle or alone. */
  readonly stayConnected: boolean;
}

/** Only the fields a command may change. Unknown keys are rejected. */
export const settingsPatchSchema = z
  .object({
    textChannelId: snowflake.nullable().optional(),
    djRoleId: snowflake.nullable().optional(),
    controlPolicy: z.enum(['everyone', 'dj']).optional(),
    idleTimeoutSec: z.number().int().min(10).max(3600).optional(),
    emptyTimeoutSec: z.number().int().min(10).max(600).optional(),
    queueLimit: z.number().int().min(1).max(500).optional(),
    maxTrackSec: z.number().int().refine(isValidLengthLimit).optional(),
    defaultVolume: z.number().int().min(0).max(100).optional(),
    skipVotePercent: z.number().int().min(0).max(100).optional(),
    allowedSources: z.array(z.enum(SOURCE_KINDS)).min(1).max(3).optional(),
    announceMode: z.enum(['all', 'important', 'off']).optional(),
    stayConnected: z.boolean().optional(),
  })
  .strict();

export type GuildSettingsPatch = z.input<typeof settingsPatchSchema>;

const COLUMN_BY_FIELD: Readonly<Record<keyof GuildSettingsPatch, string>> = {
  textChannelId: 'text_channel_id',
  djRoleId: 'dj_role_id',
  controlPolicy: 'control_policy',
  idleTimeoutSec: 'idle_timeout_sec',
  emptyTimeoutSec: 'empty_timeout_sec',
  queueLimit: 'queue_limit',
  maxTrackSec: 'max_track_sec',
  defaultVolume: 'default_volume',
  skipVotePercent: 'skip_vote_percent',
  allowedSources: 'allowed_sources',
  announceMode: 'announce_mode',
  stayConnected: 'stay_connected',
};

const sourceListSchema = z.array(z.enum(SOURCE_KINDS));

interface SettingsRow {
  readonly guild_id: string;
  readonly text_channel_id: string | null;
  readonly panel_message_id: string | null;
  readonly dj_role_id: string | null;
  readonly control_policy: string;
  readonly idle_timeout_sec: number;
  readonly empty_timeout_sec: number;
  readonly queue_limit: number;
  readonly max_track_sec: number;
  readonly default_volume: number;
  readonly skip_vote_percent: number;
  readonly allowed_sources: string;
  readonly announce_mode: string;
  readonly stay_connected: number;
}

/**
 * Per-guild settings. Rows appear on first use with the configured defaults. Patches are
 * validated before they reach the database. Column names come from a fixed map, never
 * from user input.
 */
export class GuildSettingsRepository {
  private readonly insertDefaults;
  private readonly selectRow;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly defaults: GuildSettingsDefaults,
  ) {
    this.insertDefaults = db.prepare(`
      INSERT OR IGNORE INTO guild_settings
        (guild_id, idle_timeout_sec, empty_timeout_sec, queue_limit, max_track_sec, default_volume, allowed_sources)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.selectRow = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?');
  }

  get(guildId: string): GuildSettings {
    this.insertDefaults.run(
      guildId,
      this.defaults.idleTimeoutSec,
      this.defaults.emptyTimeoutSec,
      this.defaults.queueLimit,
      this.defaults.maxTrackSec,
      this.defaults.defaultVolume,
      JSON.stringify(this.defaults.allowedSources),
    );
    const row = this.selectRow.get(guildId) as SettingsRow;
    return this.toSettings(row);
  }

  patch(guildId: string, input: GuildSettingsPatch): GuildSettings {
    const values = settingsPatchSchema.parse(input);
    this.get(guildId);

    const assignments: string[] = [];
    const params: unknown[] = [];
    for (const field of Object.keys(COLUMN_BY_FIELD) as (keyof GuildSettingsPatch)[]) {
      const value = values[field];
      if (value === undefined) {
        continue;
      }
      assignments.push(`${COLUMN_BY_FIELD[field]} = ?`);
      params.push(encodeValue(field, value));
    }
    if (assignments.length > 0) {
      assignments.push('updated_at = CURRENT_TIMESTAMP');
      this.db
        .prepare(`UPDATE guild_settings SET ${assignments.join(', ')} WHERE guild_id = ?`)
        .run(...params, guildId);
    }
    return this.get(guildId);
  }

  setPanel(guildId: string, channelId: string, messageId: string): void {
    this.get(guildId);
    this.db
      .prepare(
        'UPDATE guild_settings SET text_channel_id = ?, panel_message_id = ?, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ?',
      )
      .run(channelId, messageId, guildId);
  }

  clearPanelMessage(guildId: string): void {
    this.get(guildId);
    this.db
      .prepare(
        'UPDATE guild_settings SET panel_message_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ?',
      )
      .run(guildId);
  }

  private toSettings(row: SettingsRow): GuildSettings {
    const parsed = sourceListSchema.safeParse(parseJson(row.allowed_sources));
    return {
      guildId: row.guild_id,
      textChannelId: row.text_channel_id,
      panelMessageId: row.panel_message_id,
      djRoleId: row.dj_role_id,
      controlPolicy: row.control_policy === 'dj' ? 'dj' : 'everyone',
      idleTimeoutSec: row.idle_timeout_sec,
      emptyTimeoutSec: row.empty_timeout_sec,
      queueLimit: row.queue_limit,
      maxTrackSec: row.max_track_sec,
      defaultVolume: row.default_volume,
      skipVotePercent: row.skip_vote_percent,
      // A corrupt value falls back to the configured defaults instead of failing the command.
      allowedSources: parsed.success ? parsed.data : this.defaults.allowedSources,
      announceMode:
        row.announce_mode === 'important' || row.announce_mode === 'off'
          ? row.announce_mode
          : 'all',
      stayConnected: row.stay_connected === 1,
    };
  }
}

function encodeValue(field: keyof GuildSettingsPatch, value: unknown): unknown {
  if (field === 'allowedSources') {
    return JSON.stringify(value);
  }
  return typeof value === 'boolean' ? Number(value) : value;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
