import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REDACTED, Redactor } from '../../core/redact.ts';
import { FAST_TIMING } from '../../testing/youtube.ts';
import { GOOGLE_ENDPOINTS, type YouTubeEndpoints } from './google-api.ts';
import {
  AccessTokens,
  buildAuthUrl,
  createPkce,
  exchangeCode,
  pkceChallenge,
  randomState,
  refreshGrant,
} from './oauth.ts';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const credentials = {
  clientId: 'client-id-123.apps.googleusercontent.com',
  clientSecret: 'client-secret-abcdefgh' as string | null,
  refreshToken: 'refresh-token-abcdefghijkl',
  scope: null,
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

function setup() {
  const redactor = new Redactor();
  const ctx = { redactor, signal: new AbortController().signal };
  const env = { endpoints: GOOGLE_ENDPOINTS as YouTubeEndpoints, signal: ctx.signal, timing: FAST_TIMING };
  return { redactor, ctx, env };
}

const sentForm = (call = 0): URLSearchParams =>
  new URLSearchParams(String(fetchMock.mock.calls[call]?.[1]?.body));

describe('PKCE', () => {
  it('computes the S256 challenge of the RFC 7636 example', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('makes a fresh 43-character verifier from the allowed characters', () => {
    const a = createPkce();
    const b = createPkce();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).toBe(pkceChallenge(a.verifier));
    expect(a.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('makes a different random state every time', () => {
    expect(randomState()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomState()).not.toBe(randomState());
  });
});

describe('buildAuthUrl', () => {
  const url = new URL(
    buildAuthUrl({
      authUrl: GOOGLE_ENDPOINTS.authUrl,
      clientId: 'client-id-123.apps.googleusercontent.com',
      redirectUri: 'http://127.0.0.1:54321/oauth2callback',
      scopes: [
        'https://www.googleapis.com/auth/youtube.upload',
        'https://www.googleapis.com/auth/youtube.force-ssl',
      ],
      state: 'state-value',
      challenge: 'challenge-value',
    }),
  );

  it('points at Google over HTTPS', () => {
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.pathname).toBe('/o/oauth2/v2/auth');
  });

  it('asks for a code with PKCE S256, offline access and a fresh consent', () => {
    const p = url.searchParams;
    expect(p.get('response_type')).toBe('code');
    expect(p.get('code_challenge')).toBe('challenge-value');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('consent');
    expect(p.get('state')).toBe('state-value');
    expect(p.get('client_id')).toBe('client-id-123.apps.googleusercontent.com');
    expect(p.get('redirect_uri')).toBe('http://127.0.0.1:54321/oauth2callback');
  });

  it('lists the scopes separated by spaces', () => {
    expect(url.searchParams.get('scope')).toBe(
      'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.force-ssl',
    );
    expect(url.search).toContain('scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fyoutube.upload%20https');
  });

  it('carries no secret', () => {
    expect(url.search).not.toContain('secret');
    expect(url.search).not.toContain('verifier');
  });
});

describe('refreshGrant', () => {
  const answer = {
    access_token: 'ya29.access-token-value',
    expires_in: 3599,
    scope: 'a b',
    token_type: 'Bearer',
  };

  it('posts the refresh token to the token endpoint in the body, never in the address', async () => {
    fetchMock.mockResolvedValue(json(200, answer));
    const { env, ctx } = setup();
    const grant = await refreshGrant(credentials, env, ctx);
    expect(grant).toEqual({
      accessToken: 'ya29.access-token-value',
      refreshToken: null,
      scope: 'a b',
      expiresInSec: 3599,
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(String(url)).not.toContain('?');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(init.redirect).toBe('manual');
    const form = sentForm();
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe(credentials.refreshToken);
    expect(form.get('client_id')).toBe(credentials.clientId);
    expect(form.get('client_secret')).toBe(credentials.clientSecret);
  });

  it('leaves out the client secret when there is none', async () => {
    fetchMock.mockResolvedValue(json(200, answer));
    const { env, ctx } = setup();
    await refreshGrant({ ...credentials, clientSecret: null }, env, ctx);
    expect(sentForm().has('client_secret')).toBe(false);
  });

  it('registers the access token with the redactor', async () => {
    fetchMock.mockResolvedValue(json(200, answer));
    const { env, ctx, redactor } = setup();
    await refreshGrant(credentials, env, ctx);
    expect(redactor.redact('Bearer ya29.access-token-value')).toBe(`Bearer ${REDACTED}`);
  });

  it('maps invalid_grant to CONFIG_INVALID and tells the person to sign in again', async () => {
    fetchMock.mockResolvedValue(
      json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }),
    );
    const { env, ctx } = setup();
    const error = await refreshGrant(credentials, env, ctx).catch((err) => err);
    expect(error).toMatchObject({ code: 'CONFIG_INVALID' });
    expect(error.hint).toContain('mergestory setup youtube');
    expect(error.hint).toContain('7 days');
    expect(error.hint).toContain('Testing');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps invalid_client to CONFIG_INVALID', async () => {
    fetchMock.mockResolvedValue(
      json(401, { error: 'invalid_client', error_description: 'The OAuth client was not found.' }),
    );
    const { env, ctx } = setup();
    const error = await refreshGrant(credentials, env, ctx).catch((err) => err);
    expect(error).toMatchObject({ code: 'CONFIG_INVALID' });
    expect(error.message).toContain('client id or secret');
  });

  it('retries a temporary failure and then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(json(503, { error: { code: 503, message: 'busy' } }))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(json(200, answer));
    const { env, ctx } = setup();
    expect((await refreshGrant(credentials, env, ctx)).accessToken).toBe('ya29.access-token-value');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('gives up after the maximum number of retries with a PUBLISH_FAILED error', async () => {
    fetchMock.mockImplementation(async () => json(503, { error: { code: 503, message: 'busy' } }));
    const { env, ctx } = setup();
    const error = await refreshGrant(credentials, env, ctx).catch((err) => err);
    expect(error).toMatchObject({ code: 'PUBLISH_FAILED', retryable: true });
    expect(fetchMock).toHaveBeenCalledTimes(FAST_TIMING.maxRetries + 1);
  });

  it('rejects an answer it cannot read', async () => {
    const { env, ctx } = setup();
    for (const body of ['not json', '{}', '{"access_token":""}', '[]']) {
      fetchMock.mockResolvedValueOnce(json(200, body));
      await expect(refreshGrant(credentials, env, ctx)).rejects.toMatchObject({ code: 'PUBLISH_FAILED' });
    }
  });

  it('clamps an odd expiry to a sane range', async () => {
    const { env, ctx } = setup();
    fetchMock.mockResolvedValueOnce(json(200, { ...answer, expires_in: 5 }));
    expect((await refreshGrant(credentials, env, ctx)).expiresInSec).toBe(60);
    fetchMock.mockResolvedValueOnce(json(200, { ...answer, expires_in: 10_000_000 }));
    expect((await refreshGrant(credentials, env, ctx)).expiresInSec).toBe(86_400);
    fetchMock.mockResolvedValueOnce(json(200, { access_token: 'x-token-value-0001' }));
    expect((await refreshGrant(credentials, env, ctx)).expiresInSec).toBe(3600);
  });

  it('stops for a cancelled run', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      controller.abort();
      throw init.signal?.reason ?? new Error('aborted');
    });
    const redactor = new Redactor();
    const env = { endpoints: GOOGLE_ENDPOINTS, signal: controller.signal, timing: FAST_TIMING };
    await expect(
      refreshGrant(credentials, env, { redactor, signal: controller.signal }),
    ).rejects.toMatchObject({
      code: 'ABORTED',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('exchangeCode', () => {
  it('posts the code and the verifier, and returns the tokens', async () => {
    fetchMock.mockResolvedValue(
      json(200, {
        access_token: 'ya29.new-access',
        refresh_token: '1//new-refresh-token',
        expires_in: 3599,
        scope: 's',
      }),
    );
    const { env, ctx, redactor } = setup();
    const grant = await exchangeCode(
      {
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        code: 'the-code',
        verifier: 'the-verifier',
        redirectUri: 'http://127.0.0.1:5000/oauth2callback',
      },
      env,
      ctx,
    );
    expect(grant.refreshToken).toBe('1//new-refresh-token');
    const form = sentForm();
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('the-code');
    expect(form.get('code_verifier')).toBe('the-verifier');
    expect(form.get('redirect_uri')).toBe('http://127.0.0.1:5000/oauth2callback');
    expect(redactor.redact('1//new-refresh-token ya29.new-access')).toBe(`${REDACTED} ${REDACTED}`);
  });

  it('maps a rejected code to CONFIG_INVALID with advice about the code', async () => {
    fetchMock.mockResolvedValue(json(400, { error: 'invalid_grant', error_description: 'Bad Request' }));
    const { env, ctx } = setup();
    const error = await exchangeCode(
      {
        clientId: 'c',
        clientSecret: null,
        code: 'x',
        verifier: 'v',
        redirectUri: 'http://127.0.0.1:1/oauth2callback',
      },
      env,
      ctx,
    ).catch((err) => err);
    expect(error).toMatchObject({ code: 'CONFIG_INVALID' });
    expect(error.message).toContain('sign-in code');
  });
});

describe('AccessTokens', () => {
  const grantBody = (
    n: number,
    expiresIn = 3599,
    scope = 'https://www.googleapis.com/auth/youtube.upload',
  ) => ({
    access_token: `ya29.token-number-${n}`,
    expires_in: expiresIn,
    scope,
  });

  it('keeps the token in memory and fetches it once', async () => {
    fetchMock.mockResolvedValue(json(200, grantBody(1)));
    const { env, ctx } = setup();
    const tokens = new AccessTokens(credentials, env, ctx);
    expect(await tokens.get()).toBe('ya29.token-number-1');
    expect(await tokens.get()).toBe('ya29.token-number-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shares one request between callers that ask at the same time', async () => {
    fetchMock.mockResolvedValue(json(200, grantBody(1)));
    const { env, ctx } = setup();
    const tokens = new AccessTokens(credentials, env, ctx);
    const [a, b] = await Promise.all([tokens.get(), tokens.get()]);
    expect(a).toBe(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fetches a new token after invalidate', async () => {
    fetchMock.mockResolvedValueOnce(json(200, grantBody(1))).mockResolvedValueOnce(json(200, grantBody(2)));
    const { env, ctx } = setup();
    const tokens = new AccessTokens(credentials, env, ctx);
    expect(await tokens.get()).toBe('ya29.token-number-1');
    tokens.invalidate();
    expect(await tokens.get()).toBe('ya29.token-number-2');
  });

  it('renews a token that is about to expire', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    fetchMock.mockResolvedValueOnce(json(200, grantBody(1))).mockResolvedValueOnce(json(200, grantBody(2)));
    const { env, ctx } = setup();
    const tokens = new AccessTokens(credentials, env, ctx);
    expect(await tokens.get()).toBe('ya29.token-number-1');
    vi.setSystemTime(Date.now() + (3599 - 60) * 1000);
    expect(await tokens.get()).toBe('ya29.token-number-2');
  });

  it('reports the scopes that Google granted', async () => {
    fetchMock.mockResolvedValue(json(200, grantBody(1, 3599, 'scope-a scope-b')));
    const { env, ctx } = setup();
    const tokens = new AccessTokens(credentials, env, ctx);
    expect(tokens.scopes).toBeNull();
    await tokens.get();
    expect(tokens.scopes).toEqual(['scope-a', 'scope-b']);
  });

  it('keeps scopes unknown when Google does not say', async () => {
    fetchMock.mockResolvedValue(json(200, { access_token: 'ya29.token-number-9', expires_in: 3599 }));
    const { env, ctx } = setup();
    const tokens = new AccessTokens(credentials, env, ctx);
    await tokens.get();
    expect(tokens.scopes).toBeNull();
  });

  it('can try again after a failed refresh', async () => {
    fetchMock
      .mockResolvedValueOnce(json(400, { error: 'invalid_grant' }))
      .mockResolvedValueOnce(json(200, grantBody(1)));
    const { env, ctx } = setup();
    const tokens = new AccessTokens(credentials, env, ctx);
    await expect(tokens.get()).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect(await tokens.get()).toBe('ya29.token-number-1');
  });
});
