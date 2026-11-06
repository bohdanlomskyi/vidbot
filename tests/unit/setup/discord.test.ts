import { describe, expect, it } from 'vitest';
import {
  fetchBotApplication,
  fetchBotGuilds,
  inviteUrl,
  looksLikeToken,
  SetupError,
} from '../../../src/setup/discord.js';

function respond(status: number, body: unknown): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
}

describe('inviteUrl', () => {
  it('asks for the bot and command scopes and only the permissions Melody uses', () => {
    const url = new URL(inviteUrl('123456789012345678'));

    expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe('123456789012345678');
    expect(url.searchParams.get('scope')).toBe('bot applications.commands');
    // View Channels, Send Messages, Embed Links, Connect, Speak and Manage Channels; no Administrator.
    expect(url.searchParams.get('permissions')).toBe('3165200');
  });
});

describe('looksLikeToken', () => {
  it('accepts the three-part bot token shape and rejects obvious mistakes', () => {
    // Shaped like a token but not one: real tokens start with M or N, this starts with x.
    expect(
      looksLikeToken('xTIzNDU2Nzg5MDEyMzQ1Njc4OQ.GaBc-e.abcdefghijklmnopqrstuvwxyz01234'),
    ).toBe(true);
    expect(looksLikeToken('123456789012345678')).toBe(false);
    expect(looksLikeToken('Bot MTIz.abc.def')).toBe(false);
    expect(looksLikeToken('')).toBe(false);
  });
});

describe('fetchBotApplication', () => {
  it('reads the application ID and name, so the Client ID always matches the token', async () => {
    let seen: Request | undefined;
    const fake = ((input: string | URL | Request, init?: RequestInit) => {
      seen = new Request(input, init);
      return Promise.resolve(Response.json({ id: '123456789012345678', name: 'Melody' }));
    }) as typeof fetch;

    await expect(fetchBotApplication('token-value', fake)).resolves.toEqual({
      id: '123456789012345678',
      name: 'Melody',
    });
    expect(seen?.url).toBe('https://discord.com/api/v10/applications/@me');
    expect(seen?.headers.get('authorization')).toBe('Bot token-value');
  });

  it('explains a rejected token without echoing it', async () => {
    const error: unknown = await fetchBotApplication('secret-token', respond(401, {})).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(SetupError);
    expect((error as SetupError).code).toBe('INVALID_TOKEN');
    expect((error as Error).message).not.toContain('secret-token');
  });

  it('reports a network failure separately from a wrong token', async () => {
    const offline = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;

    await expect(fetchBotApplication('t', offline)).rejects.toMatchObject({ code: 'NETWORK' });
  });
});

describe('fetchBotGuilds', () => {
  it('lists the servers the bot is in', async () => {
    const guilds = await fetchBotGuilds(
      't',
      respond(200, [
        { id: '1', name: 'Home', extra: true },
        { id: '2', name: 'Friends' },
      ]),
    );

    expect(guilds).toEqual([
      { id: '1', name: 'Home' },
      { id: '2', name: 'Friends' },
    ]);
  });
});
