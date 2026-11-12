import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MergeStoryError } from '../../core/errors.ts';
import { Redactor } from '../../core/redact.ts';
import { FAST_TIMING, type FakeGoogle, googleError, startFakeGoogle } from '../../testing/youtube.ts';
import { toYouTubeError } from '../youtube/provider.ts';
import { callApi, GoogleApiError, parseApiFailure, type TokenProvider, withRetries } from './google-api.ts';

const apiFailure = (status: number, reason: string, message = 'Something went wrong.', extra: object = {}) =>
  parseApiFailure(
    status,
    JSON.stringify({ error: { code: status, message, errors: [{ reason }], ...extra } }),
  );
const oauthFailure = (status: number, error: string) =>
  parseApiFailure(status, JSON.stringify({ error, error_description: 'details' }));

function ctx(signal: AbortSignal = new AbortController().signal) {
  return { redactor: new Redactor(), signal };
}

describe('parseApiFailure', () => {
  it('reads the reason and message of an API error', () => {
    const err = apiFailure(403, 'quotaExceeded', 'You have exceeded your <a href="/x">quota</a>.');
    expect(err.status).toBe(403);
    expect(err.reasons).toEqual(['quotaExceeded']);
    expect(err.apiMessage).toBe('You have exceeded your quota .');
    expect(err.has('quotaExceeded')).toBe(true);
  });

  it('reads the reason of an OAuth error', () => {
    const err = oauthFailure(400, 'invalid_grant');
    expect(err.reasons).toEqual(['invalid_grant']);
    expect(err.apiMessage).toBe('details');
  });

  it('collects reasons from errors, details and status, most specific first', () => {
    const err = parseApiFailure(
      403,
      JSON.stringify({
        error: {
          message: 'x',
          status: 'PERMISSION_DENIED',
          errors: [{ reason: 'accessNotConfigured' }],
          details: [{ '@type': 'ErrorInfo', reason: 'SERVICE_DISABLED' }],
        },
      }),
    );
    expect(err.reasons).toEqual(['accessNotConfigured', 'SERVICE_DISABLED', 'PERMISSION_DENIED']);
  });

  it('copes with a body that is not JSON', () => {
    const err = parseApiFailure(502, '<html>Bad gateway</html>');
    expect(err.reasons).toEqual([]);
    expect(err.apiMessage).toBe('');
    expect(err.transient).toBe(true);
  });

  it('reads Retry-After', () => {
    const err = parseApiFailure(503, '', new Headers({ 'retry-after': '7' }));
    expect(err.retryAfterMs).toBe(7000);
  });

  it('marks only passing failures as transient', () => {
    for (const status of [408, 429, 500, 502, 503, 504]) expect(apiFailure(status, 'x').transient).toBe(true);
    for (const status of [400, 401, 403, 404, 409, 501])
      expect(apiFailure(status, 'x').transient).toBe(false);
    expect(apiFailure(403, 'rateLimitExceeded').transient).toBe(true);
    expect(apiFailure(403, 'userRateLimitExceeded').transient).toBe(true);
    expect(apiFailure(403, 'quotaExceeded').transient).toBe(false);
    expect(apiFailure(429, 'uploadRateLimitExceeded').transient).toBe(false);
    expect(new GoogleApiError(0, [], 'ECONNRESET', null).transient).toBe(true);
  });
});

