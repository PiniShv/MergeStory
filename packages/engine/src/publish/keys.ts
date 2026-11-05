/** Object key prefixes for published videos. */
import { randomToken } from '../core/ids.ts';

const MAX_PREFIX_LENGTH = 100;

/**
 * Reduce a user-chosen prefix to lowercase letters, digits, "_" and "-", separated by "/".
 * No leading or trailing slash, no empty or dot segments, so a prefix can never climb out of itself.
 */
export function sanitizeKeyPrefix(prefix: string): string {
  const segments = prefix
    .toLowerCase()
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) =>
      segment
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-+|-+$/g, ''),
    )
    .filter(Boolean);
  const joined = segments.join('/').slice(0, MAX_PREFIX_LENGTH);
  return joined.replace(/[/-]+$/, '');
}

/**
 * Object key prefix "<prefix>/v/<128-bit random token>/". Contains no repository, branch or
 * user names: the random token is what keeps a public link unguessable.
 */
export function buildKeyPrefix(prefix: string): string {
  const clean = sanitizeKeyPrefix(prefix);
  const token = randomToken(16);
  return clean ? `${clean}/v/${token}/` : `v/${token}/`;
}
