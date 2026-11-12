/** `mergestory setup youtube`: the shared Google sign-in, with the scopes the YouTube settings need. */
import { runGoogleSignIn, type SignInOptions, type SignInResult } from '../google/sign-in.ts';
import { YOUTUBE } from './provider.ts';
import { describeScope, requiredScopes } from './scopes.ts';

export type { SignInIo, SignInOptions, SignInResult } from '../google/sign-in.ts';

export function runYouTubeSignIn(options: SignInOptions): Promise<SignInResult> {
  const { uploadCaptions, playlistId } = options.ctx.config.publish.youtube;
  return runGoogleSignIn(options, {
    provider: YOUTUBE,
    scopes: requiredScopes(options.ctx.config.publish.youtube),
    describeScope,
    purpose: 'MergeStory uploads videos to the YouTube channel of the Google account you choose.',
    notes:
      !uploadCaptions && playlistId === null
        ? [
            'Captions and playlists need a broader permission. To use them, set publish.youtube.uploadCaptions or ' +
              'publish.youtube.playlistId first, then run this again.',
          ]
        : [],
  });
}
