/** Content types and cache headers for published files. */

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  // Browsers only accept "text/vtt" for caption tracks, and expect UTF-8.
  '.vtt': 'text/vtt; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

/** Content type for a file name. Always set at upload: storage services do not guess it. */
export function contentTypeFor(name: string): string {
  return CONTENT_TYPES[extensionOf(name)] ?? 'application/octet-stream';
}

/**
 * Cache header for a file name. Each run uploads under its own random key prefix, so the file
 * behind a URL does not change and media can be cached for a year.
 *
 * - public: anyone may see the files, so shared caches (a CDN) may keep all of them.
 * - private: the files are shared through signed links. They are kept out of shared caches, and
 *   the watch page, which embeds the signed links, is revalidated every time.
 * - protected: the files sit behind an access proxy. They are marked private so that no shared
 *   cache can hand a copy to someone who has not signed in, and the watch page is revalidated
 *   every time so that the access proxy sees each visit.
 */
export function cacheControlFor(
  name: string,
  visibility: 'public' | 'private' | 'protected' = 'private',
): string {
  const scope = visibility === 'public' ? 'public' : 'private';
  if (extensionOf(name) === '.html' && visibility !== 'public') return 'private, no-cache';
  return `${scope}, max-age=31536000, immutable`;
}
