import { execFile } from 'node:child_process';
import { AppError } from '../../utils/errors.js';

export interface ProbeResult {
  readonly durationSec: number | null;
  readonly title: string | null;
  readonly artist: string | null;
  readonly hasAudio: boolean;
}

interface FfprobeJson {
  readonly format?: {
    readonly duration?: string;
    readonly tags?: Readonly<Record<string, string>>;
  };
  readonly streams?: readonly { readonly codec_type?: string }[];
}

const MAX_OUTPUT_BYTES = 1_048_576;

/** Reads duration and tags with ffprobe. The file path is passed as an argument, never through a shell. */
export function probeAudioFile(
  ffprobePath: string,
  filePath: string,
  timeoutMs = 20_000,
): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve, reject) => {
    execFile(
      ffprobePath,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(
            new AppError('SOURCE_UNAVAILABLE', 'Не удалось прочитать аудиофайл.', { cause: error }),
          );
          return;
        }
        try {
          resolve(parseProbeOutput(stdout));
        } catch (cause) {
          reject(new AppError('SOURCE_UNAVAILABLE', 'Не удалось прочитать аудиофайл.', { cause }));
        }
      },
    );
  });
}

export function parseProbeOutput(json: string): ProbeResult {
  const data = JSON.parse(json) as FfprobeJson;
  const duration = Number(data.format?.duration);
  const tags = lowerCaseKeys(data.format?.tags ?? {});

  return {
    durationSec: Number.isFinite(duration) && duration > 0 ? duration : null,
    title: nonEmpty(tags.title),
    artist: nonEmpty(tags.artist),
    hasAudio: (data.streams ?? []).some((stream) => stream.codec_type === 'audio'),
  };
}

function lowerCaseKeys(tags: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(tags).map(([key, value]) => [key.toLowerCase(), value]));
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed !== '' ? trimmed : null;
}
