/**
 * Checks of YouTube publishing: the privacy setting, and the sign-in. The sign-in verdict is the one of
 * the YouTube publisher (check), so the report and the upload apply the same rules. The report adds
 * where each value comes from, and says which are missing, in its own words.
 */
import { join } from 'node:path';
import { isMergeStoryError } from '../core/errors.ts';
import { homeLayout } from '../core/paths.ts';
import { check } from './check.ts';
import type { DoctorCheck, DoctorContext, YouTubeLoginFile } from './types.ts';

const YOUTUBE_VALUES = [
  { key: 'clientId', label: 'client id', env: 'MERGESTORY_YOUTUBE_CLIENT_ID' },
  { key: 'clientSecret', label: 'client secret', env: 'MERGESTORY_YOUTUBE_CLIENT_SECRET' },
  { key: 'refreshToken', label: 'refresh token', env: 'MERGESTORY_YOUTUBE_REFRESH_TOKEN' },
] as const;

const YOUTUBE_SETUP =
  'Run: mergestory setup youtube (on a machine with a browser; see https://github.com/PiniShv/MergeStory/blob/main/docs/youtube.md). For CI, set MERGESTORY_YOUTUBE_CLIENT_ID, MERGESTORY_YOUTUBE_CLIENT_SECRET and MERGESTORY_YOUTUBE_REFRESH_TOKEN.';

export async function checkYouTube({ config, secrets, ctx, deps }: DoctorContext): Promise<DoctorCheck[]> {
  const { privacyStatus } = config.publish.youtube;
  const privacy: Record<typeof privacyStatus, string> = {
    private: 'only you can watch it',
    unlisted: 'only people with the link can watch it',
    public: 'anyone can find and watch it',
  };
  // A private repository only gets a video that others cannot open, unless the config allows more.
  const guard =
    privacyStatus === 'private'
      ? ''
      : '. For a private repository, use privacy private, or set publish.allowPublicForPrivateRepos';
  const shown = `youtube: privacy ${privacyStatus} (${privacy[privacyStatus]})${guard}`;
  const checks: DoctorCheck[] = [
    privacyStatus === 'public'
      ? check(
          'publish',
          'Publishing',
          'warn',
          shown,
          'Use unlisted or private (publish.youtube.privacyStatus) unless the video is meant for everyone.',
        )
      : check('publish', 'Publishing', 'pass', shown),
  ];

  // Like the upload: values from the environment win, and the file is only read when it is needed.
  const fromEnv = YOUTUBE_VALUES.map((value) => secrets.has(value.env));
  const envComplete =
    secrets.has('MERGESTORY_YOUTUBE_CLIENT_ID') && secrets.has('MERGESTORY_YOUTUBE_REFRESH_TOKEN');
  let file: YouTubeLoginFile | null = null;
  if (!envComplete) {
    const path = join(homeLayout(config.home).home, 'credentials', 'youtube.json');
    try {
      file = await deps.readYouTubeLogin(path);
    } catch (err) {
      const problem = isMergeStoryError(err) ? err : null;
      checks.push(
        check(
          'publish-credentials',
          'YouTube login',
          'fail',
          problem?.message ?? 'the saved YouTube sign-in could not be read',
          problem?.hint ?? YOUTUBE_SETUP,
        ),
      );
      return checks;
    }
  }
  const state = YOUTUBE_VALUES.map((value, i) => ({
    ...value,
    from: fromEnv[i] ? 'environment' : file?.[value.key] ? 'credentials file' : null,
  }));
  const text = state.map((value) => `${value.label}: ${value.from ?? 'missing'}`).join(', ');
  const missing = (key: (typeof YOUTUBE_VALUES)[number]['key']): boolean =>
    state.find((value) => value.key === key)?.from === null;
  if (missing('clientId') || missing('refreshToken')) {
    checks.push(check('publish-credentials', 'YouTube login', 'fail', text, YOUTUBE_SETUP));
    return checks;
  }
  // The upload has the last word, in its own words: it also refuses values that are all there but do
  // not fit together (a client id that is not the saved sign-in's). The repository is not known here,
  // so it is taken as public: the privacy rule is left to the run.
  const refused = (await (await deps.publisher(config))?.check(ctx, false)) ?? null;
  if (refused) {
    checks.push(
      check('publish-credentials', 'YouTube login', 'fail', refused.message, refused.hint ?? YOUTUBE_SETUP),
    );
  } else if (missing('clientSecret')) {
    checks.push(
      check(
        'publish-credentials',
        'YouTube login',
        'warn',
        text,
        'Google usually needs the client secret as well. Run mergestory setup youtube again, or set MERGESTORY_YOUTUBE_CLIENT_SECRET.',
      ),
    );
  } else {
    checks.push(check('publish-credentials', 'YouTube login', 'pass', text));
  }
  return checks;
}
