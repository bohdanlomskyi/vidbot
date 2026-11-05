const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID = /^[A-Za-z0-9_-]{10,64}$/;
const WATCH_HOSTS: ReadonlySet<string> = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
]);
const MAX_INPUT_LENGTH = 2048;

export interface YouTubeLink {
  readonly kind: 'video' | 'playlist';
  readonly id: string;
  /** Rebuilt from the identifier. The user's own URL never reaches yt-dlp. */
  readonly canonicalUrl: string;
}

/**
 * Recognises YouTube and YouTube Music links for single videos and playlists. Returns
 * null for anything else, including bare identifiers, other hosts, credentials and
 * option-like text. A watch link that also carries a playlist parameter is a video.
 */
export function parseYouTubeInput(input: string): YouTubeLink | null {
  const trimmed = input.trim();
  if (trimmed === '' || trimmed.length > MAX_INPUT_LENGTH) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== ''
  ) {
    return null;
  }

  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/\/$/, '');

  if (host === 'youtu.be') {
    return videoLink(path.slice(1));
  }
  if (!WATCH_HOSTS.has(host)) {
    return null;
  }
  if (path === '/watch') {
    return videoLink(url.searchParams.get('v') ?? '');
  }
  if (path.startsWith('/shorts/')) {
    return videoLink(path.slice('/shorts/'.length));
  }
  if (path === '/playlist') {
    return playlistLink(url.searchParams.get('list') ?? '');
  }
  return null;
}

function videoLink(id: string): YouTubeLink | null {
  return VIDEO_ID.test(id)
    ? { kind: 'video', id, canonicalUrl: `https://www.youtube.com/watch?v=${id}` }
    : null;
}

function playlistLink(id: string): YouTubeLink | null {
  return PLAYLIST_ID.test(id)
    ? { kind: 'playlist', id, canonicalUrl: `https://www.youtube.com/playlist?list=${id}` }
    : null;
}