describe('toYouTubeError', () => {
  const map = (err: unknown, action = 'Uploading the video') => toYouTubeError(err, action, ctx());

  it('maps a used-up quota to PUBLISH_FAILED with a quota hint', () => {
    const error = map(apiFailure(403, 'quotaExceeded'));
    expect(error.code).toBe('PUBLISH_FAILED');
    expect(error.message).toContain('quota');
    expect(error.hint).toContain('midnight Pacific Time');
    expect(error.hint).toContain('100 videos');
    expect(error.hint).toContain('check the current Google docs'.replace('check', 'Check'));
  });

  it('maps the daily upload limit to PUBLISH_FAILED', () => {
    const error = map(apiFailure(400, 'uploadLimitExceeded'));
    expect(error.code).toBe('PUBLISH_FAILED');
    expect(error.message).toContain('daily upload limit');
    expect(error.hint).toContain('24 hours');
  });

  it('maps a rejected sign-in (401) to CONFIG_INVALID and mentions the 7-day Testing expiry', () => {
    for (const err of [apiFailure(401, 'authError'), apiFailure(401, 'authorizationRequired')]) {
      const error = map(err);
      expect(error.code).toBe('CONFIG_INVALID');
      expect(error.hint).toContain('mergestory setup youtube');
      expect(error.hint).toContain('7 days');
      expect(error.hint).toContain('Testing');
    }
  });

  it('maps invalid_grant to CONFIG_INVALID with the same advice', () => {
    const error = map(oauthFailure(400, 'invalid_grant'));
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toContain('no longer accepts');
    expect(error.hint).toContain('mergestory setup youtube');
    expect(error.hint).toContain('7 days');
  });

  it('explains an invalid sign-in code during setup differently', () => {
    const error = toYouTubeError(oauthFailure(400, 'invalid_grant'), 'Signing in', ctx(), 'exchange');
    expect(error.message).toContain('sign-in code');
    expect(error.hint).toContain('Each code works once');
  });

  it('maps a wrong client to CONFIG_INVALID', () => {
    for (const reason of ['invalid_client', 'unauthorized_client']) {
      const error = map(oauthFailure(401, reason));
      expect(error.code).toBe('CONFIG_INVALID');
      expect(error.hint).toContain('Desktop app');
    }
  });

  it('maps forbidden (403) to PUBLISH_FAILED with a scope and channel hint', () => {
    const error = map(apiFailure(403, 'forbidden'));
    expect(error.code).toBe('PUBLISH_FAILED');
    expect(error.hint).toContain('owns the channel');
    expect(error.hint).toContain('mergestory setup youtube');
    expect(error.hint).toContain('verified');
  });

  it('maps a missing permission to a hint about turning on the feature', () => {
    const error = map(apiFailure(403, 'insufficientPermissions'));
    expect(error.code).toBe('PUBLISH_FAILED');
    expect(error.hint).toContain('mergestory setup youtube');
  });

  it('maps a channel that does not exist to CONFIG_INVALID', () => {
    const error = map(apiFailure(401, 'youtubeSignupRequired'));
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toContain('no YouTube channel');
  });

  it('maps a disabled API to CONFIG_INVALID', () => {
    const error = map(apiFailure(403, 'accessNotConfigured'));
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.hint).toContain('YouTube Data API v3');
  });

  it('maps rejected video details to PUBLISH_FAILED', () => {
    const error = map(apiFailure(400, 'invalidCategoryId'));
    expect(error.code).toBe('PUBLISH_FAILED');
    expect(error.message).toContain('invalidCategoryId');
    expect(error.hint).toContain('categoryId');
  });

  it('marks temporary failures as retryable', () => {
    const error = map(apiFailure(503, 'backendError'));
    expect(error.code).toBe('PUBLISH_FAILED');
    expect(error.retryable).toBe(true);
    expect(map(apiFailure(404, 'videoNotFound')).retryable).toBe(false);
  });

  it('reports a network failure with advice', () => {
    const error = map(new GoogleApiError(0, [], 'ECONNREFUSED', null));
    expect(error.message).toContain('could not be reached');
    expect(error.message).toContain('ECONNREFUSED');
  });

  it('puts the action in the message of a publish failure and keeps details safe to print', () => {
    const error = map(apiFailure(403, 'quotaExceeded', 'quota'), 'Uploading the video');
    expect(error.message).toContain('Uploading the video failed');
    expect(error.details).toMatchObject({ status: 403, reason: 'quotaExceeded' });
  });

  it('keeps existing MergeStory errors and reports a cancelled run as ABORTED', () => {
    const own = new MergeStoryError('PRIVACY_BLOCKED', 'x');
    expect(map(own)).toBe(own);
    const controller = new AbortController();
    controller.abort();
    expect(toYouTubeError(new Error('whatever'), 'x', ctx(controller.signal)).code).toBe('ABORTED');
    const abort = new Error('stop');
    abort.name = 'AbortError';
    expect(map(abort).code).toBe('ABORTED');
  });

  it('removes known secrets from messages', () => {
    const redactor = new Redactor();
    redactor.add('super-secret-value-1234');
    const error = toYouTubeError(new Error('failed with super-secret-value-1234'), 'Doing it', {
      redactor,
      signal: new AbortController().signal,
    });
    expect(error.message).not.toContain('super-secret-value-1234');
    expect(error.message).toContain('[redacted]');
  });
});

