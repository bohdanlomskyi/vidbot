/**
 * The few Discord REST calls the setup wizard needs. They use only the bot token and never
 * echo it: errors describe what went wrong, not the value that was sent.
 */

const API = 'https://discord.com/api/v10';
const TIMEOUT_MS = 15_000;
/** View Channels, Send Messages, Embed Links, Connect, Speak, and Manage Channels for /setup. */
const PERMISSIONS = 1024 + 2048 + 16_384 + 1_048_576 + 2_097_152 + 16;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/u;

export type SetupErrorCode = 'INVALID_TOKEN' | 'NETWORK' | 'DISCORD';

export class SetupError extends Error {
  constructor(
    readonly code: SetupErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SetupError';
  }
}

export interface DiscordEntity {
  readonly id: string;
  readonly name: string;
}

export function inviteUrl(clientId: string): string {
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('scope', 'bot applications.commands');
  url.searchParams.set('permissions', String(PERMISSIONS));
  return url.toString();
}

/** A bot token has three dot-separated parts. This catches a pasted Client ID or "Bot " prefix. */
export function looksLikeToken(value: string): boolean {
  return TOKEN_SHAPE.test(value);
}

async function getJson(path: string, token: string, fetchImpl: typeof fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(`${API}${path}`, {
      headers: { authorization: `Bot ${token}`, 'user-agent': 'Melody setup' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new SetupError(
      'NETWORK',
      'Не удалось связаться с Discord. Проверьте интернет, VPN и брандмауэр.',
    );
  }
  if (response.status === 401) {
    throw new SetupError(
      'INVALID_TOKEN',
      'Discord не принял токен. Скопируйте его заново: Developer Portal → Bot → Reset Token.',
    );
  }
  if (!response.ok) {
    throw new SetupError('DISCORD', `Discord ответил ошибкой ${String(response.status)}.`);
  }
  return response.json();
}

function toEntity(value: unknown): DiscordEntity | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const { id, name } = value as { id?: unknown; name?: unknown };
  return typeof id === 'string' && typeof name === 'string' ? { id, name } : null;
}

/** The application the token belongs to. Its ID is the Client ID used for commands. */
export async function fetchBotApplication(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscordEntity> {
  const entity = toEntity(await getJson('/applications/@me', token, fetchImpl));
  if (entity === null) {
    throw new SetupError('DISCORD', 'Discord вернул неожиданный ответ.');
  }
  return entity;
}

/** The servers the bot has been added to. */
export async function fetchBotGuilds(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscordEntity[]> {
  const body = await getJson('/users/@me/guilds', token, fetchImpl);
  if (!Array.isArray(body)) {
    throw new SetupError('DISCORD', 'Discord вернул неожиданный ответ.');
  }
  return body.map(toEntity).filter((entity): entity is DiscordEntity => entity !== null);
}
