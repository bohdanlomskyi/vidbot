import { describe, expect, it } from 'vitest';
import { buildFfmpegArgs } from '../../src/audio/pipeline/ffmpeg.js';

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe('buildFfmpegArgs', () => {
  it('decodes to signed 16-bit 48 kHz stereo PCM written to stdout', () => {
    const args = buildFfmpegArgs({ kind: 'file', path: '/music/a.mp3' });

    expect(args.at(-1)).toBe('pipe:1');
    expect(valueAfter(args, '-f')).toBe('s16le');
    expect(valueAfter(args, '-acodec')).toBe('pcm_s16le');
    expect(valueAfter(args, '-ar')).toBe('48000');
    expect(valueAfter(args, '-ac')).toBe('2');
  });

  it('passes the file path as a single argument so spaces and shell symbols are never split', () => {
    const path = '/music/Album Name/Track; rm -rf $HOME.mp3';

    expect(valueAfter(buildFfmpegArgs({ kind: 'file', path }), '-i')).toBe(path);
  });

  it('restricts file inputs to the local file protocol so playlists cannot open network URLs', () => {
    const args = buildFfmpegArgs({ kind: 'file', path: '/music/list.m3u8' });

    expect(valueAfter(args, '-protocol_whitelist')).toBe('file');
  });

  it('places the seek offset before the input so decoding starts at that position', () => {
    const args = buildFfmpegArgs({ kind: 'file', path: '/music/a.mp3', startSec: 42.5 });

    expect(Number(valueAfter(args, '-ss'))).toBe(42.5);
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
  });

  it('reads from stdin for piped input and adds no seek offset', () => {
    const args = buildFfmpegArgs({ kind: 'pipe' });

    expect(valueAfter(args, '-i')).toBe('pipe:0');
    expect(args).not.toContain('-ss');
  });
});
