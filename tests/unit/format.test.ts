import { describe, expect, it } from 'vitest';
import { escapeMarkdown, formatDuration, progressBar, truncate } from '../../src/utils/format.js';

describe('formatDuration', () => {
  it('formats durations below one hour as minutes and seconds', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(599.9)).toBe('9:59');
  });

  it('adds an hours field once the duration reaches one hour', () => {
    expect(formatDuration(3_723)).toBe('1:02:03');
  });

  it('labels a live stream without a known duration instead of showing zero', () => {
    expect(formatDuration(null)).toBe('прямой эфир');
  });
});

describe('truncate', () => {
  it('returns text unchanged when it fits the limit', () => {
    expect(truncate('abc', 3)).toBe('abc');
  });

  it('cuts long text to the limit and marks the cut with an ellipsis', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
  });

  it('counts an emoji as one character so the cut never splits a surrogate pair', () => {
    expect(truncate('🎵🎵🎵', 2)).toBe('🎵…');
  });
});

describe('escapeMarkdown', () => {
  it('escapes asterisks and underscores so track titles render literally', () => {
    expect(escapeMarkdown('*a*_b_')).toBe('\\*a\\*\\_b\\_');
  });
});

describe('progressBar', () => {
  it('fills the proportional number of cells', () => {
    expect(progressBar(0.5, 10)).toBe('▰▰▰▰▰▱▱▱▱▱');
  });

  it('clamps ratios outside the zero-to-one range', () => {
    expect(progressBar(-1, 4)).toBe('▱▱▱▱');
    expect(progressBar(7, 4)).toBe('▰▰▰▰');
  });
});