describe('withRetries', () => {
  const env = { signal: new AbortController().signal, timing: FAST_TIMING };

  it('retries transient failures and then succeeds', async () => {
    let calls = 0;
    const result = await withRetries(async () => {
      calls += 1;
      if (calls < 3) throw apiFailure(503, 'backendError');
      return 'ok';
    }, env);
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('gives up after the maximum number of retries', async () => {
    let calls = 0;
    await expect(
      withRetries(async () => {
        calls += 1;
        throw apiFailure(503, 'backendError');
      }, env),
    ).rejects.toBeInstanceOf(GoogleApiError);
    expect(calls).toBe(FAST_TIMING.maxRetries + 1);
  });

  it('does not retry other failures', async () => {
    let calls = 0;
    await expect(
      withRetries(async () => {
        calls += 1;
        throw apiFailure(400, 'invalidTitle');
      }, env),
    ).rejects.toBeInstanceOf(GoogleApiError);
    expect(calls).toBe(1);
  });

  it('stops at once for a cancelled run', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(withRetries(async () => 'x', { ...env, signal: controller.signal })).rejects.toMatchObject({
      code: 'ABORTED',
    });
  });

  it('reports a run that is cancelled during the wait between two attempts as ABORTED', async () => {
    const controller = new AbortController();
    let calls = 0;
    const timing = { ...FAST_TIMING, minDelayMs: 10_000, maxDelayMs: 10_000 };
    const error = await withRetries(
      async () => {
        calls += 1;
        throw apiFailure(503, 'backendError');
      },
      { signal: controller.signal, timing },
      () => setTimeout(() => controller.abort(), 10),
    ).catch((err: unknown) => err);
    expect(error).toMatchObject({ code: 'ABORTED', message: 'The run was cancelled.' });
    expect(calls).toBe(1);
  });

  it('tells the caller how many failures there were, and waits as long as Retry-After says', async () => {
    const seen: [number, number][] = [];
    const retryAfter = (status: number) => parseApiFailure(status, '', new Headers({ 'retry-after': '0' }));
    let calls = 0;
    await withRetries(
      async () => {
        calls += 1;
        if (calls < 4) throw retryAfter(503);
        return 'ok';
      },
      // Waits of 10 s would make this test time out unless Retry-After replaced them.
      {
        signal: new AbortController().signal,
        timing: { ...FAST_TIMING, minDelayMs: 10_000, maxDelayMs: 10_000 },
      },
      (failures, err) => seen.push([failures, err.status]),
    );
    expect(seen).toEqual([
      [1, 503],
      [2, 503],
      [3, 503],
    ]);
  });
});

describe('callApi', () => {
  let fake: FakeGoogle;

  beforeEach(async () => {
    fake = await startFakeGoogle();
  });

  afterEach(async () => {
    await fake.stop();
  });

  class Tokens implements TokenProvider {
    issued = 0;
    invalidated = 0;
    async get(): Promise<string> {
      return fake.accessToken(this.issued + 1);
    }
    invalidate(): void {
      this.invalidated += 1;
      this.issued += 1;
    }
  }

  const call = (tokens: TokenProvider) =>
    callApi(
      {
        url: `${fake.url}/youtube/v3/playlistItems?part=snippet`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
      { tokens, signal: new AbortController().signal, timing: FAST_TIMING },
    );

  it('sends the token in the Authorization header only', async () => {
    const answer = await call(new Tokens());
    expect(answer.status).toBe(200);
    const [request] = fake.requests;
    expect(request?.headers.authorization).toBe(`Bearer ${fake.accessToken(1)}`);
    expect(request?.query.get('part')).toBe('snippet');
    expect([...(request?.query.values() ?? [])].join('')).not.toContain('ya29');
  });

  it('retries a temporary failure', async () => {
    fake.intercept((r) => r.path === '/youtube/v3/playlistItems', googleError(503, 'backendError'), 2);
    expect((await call(new Tokens())).status).toBe(200);
    expect(fake.requests).toHaveLength(3);
  });

  it('gets a new token once when Google answers 401, then tries again', async () => {
    fake.intercept((r) => r.path === '/youtube/v3/playlistItems', googleError(401, 'authError'));
    const tokens = new Tokens();
    expect((await call(tokens)).status).toBe(200);
    expect(tokens.invalidated).toBe(1);
    expect(fake.requests.map((r) => r.headers.authorization)).toEqual([
      `Bearer ${fake.accessToken(1)}`,
      `Bearer ${fake.accessToken(2)}`,
    ]);
  });

  it('stops after a second 401', async () => {
    fake.intercept((r) => r.path === '/youtube/v3/playlistItems', googleError(401, 'authError'), 5);
    const tokens = new Tokens();
    await expect(call(tokens)).rejects.toMatchObject({ status: 401 });
    expect(tokens.invalidated).toBe(1);
    expect(fake.requests).toHaveLength(2);
  });

  it('does not retry a refusal', async () => {
    fake.intercept((r) => r.path === '/youtube/v3/playlistItems', googleError(403, 'forbidden'), 5);
    await expect(call(new Tokens())).rejects.toMatchObject({ status: 403, reasons: ['forbidden'] });
    expect(fake.requests).toHaveLength(1);
  });

  it('retries when the connection is cut', async () => {
    fake.intercept((r) => r.path === '/youtube/v3/playlistItems', { kind: 'drop' });
    expect((await call(new Tokens())).status).toBe(200);
    expect(fake.requests).toHaveLength(2);
  });

  it('never follows a redirect', async () => {
    fake.intercept((r) => r.path === '/youtube/v3/playlistItems', {
      kind: 'json',
      status: 302,
      headers: { Location: 'http://127.0.0.1:1/steal' },
    });
    await expect(call(new Tokens())).rejects.toMatchObject({ status: 302 });
    expect(fake.requests).toHaveLength(1);
  });
});
