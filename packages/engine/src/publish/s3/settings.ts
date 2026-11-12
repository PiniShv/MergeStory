/**
 * What the storage settings allow. These rules read settings and secrets and make no network call, so
 * an upload can be refused before it touches storage. `findS3Problems` returns every problem by cause
 * (`mergestory doctor` shows each on its own line); a publisher stops at the first one.
 */
import type { Config, Secrets } from '../../core/config.ts';
import { MergeStoryError } from '../../core/errors.ts';
import { type ExposureTexts, exposureProblem } from '../privacy.ts';
import { safeHttpUrl } from '../text.ts';

export type S3Settings = Config['publish']['s3'];
/** Who may open the links of an upload. */
export type Visibility = Config['publish']['visibility'];

/** One of the two storage key variables without the other: both are needed, or neither. */
export function keysProblem(secrets: Pick<Secrets, 'get'>): MergeStoryError | null {
  const hasKeyId = secrets.get('MERGESTORY_S3_ACCESS_KEY_ID') !== null;
  if (hasKeyId === (secrets.get('MERGESTORY_S3_SECRET_ACCESS_KEY') !== null)) return null;
  return new MergeStoryError('CONFIG_INVALID', 'Only one of the two storage credential variables is set.', {
    hint: 'Set both MERGESTORY_S3_ACCESS_KEY_ID and MERGESTORY_S3_SECRET_ACCESS_KEY, or neither to use the AWS credential chain.',
  });
}

/** Public and protected links go through a public base URL. The problem when the setting holds no usable one. */
function publicBaseProblem(value: string | null, visibility: Visibility): MergeStoryError | null {
  if (visibility !== 'public' && visibility !== 'protected') return null;
  if (value && safeHttpUrl(value)) return null;
  if (visibility === 'protected') {
    return new MergeStoryError('CONFIG_INVALID', 'Protected links need a public base URL.', {
      hint:
        'Set MERGESTORY_S3_PUBLIC_BASE_URL (publish.s3.publicBaseUrl) to the custom domain of the bucket, the one that ' +
        'sits behind your access proxy, for example https://videos.example.com. See https://github.com/PiniShv/MergeStory/blob/main/docs/hosting.md. ' +
        'Or use private links, which are signed and expire.',
    });
  }
  return new MergeStoryError('CONFIG_INVALID', 'Public links need a public base URL.', {
    hint:
      'Set MERGESTORY_S3_PUBLIC_BASE_URL to the address that serves the bucket (a CDN, a custom domain or a public bucket URL), ' +
      'or use private links.',
  });
}

/** The address that links are built on: the usable public base URL without query, fragment and trailing slashes. */
export function publicBaseOf(value: string | null): string | null {
  const url = value ? safeHttpUrl(value) : null;
  return url ? url.replace(/[?#].*$/, '').replace(/\/+$/, '') : null;
}

export function bucketProblem(s3: S3Settings): MergeStoryError | null {
  if (s3.bucket?.trim()) return null;
  return new MergeStoryError('CONFIG_INVALID', 'No storage bucket is configured.', {
    hint: 'Set MERGESTORY_S3_BUCKET, or publish.s3.bucket in the config file.',
  });
}

/** The refusal of public links for a repository that is private, or that cannot be told apart from one. */
const PUBLIC_LINKS_BLOCKED: ExposureTexts = {
  isPrivate: 'This repository is private, so public video links are blocked.',
  unknown: 'MergeStory cannot tell whether this repository is private, so public video links are blocked.',
  hint:
    'Use private links (signed links that expire), or set publish.allowPublicForPrivateRepos to true ' +
    'if anyone with the link may watch the video.',
};

/** What an upload refuses about the settings, by cause. An upload stops at the first one, in this order. */
export interface S3Problems {
  /** Public links for a private repository (or one that cannot be told apart from it). */
  privacy: MergeStoryError | null;
  bucket: MergeStoryError | null;
  /** Public and protected links need an address to be built on. */
  publicBase: MergeStoryError | null;
  /** Half of the storage key pair. */
  keys: MergeStoryError | null;
}

/** Every problem with the storage settings for links of this visibility. */
export function findS3Problems(
  config: Config,
  secrets: Pick<Secrets, 'get'>,
  visibility: Visibility,
  repoIsPrivate: boolean | null,
): S3Problems {
  const { s3 } = config.publish;
  return {
    privacy: exposureProblem(config, visibility === 'public', repoIsPrivate, PUBLIC_LINKS_BLOCKED),
    bucket: bucketProblem(s3),
    publicBase: publicBaseProblem(s3.publicBaseUrl, visibility),
    keys: keysProblem(secrets),
  };
}

/** The problem that an upload stops at. */
export function firstProblem(problems: S3Problems): MergeStoryError | null {
  return problems.privacy ?? problems.bucket ?? problems.publicBase ?? problems.keys;
}
