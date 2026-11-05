/**
 * The addresses of an upload, for the watch page and the result. Direct links go through a public
 * base URL (public and protected links): nothing is signed and nothing expires. Signed links (private
 * links) are presigned requests for each object, and they stop working after a while.
 */
import type { S3Client } from '@aws-sdk/client-s3';
import type { RunContext } from '../../core/context.ts';
import { MergeStoryError } from '../../core/errors.ts';
import type { AssetUrls } from '../../core/providers.ts';
import { type ClassifiedBundle, WATCH_PAGE_NAME } from '../bundle.ts';
import type { S3Libs } from './client.ts';

/** Longest lifetime of a SigV4 signed link: seven days. */
const MAX_LINK_SEC = 604_800;
const MIN_LINK_SEC = 60;

/**
 * Link lifetime in seconds: the requested one, within SigV4 limits and the lifetime of the
 * credentials (a signed link stops working when the credentials that signed it expire).
 */
export function linkLifetime(
  requested: number,
  credentialsExpire: Date | undefined,
  ctx: Pick<RunContext, 'logger'>,
  now: number = Date.now(),
): number {
  const wanted = Number.isFinite(requested) ? Math.floor(requested) : MAX_LINK_SEC;
  let seconds = Math.min(MAX_LINK_SEC, Math.max(MIN_LINK_SEC, wanted));
  if (credentialsExpire) {
    const left = Math.floor((credentialsExpire.getTime() - now) / 1000);
    if (left < MIN_LINK_SEC) {
      throw new MergeStoryError(
        'PUBLISH_FAILED',
        'The storage credentials expire too soon to create a useful link.',
        {
          hint: 'Refresh the credentials (for example sign in again) and retry.',
        },
      );
    }
    if (left < seconds) {
      ctx.logger.warn('Links will stop working when the storage credentials expire', { seconds: left });
      seconds = left;
    }
  }
  return seconds;
}

export interface Links {
  /** The address of each file, and when the links stop working (null: never). */
  urls: AssetUrls;
  /** The address of the watch page itself, which is uploaded last. */
  watchUrl: string;
}

/** Permanent links on the public base URL. */
export function directLinks(publicBase: string, keyPrefix: string, files: ClassifiedBundle): Links {
  const address = (name: string) =>
    `${publicBase}/${`${keyPrefix}${name}`.split('/').map(encodeURIComponent).join('/')}`;
  return {
    urls: {
      video: address(files.video.file.name),
      poster: files.poster ? address(files.poster.file.name) : null,
      captions: files.captions ? address(files.captions.file.name) : null,
      linkExpiresAt: null,
    },
    watchUrl: address(WATCH_PAGE_NAME),
  };
}

interface SignedLinkOptions {
  libs: S3Libs;
  client: S3Client;
  bucket: string;
  keyPrefix: string;
  files: ClassifiedBundle;
  /** The lifetime that was asked for, in seconds (publish.linkExpirySec). */
  lifetimeSec: number;
  /** When the credentials that sign the links expire, if they do. */
  credentialsExpire: Date | undefined;
  ctx: Pick<RunContext, 'logger'>;
}

/** Presigned links that stop working after their lifetime. */
export async function signedLinks(options: SignedLinkOptions): Promise<Links> {
  const { libs, client, bucket, keyPrefix, files } = options;
  const expiresIn = linkLifetime(options.lifetimeSec, options.credentialsExpire, options.ctx);
  // One signing time for every link, so the expiry shown to people is exact.
  const signingDate = new Date();
  const sign = (name: string) =>
    libs.getSignedUrl(client, new libs.GetObjectCommand({ Bucket: bucket, Key: `${keyPrefix}${name}` }), {
      expiresIn,
      signingDate,
    });
  return {
    urls: {
      video: await sign(files.video.file.name),
      poster: files.poster ? await sign(files.poster.file.name) : null,
      captions: files.captions ? await sign(files.captions.file.name) : null,
      linkExpiresAt: new Date(signingDate.getTime() + expiresIn * 1000).toISOString(),
    },
    watchUrl: await sign(WATCH_PAGE_NAME),
  };
}
