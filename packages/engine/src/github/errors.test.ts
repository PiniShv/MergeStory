import { describe, expect, it } from 'vitest';
import { describeFailure, describePath, transportFailure, unexpectedResponse } from './errors.ts';

const URL_ = 'https://api.github.com/repos/acme/widgets/pulls/7';

function failure(
  status: number,
  options: { headers?: Record<string, string>; text?: string; method?: string; authenticated?: boolean } = {},
) {
  return describeFailure({
    status,
    headers: new Headers(options.headers),
    text: options.text ?? '',
    method: options.method ?? 'GET',
    url: URL_,
    authenticated: options.authenticated ?? true,
    redact: (text) => text.replaceAll('SECRET', '***'),
    now: Date.parse('2026-01-01T00:00:00Z'),
  });
}

describe('describeFailure', () => {
  it('maps 401, 403 and 404 to their codes and hints', () => {
    expect(failure(401).error).toMatchObject({ code: 'GITHUB_AUTH' });
    expect(failure(403).error.hint).toMatch(/Pull requests: read/);
    expect(failure(403, { method: 'POST' }).error.hint).toMatch(/Pull requests: write/);
    expect(failure(403, { headers: { 'x-github-sso': 'required' } }).error.hint).toMatch(/SAML SSO/);
    expect(failure(404, { authenticated: false }).error).toMatchObject({ code: 'SOURCE_NOT_FOUND' });
    expect(failure(404, { authenticated: false }).error.hint).toMatch(/Private repositories need a token/);
  });

  it('redacts and cuts the message from the response', () => {
    const { error } = failure(422, { text: JSON.stringify({ message: `bad SECRET ${'x'.repeat(400)}` }) });
    expect(error.message).not.toContain('SECRET');
    expect(error.message.length).toBeLessThan(400);
  });

  it('reports the reset time of a used-up limit and asks nothing to wait', () => {
    const reset = String(Date.parse('2026-01-01T00:30:00Z') / 1000);
    const result = failure(403, {
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset },
      authenticated: false,
    });
    expect(result.error.code).toBe('RATE_LIMITED');
    expect(result.error.hint).toContain('in about 30 min');
    expect(result.error.hint).toContain('GITHUB_TOKEN');
    expect(result.retryAfterMs).toBeNull();
  });

  it('asks to wait for a short secondary limit, not for a long one', () => {
    expect(failure(429, { headers: { 'retry-after': '3' } }).retryAfterMs).toBe(3000);
    expect(failure(429, { headers: { 'retry-after': '600' } }).retryAfterMs).toBeNull();
  });
});

describe('error helpers', () => {
  it('hides the file name of a contents request', () => {
    expect(describePath('https://api.github.com/repos/a/b/contents/secret/file.txt?ref=x')).toBe(
      '/repos/a/b/contents/...',
    );
  });

  it('names the host that could not be reached', () => {
    expect(transportFailure(new Error('boom'), URL_)).toBeInstanceOf(Error);
    expect(unexpectedResponse('tree').message).toBe('GitHub returned an unexpected tree response.');
  });
});
