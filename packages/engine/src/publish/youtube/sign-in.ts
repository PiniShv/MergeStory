/**
 * `mergestory setup youtube`: sign in to Google once, on a machine with a browser, and save the
 * refresh token. The sign-in uses the loopback flow for desktop apps: a listener on 127.0.0.1, PKCE
 * (S256), a random `state`, and the narrowest scopes that the enabled features need.
 *
 * The client secret and the tokens are never printed, never passed as command-line flags and never
 * put in a URL. The refresh token is written to a file that only the current user can read.
 */
import type { RunContext } from '../../core/context.ts';
import { MergeStoryError } from '../../core/errors.ts';
import { shellQuote } from '../../core/text.ts';
import { credentialsPath, writeCredentialsFile } from './credentials.ts';
import { DEFAULT_TIMING, GOOGLE_ENDPOINTS, type Timing, type YouTubeEndpoints } from './google-api.ts';
import { receiveAuthorizationCode } from './loopback.ts';
import { buildAuthUrl, createPkce, exchangeCode, randomState } from './oauth.ts';
import { describeScope, parseScopes, requiredScopes, shortScope } from './scopes.ts';

export interface SignInIo {
  /** Output for the person (dropped in --json mode). */
  say(text: string): void;
  /** Ask for a value without showing what is typed. */
  askHidden(question: string): Promise<string>;
  /** Try to open an address in the browser. false when that did not work. */
  openBrowser(url: string): Promise<boolean>;
  /** true when a person is typing at a terminal. */
  interactive: boolean;
}

export interface SignInOptions {
  ctx: Pick<RunContext, 'config' | 'secrets' | 'redactor' | 'home' | 'signal'>;
  io: SignInIo;
  /** Only tests change these. */
  endpoints?: Partial<YouTubeEndpoints>;
  timing?: Partial<Timing>;
  /** How long to wait for the browser. Default: 5 minutes. */
  timeoutMs?: number;
}

export interface SignInResult {
  /** Where the sign-in was saved. */
  credentialsFile: string;
  /** The scopes Google granted (those that were asked for when Google does not say). */
  scopes: string[];
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

function checkClientId(value: string): string {
  const clientId = value.trim();
  if (!clientId || /\s/.test(clientId) || clientId.length > 300) {
    throw new MergeStoryError('USAGE', 'The OAuth client id is missing or not valid.', {
      hint: 'Copy the client id of your "Desktop app" OAuth client from the Google Cloud console (see docs/youtube.md in the MergeStory repository).',
    });
  }
  return clientId;
}

function checkClientSecret(value: string): string | null {
  const secret = value.trim();
  if (/\s/.test(secret) || secret.length > 300) {
    throw new MergeStoryError('USAGE', 'The OAuth client secret is not valid.', {
      hint: 'Copy the client secret again from the Google Cloud console. Press Enter to skip it.',
    });
  }
  return secret || null;
}

/** Commands that put a saved value into a CI secret, without printing it. */
function ciGuidance(file: string, hasSecret: boolean): string[] {
  const path = shellQuote(file);
  const set = (name: string, field: string): string => `  gh secret set ${name} < <(jq -r .${field} ${path})`;
  return [
    'To use this sign-in in CI, store its values as CI secrets without printing them.',
    'With the GitHub CLI and jq (bash or zsh; add --repo OWNER/REPO or --org as needed):',
    set('MERGESTORY_YOUTUBE_REFRESH_TOKEN', 'refresh_token'),
    set('MERGESTORY_YOUTUBE_CLIENT_ID', 'client_id'),
    ...(hasSecret ? [set('MERGESTORY_YOUTUBE_CLIENT_SECRET', 'client_secret')] : []),
  ];
}

/** Run the sign-in. Throws a MergeStoryError (with a hint) when it cannot finish. */
export async function runYouTubeSignIn(options: SignInOptions): Promise<SignInResult> {
  const { ctx, io } = options;
  const endpoints: YouTubeEndpoints = { ...GOOGLE_ENDPOINTS, ...options.endpoints };
  const timing: Timing = { ...DEFAULT_TIMING, ...options.timing };
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!io.interactive) {
    throw new MergeStoryError('USAGE', 'Signing in to YouTube needs a person at a terminal.', {
      hint:
        'Run `mergestory setup youtube` in an interactive terminal on a machine with a browser. For CI, sign in there once, ' +
        'then store the refresh token as the secret MERGESTORY_YOUTUBE_REFRESH_TOKEN (see docs/youtube.md in the MergeStory repository).',
    });
  }

