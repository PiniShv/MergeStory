/**
 * Publishing: uploads the video bundle and returns shareable links.
 * Also builds the self-contained watch page and the PR comment / description text.
 */
import type { Config } from '../core/config.ts';
import { MergeStoryError } from '../core/errors.ts';
import type { Publisher } from '../core/providers.ts';
import { LocalPublisher, writeWatchFolder } from './local.ts';
import { S3Publisher } from './s3/index.ts';
import { createYouTubePublisher } from './youtube/index.ts';

export { classifyBundle } from './bundle.ts';
export { buildDescriptionSection, buildPrComment } from './comment.ts';
export { cacheControlFor, contentTypeFor } from './content-types.ts';
export { sanitizeKeyPrefix } from './keys.ts';
export type { CommentData, EvidenceLink, WatchPageData } from './types.ts';
export { BUNDLE_CONTAINS, COMMENT_MARKER, DESCRIPTION_END, DESCRIPTION_START } from './types.ts';
export { buildWatchPage } from './watch-page.ts';
export { LocalPublisher, S3Publisher, writeWatchFolder };

/** Returns null for provider "none". */
export function createPublisher(config: Config): Publisher | null {
  const provider: string = config.publish.provider;
  switch (provider) {
    case 'none':
      return null;
    case 'local':
      return new LocalPublisher(config);
    case 's3':
      return new S3Publisher(config);
    case 'youtube':
      return createYouTubePublisher(config);
    default:
      throw new MergeStoryError('CONFIG_INVALID', `Unknown publish provider "${provider}".`, {
        hint: 'Use "local", "s3", "youtube" or "none".',
      });
  }
}
