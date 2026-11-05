/**
 * OAuth scopes of the YouTube Data API, and which API method accepts which scope.
 * Checked against Google's discovery document in 2026-11; see the current Google docs for changes.
 */
import type { Config } from '../../core/config.ts';

const PREFIX = 'https://www.googleapis.com/auth/';

export const SCOPES = {
  /** Upload videos and set thumbnails. */
  upload: `${PREFIX}youtube.upload`,
  /** Manage the YouTube account (does not cover captions). */
  manage: `${PREFIX}youtube`,
  /** Everything MergeStory does: upload, thumbnails, captions and playlists. */
  forceSsl: `${PREFIX}youtube.force-ssl`,
  partner: `${PREFIX}youtubepartner`,
} as const;

export type YouTubeOperation =
  | 'videos.insert'
  | 'thumbnails.set'
  | 'captions.insert'
  | 'playlistItems.insert';

/** The scopes each method accepts. Any one of them is enough. */
const ACCEPTED: Record<YouTubeOperation, readonly string[]> = {
  'videos.insert': [SCOPES.upload, SCOPES.manage, SCOPES.forceSsl, SCOPES.partner],
  'thumbnails.set': [SCOPES.upload, SCOPES.manage, SCOPES.forceSsl, SCOPES.partner],
  'captions.insert': [SCOPES.forceSsl, SCOPES.partner],
  'playlistItems.insert': [SCOPES.manage, SCOPES.forceSsl, SCOPES.partner],
};

type YouTubeSettings = Pick<Config['publish']['youtube'], 'uploadCaptions' | 'playlistId'>;

/**
 * The narrowest scope that covers the enabled features. Uploads and thumbnails need only
 * youtube.upload; captions and playlists need youtube.force-ssl, which covers everything.
 */
export function requiredScopes(settings: YouTubeSettings): string[] {
  return settings.uploadCaptions || settings.playlistId !== null ? [SCOPES.forceSsl] : [SCOPES.upload];
}

/** The scope without its URL prefix, for messages: "youtube.upload". */
export function shortScope(scope: string): string {
  return scope.startsWith(PREFIX) ? scope.slice(PREFIX.length) : scope;
}

/** What Google's permission screen calls the scope, and what MergeStory uses it for. */
export function describeScope(scope: string): string {
  if (scope === SCOPES.upload) {
    return 'youtube.upload: "Manage your YouTube videos". MergeStory uses it to upload the video and set its thumbnail.';
  }
  if (scope === SCOPES.forceSsl) {
    return (
      'youtube.force-ssl: "See, edit, and permanently delete your YouTube videos, ratings, comments and captions". ' +
      'It is the one scope that covers upload, thumbnail, captions and playlists. MergeStory only uploads and never deletes.'
    );
  }
  return shortScope(scope);
}

/** Split a space-separated scope string. null when it is empty or missing (unknown). */
export function parseScopes(value: string | null | undefined): string[] | null {
  const scopes = (value ?? '').split(/\s+/).filter(Boolean);
  return scopes.length > 0 ? scopes : null;
}

/** true when the granted scopes allow the method. Unknown scopes (null) are given the benefit of the doubt. */
export function scopeAllows(granted: readonly string[] | null, operation: YouTubeOperation): boolean {
  if (granted === null) return true;
  return ACCEPTED[operation].some((scope) => granted.includes(scope));
}

/** true when every required scope was granted. */
export function hasScopes(granted: readonly string[], required: readonly string[]): boolean {
  return required.every((scope) => granted.includes(scope));
}
