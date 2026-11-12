import { stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ConfigInput, resolveConfig, type SecretName, Secrets } from '../../core/config.ts';
import { MergeStoryError } from '../../core/errors.ts';
import { homeLayout } from '../../core/paths.ts';
import { Redactor } from '../../core/redact.ts';
import {
  FAKE_CLIENT_ID,
  FAKE_CLIENT_SECRET,
  FAKE_REFRESH_TOKEN,
  type FakeGoogle,
  FORCE_SSL_SCOPE,
  makeTempDir,
  removeDir,
  startFakeGoogle,
  UPLOAD_SCOPE,
} from '../../testing/youtube.ts';
import { credentialsPath, readCredentialsFile } from './credentials.ts';
import { runYouTubeSignIn, type SignInIo } from './sign-in.ts';

const posix = process.platform !== 'win32';

let home: string;
let fake: FakeGoogle;

beforeEach(async () => {
  home = await makeTempDir('mergestory-signin-');
  fake = await startFakeGoogle();
});

afterEach(async () => {
  await fake.stop();
  await removeDir(home);
});

function get(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        agent: false,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

interface Harness {
  said: string[];
  asked: string[];
  urls: string[];
  statuses: number[];
  options: Parameters<typeof runYouTubeSignIn>[0];
}

interface HarnessOptions {
  config?: ConfigInput;
  secrets?: Partial<Record<SecretName, string>>;
  answers?: string[];
  interactive?: boolean;
  timeoutMs?: number;
  /** How the fake browser answers: the callbacks it makes, in order. */
  browser?: (info: { redirect: string; state: string; code: string }) => string[];
  /** false: nothing opens the sign-in page. */
  opens?: boolean;
}

function harness(options: HarnessOptions = {}): Harness {
  const said: string[] = [];
  const asked: string[] = [];
  const urls: string[] = [];
  const statuses: number[] = [];
  const answers = [...(options.answers ?? [FAKE_CLIENT_ID, FAKE_CLIENT_SECRET])];
  const io: SignInIo = {
    interactive: options.interactive ?? true,
    say: (text) => void said.push(text),
    askHidden: async (question) => {
      asked.push(question);
      return answers.shift() ?? '';
    },
    openBrowser: async (url) => {
      urls.push(url);
      if (options.opens === false) return false;
      const params = new URL(url).searchParams;
      const redirect = params.get('redirect_uri') ?? '';
      const state = params.get('state') ?? '';
      const code = `code-${urls.length}`;
      fake.expectAuthCode(code, params.get('code_challenge') ?? '', redirect);
      const queries = options.browser?.({ redirect, state, code }) ?? [`code=${code}&state=${state}`];
      for (const query of queries) statuses.push(await get(`${redirect}?${query}`));
      return true;
    },
  };
  const config = resolveConfig({ skipFile: true, env: {}, overrides: { home, ...options.config } });
  return {
    said,
    asked,
    urls,
    statuses,
    options: {
      ctx: {
        config,
        secrets: new Secrets(options.secrets ?? {}, new Redactor()),
        redactor: new Redactor(),
        home: homeLayout(home),
        signal: new AbortController().signal,
      },
      io,
      endpoints: {
        apiBase: fake.url,
        tokenUrl: `${fake.url}/token`,
        authUrl: 'https://accounts.google.test/o/oauth2/v2/auth',
      },
      timing: { maxRetries: 2, minDelayMs: 1, maxDelayMs: 5, requestTimeoutMs: 5_000 },
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    },
  };
}

const saved = () => readCredentialsFile(credentialsPath(home));
const tokenRequests = () => fake.requestsTo('POST', '/token');

describe('runYouTubeSignIn', () => {
  it('refuses to run without a person at a terminal, and says what to do', async () => {
    const h = harness({ interactive: false });
    const error = await runYouTubeSignIn(h.options).catch((err) => err);
    expect(error).toBeInstanceOf(MergeStoryError);
    expect(error.code).toBe('USAGE');
    expect(error.message).toContain('terminal');
    expect(error.hint).toContain('MERGESTORY_YOUTUBE_REFRESH_TOKEN');
    expect(error.hint).toContain('docs/youtube.md in the MergeStory repository');
    expect(h.asked).toEqual([]);
    expect(h.urls).toEqual([]);
    expect(fake.requests).toEqual([]);
    expect(await saved()).toBeNull();
  });

  it('signs in, stores the refresh token with mode 0600 and prints how to use it in CI', async () => {
    const h = harness();
    const result = await runYouTubeSignIn(h.options);

    expect(result.credentialsFile).toBe(credentialsPath(home));
    expect(result.scopes).toEqual([UPLOAD_SCOPE]);
    expect(await saved()).toMatchObject({
      clientId: FAKE_CLIENT_ID,
      clientSecret: FAKE_CLIENT_SECRET,
      refreshToken: FAKE_REFRESH_TOKEN,
      scope: UPLOAD_SCOPE,
    });
    if (posix) {
      expect((await stat(credentialsPath(home))).mode & 0o777).toBe(0o600);
      expect((await stat(result.credentialsFile.replace(/youtube\.json$/, ''))).mode & 0o777).toBe(0o700);
    }

    const output = h.said.join('\n');
    expect(output).toContain(`saved in ${credentialsPath(home)}`);
    expect(output).toContain('gh secret set MERGESTORY_YOUTUBE_REFRESH_TOKEN < <(jq -r .refresh_token ');
    expect(output).toContain('gh secret set MERGESTORY_YOUTUBE_CLIENT_ID');
    expect(output).toContain('gh secret set MERGESTORY_YOUTUBE_CLIENT_SECRET');
    expect(output).toContain('7 days');
    expect(output).toContain('Testing');
  });

  it('never prints the secret or the tokens', async () => {
    const h = harness();
    await runYouTubeSignIn(h.options);
    const everything = [...h.said, ...h.asked, ...h.urls].join('\n');
    for (const secret of [FAKE_CLIENT_SECRET, FAKE_REFRESH_TOKEN, fake.accessToken(1)]) {
      expect(everything).not.toContain(secret);
    }
  });

  it('asks for the client id and secret as hidden input, not as flags', async () => {
    const h = harness();
    await runYouTubeSignIn(h.options);
    expect(h.asked).toEqual(['OAuth client id: ', 'OAuth client secret (Enter to skip): ']);
  });

  it('says which scopes it asks for, and asks for youtube.upload only by default', async () => {
    const h = harness();
    await runYouTubeSignIn(h.options);
    const url = new URL(h.urls[0] ?? '');
    expect(url.searchParams.get('scope')).toBe(UPLOAD_SCOPE);
    const output = h.said.join('\n');
    expect(output).toContain('this permission');
    expect(output).toContain('youtube.upload: "Manage your YouTube videos"');
    expect(output).toContain('Captions and playlists need a broader permission');
  });

  it('asks for youtube.force-ssl when captions are on', async () => {
    fake = await replaceFake({ scope: FORCE_SSL_SCOPE });
    const h = harness({ config: { publish: { youtube: { uploadCaptions: true } } } });
    const result = await runYouTubeSignIn(h.options);
    expect(new URL(h.urls[0] ?? '').searchParams.get('scope')).toBe(FORCE_SSL_SCOPE);
    expect(result.scopes).toEqual([FORCE_SSL_SCOPE]);
    const output = h.said.join('\n');
    expect(output).toContain('youtube.force-ssl');
    expect(output).not.toContain('Captions and playlists need a broader permission');
  });

  it('asks for youtube.force-ssl when a playlist is set', async () => {
    fake = await replaceFake({ scope: FORCE_SSL_SCOPE });
    const h = harness({ config: { publish: { youtube: { playlistId: 'PLabcdefghijklmn' } } } });
    await runYouTubeSignIn(h.options);
    expect(new URL(h.urls[0] ?? '').searchParams.get('scope')).toBe(FORCE_SSL_SCOPE);
  });

  it('builds the sign-in address with PKCE, offline access and a state', async () => {
    const h = harness();
    await runYouTubeSignIn(h.options);
    const url = new URL(h.urls[0] ?? '');
    expect(url.origin).toBe('https://accounts.google.test');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('select_account consent');
    expect(url.searchParams.get('state')?.length).toBeGreaterThanOrEqual(32);
    expect(url.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth2callback$/);
    expect(url.searchParams.get('client_id')).toBe(FAKE_CLIENT_ID);
    expect(url.search).not.toContain('secret');
    expect(h.said).toContain(`  ${h.urls[0]}\n`);
  });

  it('sends the code and the verifier in the body of the token request, never in the address', async () => {
    const h = harness();
    await runYouTubeSignIn(h.options);
    const [request] = tokenRequests();
    expect(tokenRequests()).toHaveLength(1);
    expect(request?.query.size).toBe(0);
    const form = new URLSearchParams(request?.body.toString('utf8'));
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('code-1');
    expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(form.get('client_secret')).toBe(FAKE_CLIENT_SECRET);
  });

  it('does not ask when the client id and secret are in the environment', async () => {
    const h = harness({
      secrets: {
        MERGESTORY_YOUTUBE_CLIENT_ID: FAKE_CLIENT_ID,
        MERGESTORY_YOUTUBE_CLIENT_SECRET: FAKE_CLIENT_SECRET,
      },
    });
    await runYouTubeSignIn(h.options);
    expect(h.asked).toEqual([]);
    expect(h.said.join('\n')).toContain('from the environment');
    expect((await saved())?.clientId).toBe(FAKE_CLIENT_ID);
  });

  it('asks only for what the environment lacks', async () => {
    const h = harness({
      secrets: { MERGESTORY_YOUTUBE_CLIENT_ID: FAKE_CLIENT_ID },
      answers: [FAKE_CLIENT_SECRET],
    });
    await runYouTubeSignIn(h.options);
    expect(h.asked).toEqual(['OAuth client secret (Enter to skip): ']);
  });

  it('registers the client values with the redactor', async () => {
    const h = harness();
    await runYouTubeSignIn(h.options);
    expect(h.options.ctx.redactor.redact(`x ${FAKE_CLIENT_SECRET} y`)).toBe('x [redacted] y');
  });

  it('rejects an answer with the wrong state, keeps waiting, and then succeeds', async () => {
    const h = harness({
      browser: ({ code, state }) => [`code=forged&state=forged-state`, `code=${code}&state=${state}`],
    });
    await runYouTubeSignIn(h.options);
    expect(h.statuses).toEqual([400, 200]);
    expect(tokenRequests()).toHaveLength(1);
    expect(new URLSearchParams(tokenRequests()[0]?.body.toString('utf8')).get('code')).toBe('code-1');
    expect((await saved())?.refreshToken).toBe(FAKE_REFRESH_TOKEN);
  });

  it('stores nothing when only forged answers arrive and the sign-in times out', async () => {
    const h = harness({ timeoutMs: 150, browser: () => ['code=forged&state=forged-state'] });
    const error = await runYouTubeSignIn(h.options).catch((err) => err);
    expect(error).toMatchObject({ code: 'CONFIG_INVALID' });
    expect(error.message).toContain('timed out');
    expect(h.statuses).toEqual([400]);
    expect(tokenRequests()).toHaveLength(0);
    expect(await saved()).toBeNull();
  });

  it('times out when nobody finishes the sign-in, prints the address, and stores nothing', async () => {
    const h = harness({ timeoutMs: 100, opens: false });
    const error = await runYouTubeSignIn(h.options).catch((err) => err);
    expect(error).toMatchObject({ code: 'CONFIG_INVALID' });
    expect(error.message).toContain('timed out');
    const output = h.said.join('\n');
    expect(output).toContain('Could not open a browser');
    expect(output).toContain('Open this address');
    expect(await saved()).toBeNull();
  });

  it('fails cleanly when the person denies access', async () => {
    const h = harness({ browser: ({ state }) => [`error=access_denied&state=${state}`] });
    const error = await runYouTubeSignIn(h.options).catch((err) => err);
    expect(error).toMatchObject({ code: 'CONFIG_INVALID' });
    expect(error.message).toContain('cancelled');
    expect(tokenRequests()).toHaveLength(0);
    expect(await saved()).toBeNull();
  });

  it('refuses an answer without a refresh token and stores nothing', async () => {
    fake.intercept((r) => r.path === '/token', {
      kind: 'json',
      status: 200,
      body: { access_token: 'ya29.no-refresh-token-here', expires_in: 3599, scope: UPLOAD_SCOPE },
    });
    const h = harness();
    const error = await runYouTubeSignIn(h.options).catch((err) => err);
    expect(error).toMatchObject({ code: 'CONFIG_INVALID' });
    expect(error.message).toContain('refresh token');
    expect(await saved()).toBeNull();
  });

  it('refuses a sign-in where a needed permission was not granted and stores nothing', async () => {
    fake.intercept((r) => r.path === '/token', {
      kind: 'json',
      status: 200,
      body: {
        access_token: 'ya29.partial',
        refresh_token: 'refresh-partial-0123456789',
        expires_in: 3599,
        scope: 'openid',
      },
    });
    const h = harness();
    const error = await runYouTubeSignIn(h.options).catch((err) => err);
    expect(error).toMatchObject({ code: 'CONFIG_INVALID' });
    expect(error.message).toContain('youtube.upload');
    expect(error.hint).toContain('every permission box');
    expect(await saved()).toBeNull();
  });

  it('reports a code that Google rejects', async () => {
    const h = harness({ browser: ({ state }) => [`code=unknown-code&state=${state}`] });
    const error = await runYouTubeSignIn(h.options).catch((err) => err);
    expect(error).toMatchObject({ code: 'CONFIG_INVALID' });
    expect(error.message).toContain('sign-in code');
    expect(await saved()).toBeNull();
  });

  it('reports a client that Google does not know', async () => {
    const h = harness({ answers: ['unknown-client.apps.googleusercontent.com', FAKE_CLIENT_SECRET] });
    const error = await runYouTubeSignIn(h.options).catch((err) => err);
    expect(error).toMatchObject({ code: 'CONFIG_INVALID' });
    expect(error.message).toContain('client id or secret');
  });

  it('works without a client secret', async () => {
    fake = await replaceFake({ clientSecret: null });
    const h = harness({ answers: [FAKE_CLIENT_ID, ''] });
    await runYouTubeSignIn(h.options);
    expect((await saved())?.clientSecret).toBeNull();
    const output = h.said.join('\n');
    expect(output).not.toContain('MERGESTORY_YOUTUBE_CLIENT_SECRET');
    expect(new URLSearchParams(tokenRequests()[0]?.body.toString('utf8')).has('client_secret')).toBe(false);
  });

  it('rejects a missing or malformed client id before anything else happens', async () => {
    for (const answer of ['', '   ', 'two words', 'x'.repeat(400)]) {
      const h = harness({ answers: [answer, ''] });
      const error = await runYouTubeSignIn(h.options).catch((err) => err);
      expect(error).toMatchObject({ code: 'USAGE' });
      expect(h.urls).toEqual([]);
    }
  });

  it('rejects a malformed client secret', async () => {
    const h = harness({ answers: [FAKE_CLIENT_ID, 'has spaces in it'] });
    await expect(runYouTubeSignIn(h.options)).rejects.toMatchObject({ code: 'USAGE' });
    expect(h.urls).toEqual([]);
  });

  it('replaces an earlier sign-in', async () => {
    await runYouTubeSignIn(harness().options);
    const second = harness({ answers: [FAKE_CLIENT_ID, FAKE_CLIENT_SECRET] });
    await runYouTubeSignIn(second.options);
    expect((await saved())?.refreshToken).toBe(FAKE_REFRESH_TOKEN);
  });

  it('shell-quotes a credentials path with spaces in the CI commands', async () => {
    const spaced = await makeTempDir('mergestory sign in ');
    try {
      const h = harness();
      h.options.ctx.home = homeLayout(spaced);
      await runYouTubeSignIn(h.options);
      expect(h.said.join('\n')).toContain(`jq -r .refresh_token '${credentialsPath(spaced)}'`);
    } finally {
      await removeDir(spaced);
    }
  });

  it('stops when the run is cancelled', async () => {
    const h = harness({ opens: false });
    const controller = new AbortController();
    h.options.ctx.signal = controller.signal;
    const result = runYouTubeSignIn(h.options).catch((err) => err);
    setTimeout(() => controller.abort(), 50);
    expect(await result).toMatchObject({ code: 'ABORTED' });
    expect(await saved()).toBeNull();
  });
});

/** Start a fresh fake with other settings, and stop the one from beforeEach. */
async function replaceFake(options: Parameters<typeof startFakeGoogle>[0]): Promise<FakeGoogle> {
  await fake.stop();
  return startFakeGoogle(options);
}
