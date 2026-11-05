import { describe, expect, it } from 'vitest';
import { buildCustomId, parseCustomId } from '../../src/security/customIds.js';

describe('buildCustomId', () => {
  it('joins the feature, action and arguments under the Melody prefix', () => {
    expect(buildCustomId('panel', 'toggle')).toBe('melody:panel:toggle');
    expect(buildCustomId('queue', 'page', '3')).toBe('melody:queue:page:3');
  });

  it('refuses segments that would break parsing', () => {
    expect(() => buildCustomId('panel', 'to:ggle')).toThrow();
    expect(() => buildCustomId('panel', 'toggle', 'a b')).toThrow();
  });

  it('refuses identifiers longer than the Discord limit of 100 characters', () => {
    expect(() => buildCustomId('panel', 'toggle', 'x'.repeat(100))).toThrow();
  });
});

describe('parseCustomId', () => {
  it('returns the feature, action and arguments of a Melody identifier', () => {
    expect(parseCustomId('melody:queue:page:3')).toEqual({
      feature: 'queue',
      action: 'page',
      args: ['3'],
    });
  });

  it('returns null for identifiers that belong to other components or are malformed', () => {
    expect(parseCustomId('other:queue:page:3')).toBeNull();
    expect(parseCustomId('melody:')).toBeNull();
  });
});