  const scopes = requiredScopes(ctx.config.publish.youtube);
  io.say('Sign in to YouTube');
  io.say('MergeStory uploads videos to the YouTube channel of the Google account you choose.\n');
  io.say(`It asks Google for ${scopes.length === 1 ? 'this permission' : 'these permissions'}:`);
  for (const scope of scopes) io.say(`  - ${describeScope(scope)}`);
  const { uploadCaptions, playlistId } = ctx.config.publish.youtube;
  if (!uploadCaptions && playlistId === null) {
    io.say(
      'Captions and playlists need a broader permission. To use them, set publish.youtube.uploadCaptions or ' +
        'publish.youtube.playlistId first, then run this again.',
    );
  }
  io.say('');

  let clientId = ctx.secrets.get('MERGESTORY_YOUTUBE_CLIENT_ID');
  let clientSecret = ctx.secrets.get('MERGESTORY_YOUTUBE_CLIENT_SECRET');
  if (clientId && clientSecret) {
    io.say('Using the OAuth client id and secret from the environment.');
  } else {
    io.say(
      'You need an OAuth client of the type "Desktop app" from your own Google Cloud project (see docs/youtube.md in the MergeStory repository).',
    );
    io.say('What you type here is hidden, and it is not saved in your shell history.');
    if (!clientId) clientId = await io.askHidden('OAuth client id: ');
    if (!clientSecret)
      clientSecret = checkClientSecret(await io.askHidden('OAuth client secret (Enter to skip): '));
  }
  const id = checkClientId(clientId ?? '');
  const secret = clientSecret ?? null;
  ctx.redactor.add(id);
  ctx.redactor.add(secret);

  const pkce = createPkce();
  const state = randomState();
  let redirectUri = '';
  const code = await receiveAuthorizationCode({
    state,
    timeoutMs,
    signal: ctx.signal,
    onReady: async (info) => {
      redirectUri = info.redirectUri;
      const url = buildAuthUrl({
        authUrl: endpoints.authUrl,
        clientId: id,
        redirectUri,
        scopes,
        state,
        challenge: pkce.challenge,
      });
      io.say('Open this address in your browser to sign in:');
      io.say(`  ${url}\n`);
      const opened = await io.openBrowser(url);
      io.say(
        opened
          ? 'Your browser should open now. If it does not, copy the address above into a browser.'
          : 'Could not open a browser from here. Copy the address above into a browser.',
      );
      io.say(`Waiting for you to finish (up to ${Math.round(timeoutMs / 60_000)} minutes)...`);
    },
  });

  const grant = await exchangeCode(
    { clientId: id, clientSecret: secret, code, verifier: pkce.verifier, redirectUri },
    { endpoints, signal: ctx.signal, timing },
    ctx,
  );
  if (!grant.refreshToken) {
    throw new MergeStoryError('CONFIG_INVALID', 'Google did not return a refresh token.', {
      hint: "Remove MergeStory's access in your Google Account settings (third-party access), then run `mergestory setup youtube` again.",
    });
  }
  const granted = parseScopes(grant.scope);
  const missing = granted ? scopes.filter((scope) => !granted.includes(scope)) : [];
  if (missing.length > 0) {
    throw new MergeStoryError(
      'CONFIG_INVALID',
      `Google did not grant: ${missing.map(shortScope).join(', ')}.`,
      {
        hint: 'Run `mergestory setup youtube` again and leave every permission box ticked on the Google page.',
      },
    );
  }

  const file = credentialsPath(ctx.home.home);
  await writeCredentialsFile(file, {
    clientId: id,
    clientSecret: secret,
    refreshToken: grant.refreshToken,
    scope: grant.scope,
    createdAt: new Date().toISOString(),
  });

  io.say('');
  io.say(`Signed in. The sign-in is saved in ${file} (only you can read it).`);
  io.say('');
  for (const line of ciGuidance(file, secret !== null)) io.say(line);
  io.say('');
  io.say(
    'Heads up: while the OAuth consent screen is External and its status is "Testing", Google ends this sign-in after 7 days. ' +
      'Publish the app, or use an Internal app in a Google Workspace, so it keeps working (see docs/youtube.md in the MergeStory repository).',
  );
  return { credentialsFile: file, scopes: granted ?? scopes };
}
