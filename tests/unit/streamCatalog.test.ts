import { describe, expect, it } from 'vitest';
import { parseStreamCatalog } from '../../src/audio/providers/streamCatalog.js';

const VALID = {
  id: 'chill-radio',
  title: 'Chill Radio',
  url: 'https://radio.example.org/live.mp3',
  live: true,
};

describe('parseStreamCatalog', () => {
  it('accepts an https entry and derives its host allowlist from the URL', () => {
    const { entries, problems } = parseStreamCatalog({ streams: [VALID] });

    expect(problems).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.policy.allowedHosts).toEqual(['radio.example.org']);
    expect(entries[0]?.live).toBe(true);
  });

  it('rejects an entry that points at a metadata address, without echoing the address', () => {
    const { entries, problems } = parseStreamCatalog({
      streams: [{ ...VALID, id: 'metadata-entry', url: 'https://169.254.169.254/latest' }],
    });

    expect(entries).toHaveLength(0);
    expect(problems.join(' ')).toContain('metadata-entry');
    expect(problems.join(' ')).not.toContain('169.254.169.254');
  });

  it('rejects plain http unless the entry explicitly allows it', () => {
    const { entries } = parseStreamCatalog({
      streams: [{ ...VALID, url: 'http://radio.example.org/live.mp3' }],
    });

    expect(entries).toHaveLength(0);
  });

  it('rejects a host allowlist that does not contain the URL host', () => {
    const { entries } = parseStreamCatalog({
      streams: [{ ...VALID, allowedHosts: ['other.example.org'] }],
    });

    expect(entries).toHaveLength(0);
  });

  it('rejects identifiers that collide with library identifiers', () => {
    const { entries } = parseStreamCatalog({
      streams: [{ ...VALID, id: 'lib-0123456789ab' }],
    });

    expect(entries).toHaveLength(0);
  });

  it('keeps the first of two entries that share an identifier and reports the second', () => {
    const { entries, problems } = parseStreamCatalog({
      streams: [VALID, { ...VALID, title: 'Duplicate' }],
    });

    expect(entries.map((entry) => entry.title)).toEqual(['Chill Radio']);
    expect(problems).toHaveLength(1);
  });

  it('keeps valid entries when others are invalid', () => {
    const { entries, problems } = parseStreamCatalog({
      streams: [
        { ...VALID, id: 'broken', url: 'file:///etc/passwd' },
        { ...VALID, id: 'good-one' },
      ],
    });

    expect(entries.map((entry) => entry.id)).toEqual(['good-one']);
    expect(problems).toHaveLength(1);
  });

  it('reports a malformed document without throwing', () => {
    const { entries, problems } = parseStreamCatalog('not a catalog');

    expect(entries).toEqual([]);
    expect(problems.length).toBeGreaterThan(0);
  });
});
