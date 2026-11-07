const LIVE_LABEL = 'прямой эфир';

/** Formats seconds as m:ss, or h:mm:ss from one hour. Null means a live stream with no duration. */
export function formatDuration(totalSeconds: number | null): string {
  if (totalSeconds === null) {
    return LIVE_LABEL;
  }
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secondsPart = String(seconds % 60).padStart(2, '0');

  if (hours > 0) {
    return `${String(hours)}:${String(minutes).padStart(2, '0')}:${secondsPart}`;
  }
  return `${String(minutes)}:${secondsPart}`;
}

/** Truncates by code points so an emoji is never split, and marks the cut with an ellipsis. */
export function truncate(text: string, maxLength: number): string {
  if (maxLength <= 0) {
    return '';
  }
  const characters = Array.from(text);
  if (characters.length <= maxLength) {
    return text;
  }
  return `${characters.slice(0, maxLength - 1).join('')}…`;
}

/** Escapes Discord markdown so user-provided titles render as plain text. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_~`|>[\]]/g, (character) => `\\${character}`);
}

/** Draws a horizontal bar. The ratio is clamped to 0..1. */
export function progressBar(ratio: number, width = 12): string {
  const clamped = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  const filled = Math.round(clamped * width);
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

/** A title that is safe to put inside a chat message: shortened, with Discord markdown escaped. */
export function chatTitle(title: string, maxLength = 80): string {
  return escapeMarkdown(truncate(title, maxLength));
}
