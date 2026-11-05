import { describe, expect, it } from 'vitest';
import {
  createGuardedLookup,
  nextRedirectTarget,
} from '../../src/audio/providers/streamFetcher.js';
import type { StreamUrlPolicy } from '../../src/security/urlPolicy.js';
import { selectPublicAddress } from '../../src/security/urlPolicy.js';
import { AppError } from '../../src/utils/errors.js';

const POLICY: StreamUrlPolicy = {
  allowedHosts: ['radio.example.org'],
  allowHttp: false,
  allowedPorts: [443],
};

function errorCodeOf(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return error instanceof AppError ? error.code : 'OTHER';
  }
  return undefined;
}

describe('nextRedirectTarget', () => {
  it('resolves a relative redirect against the current URL', () => {
    const target = nextRedirectTarget(
      new URL('https://radio.example.org/a/live.mp3'),
      '../b/live.mp3',
      POLICY,
    );

    expect(target.href).toBe('https://radio.example.org/b/live.mp3');
  });

  it('refuses a redirect to a metadata address', () => {
    expect(
      errorCodeOf(() =>
        nextRedirectTarget(
          new URL('https://radio.example.org/a'),
          'https://169.254.169.254/latest/meta-data/',
          POLICY,
        ),
      ),
    ).toBe('SOURCE_RESTRICTED');
  });

  it('refuses a redirect that downgrades to plain http', () => {
    expect(
      errorCodeOf(() =>
        nextRedirectTarget(
          new URL('https://radio.example.org/a'),
          'http://radio.example.org/a',
          POLICY,
        ),
      ),
    ).toBe('SOURCE_RESTRICTED');
  });

  it('refuses a redirect to a host outside the allowlist', () => {
    expect(
      errorCodeOf(() =>
        nextRedirectTarget(
          new URL('https://radio.example.org/a'),
          'https://cdn.example.net/a',
          POLICY,
        ),
      ),
    ).toBe('SOURCE_RESTRICTED');
  });

  it('refuses a redirect response that has no location header', () => {
    expect(
      errorCodeOf(() => nextRedirectTarget(new URL('https://radio.example.org/a'), null, POLICY)),
    ).toBe('SOURCE_RESTRICTED');
  });
});

describe('createGuardedLookup', () => {
  function lookupOnce(
    lookup: ReturnType<typeof createGuardedLookup>,
    all: boolean,
  ): Promise<{ error: Error | null; address: unknown; family: unknown }> {
    return new Promise((resolve) => {
      lookup('radio.example.org', { all }, (error, address, family) => {
        resolve({ error, address, family });
      });
    });
  }

  it('hands the connection the single public address', async () => {
    const lookup = createGuardedLookup({
      resolve: () => Promise.resolve([{ address: '8.8.8.8', family: 4 }]),
      guard: selectPublicAddress,
    });

    const result = await lookupOnce(lookup, false);

    expect(result).toEqual({ error: null, address: '8.8.8.8', family: 4 });
  });

  it('refuses the connection when the DNS answer mixes public and private addresses', async () => {
    const lookup = createGuardedLookup({
      resolve: () =>
        Promise.resolve([
          { address: '8.8.8.8', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ]),
      guard: selectPublicAddress,
    });

    const result = await lookupOnce(lookup, false);

    expect(result.error).toBeInstanceOf(Error);
    expect(result.address).toBe('');
  });

  it('returns the address list in the shape Node expects when all addresses are requested', async () => {
    const lookup = createGuardedLookup({
      resolve: () => Promise.resolve([{ address: '8.8.8.8', family: 4 }]),
      guard: selectPublicAddress,
    });

    const result = await lookupOnce(lookup, true);

    expect(result).toEqual({
      error: null,
      address: [{ address: '8.8.8.8', family: 4 }],
      family: undefined,
    });
  });

  it('reports a DNS failure instead of connecting anywhere', async () => {
    const lookup = createGuardedLookup({
      resolve: () => Promise.reject(new Error('ENOTFOUND')),
      guard: selectPublicAddress,
    });

    const result = await lookupOnce(lookup, false);

    expect(result.error?.message).toBe('ENOTFOUND');
  });
});
