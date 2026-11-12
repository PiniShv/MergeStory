/** YouTube as a Google service: its settings, and the failures only YouTube has. */
import type { RunContext } from '../../core/context.ts';
import type { MergeStoryError } from '../../core/errors.ts';
import { type Explanation, type GoogleApiError, toGoogleError } from '../google/google-api.ts';
import type { GoogleProvider } from '../google/provider.ts';

function explain(err: GoogleApiError): Explanation | null {
  if (err.has('quotaExceeded')) {
    return {
      code: 'PUBLISH_FAILED',
      message: 'The daily YouTube quota of the Google Cloud project is used up.',
      hint:
        'Quotas reset at midnight Pacific Time. By default a project can upload 100 videos a day, and all other calls share ' +
        '10,000 units (captions cost 400 units each). Try again tomorrow, turn off captions and playlists, ' +
        'or ask Google for more quota. Check the current Google docs for the latest limits.',
    };
  }
  if (err.has('uploadLimitExceeded')) {
    return {
      code: 'PUBLISH_FAILED',
      message: 'The YouTube channel has reached its daily upload limit.',
      hint: 'Wait 24 hours and try again. Verifying the channel (youtube.com/verify) raises the limit.',
    };
  }
  if (err.has('youtubeSignupRequired')) {
    return {
      code: 'CONFIG_INVALID',
      message: 'The Google account used to sign in has no YouTube channel.',
      hint: 'Create a YouTube channel for that account, then run `mergestory setup youtube` again. Service accounts do not work with YouTube.',
    };
  }
  if (err.has('accessNotConfigured') || err.has('SERVICE_DISABLED')) {
    return {
      code: 'CONFIG_INVALID',
      message: 'The YouTube Data API is not turned on for the Google Cloud project.',
      hint: 'Enable "YouTube Data API v3" for the project that owns the OAuth client (see docs/youtube.md in the MergeStory repository), wait a minute, and try again.',
    };
  }
  if (err.has('forbiddenPrivacySetting')) {
    return {
      code: 'PUBLISH_FAILED',
      message: 'YouTube does not allow this privacy setting for the video.',
      hint: 'Set publish.youtube.privacyStatus to "private" or "unlisted", or check the channel settings in YouTube Studio.',
    };
  }
  if (err.has('insufficientPermissions') || err.has('ACCESS_TOKEN_SCOPE_INSUFFICIENT')) {
    return {
      code: 'PUBLISH_FAILED',
      message: 'The saved sign-in does not have the permission this step needs.',
      hint: 'Turn on the feature (captions and playlists need a broader permission), then run `mergestory setup youtube` again.',
    };
  }
  if (err.status === 403) {
    return {
      code: 'PUBLISH_FAILED',
      message: 'YouTube refused the request (forbidden).',
      hint:
        'Check that the signed-in account owns the channel, that the sign-in has the needed permissions ' +
        '(run `mergestory setup youtube` again), and that the channel is verified for custom thumbnails.',
    };
  }
  const invalid = err.reasons.find(
    (reason) => /^invalid[A-Z]/.test(reason) || reason === 'defaultLanguageNotSet',
  );
  if (err.status === 400 && invalid) {
    return {
      code: 'PUBLISH_FAILED',
      message: `YouTube rejected the video details (${invalid}).`,
      hint: 'Check publish.youtube.categoryId and the language setting, then try again.',
    };
  }
  return null;
}

export const YOUTUBE: GoogleProvider = {
  id: 'youtube',
  label: 'YouTube',
  envPrefix: 'MERGESTORY_YOUTUBE',
  file: 'youtube.json',
  apiName: 'YouTube Data API v3',
  explain,
};

/** toGoogleError for YouTube. */
export function toYouTubeError(
  err: unknown,
  action: string,
  ctx: Pick<RunContext, 'redactor' | 'signal'>,
  forToken: 'refresh' | 'exchange' | null = null,
): MergeStoryError {
  return toGoogleError(err, action, ctx, YOUTUBE, forToken);
}
