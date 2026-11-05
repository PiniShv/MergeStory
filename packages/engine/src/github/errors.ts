/**
 * How a failed GitHub request becomes a MergeStory error: the code, the message and the hint the
 * user reads. These are pure functions of what the response said and whether a token was sent, so
 * the client only has to do the request.
 */
import { isMergeStoryError, MergeStoryError } from '../core/errors.ts';
import { asArray, asString, isRecord } from '../core/json.ts';
import { HttpError, parseRetryAfter } from '../core/retry.ts';

/** A pause that GitHub asks for is waited out only when it is this short. */
const MAX_RETRY_AFTER_MS = 60_000;

/** A response that parsed but does not have the fields this client needs. */
export function unexpectedResponse(what: string): MergeStoryError {
  return new MergeStoryError('GITHUB_FAILED', `GitHub returned an unexpected ${what} response.`, {
    hint: 'This can happen with a very old GitHub Enterprise Server. Check github.apiUrl, or try again.',
  });
}

/** A response body that is not JSON. */
export function unreadableResponse(what: string, status: number): MergeStoryError {
  return new MergeStoryError('GITHUB_FAILED', `GitHub returned an unreadable ${what} response.`, {
    hint: 'GitHub may be having problems, or a proxy changed the answer. Try again in a few minutes.',
    details: { status },
  });
}

/** The path of a request URL for logs and errors, without the name of the file being read. */
export function describePath(url: string): string {
  const { pathname } = new URL(url);
  const index = pathname.indexOf('/contents/');
  return index < 0 ? pathname : `${pathname.slice(0, index)}/contents/...`;
}

/** The error for a request that never got an HTTP answer, or got a server error after its retries. */
export function transportFailure(error: unknown, url: string): unknown {
  const host = new URL(url).host;
  if (error instanceof HttpError) {
    return new MergeStoryError('GITHUB_FAILED', `${host} answered with HTTP ${error.status}.`, {
      hint: 'GitHub may be having problems. Try again in a few minutes.',
      details: { status: error.status },
      retryable: true,
      cause: error,
    });
  }
  if (isMergeStoryError(error) && error.code === 'INTERNAL') {
    return new MergeStoryError('GITHUB_FAILED', `Could not reach ${host}. ${error.message}`, {
      hint: 'Check your network connection and, for GitHub Enterprise, the github.apiUrl setting.',
      retryable: true,
      cause: error,
    });
  }
  return error;
}

/** What the client knows about a failed response. */
export interface FailedResponse {
  status: number;
  headers: Headers;
  /** The body as text (empty when it could not be read). */
  text: string;
  method: string;
  url: string;
  /** True when the request carried a token. */
  authenticated: boolean;
  /** Masks secrets in text taken from the response. */
  redact: (text: string) => string;
  /** The clock, in milliseconds. */
  now?: number;
}

/**
 * The error for a failed response, and how long to wait before repeating the request when
 * GitHub asked for a short pause (secondary rate limit), otherwise null.
 */
export function describeFailure(input: FailedResponse): {
  error: MergeStoryError;
  retryAfterMs: number | null;
} {
  const { status, headers, method, url, authenticated } = input;
  let message = '';
  let errorCode: string | null = null;
  try {
    const parsed: unknown = JSON.parse(input.text);
    if (isRecord(parsed)) {
      message = asString(parsed.message) ?? '';
      const first = asArray(parsed.errors)[0];
      if (isRecord(first)) errorCode = asString(first.code);
    }
  } catch {
    // Not JSON (for example an HTML error page): the status is all we have.
  }
  message = input.redact(message).slice(0, 300);

  const remaining = headers.get('x-ratelimit-remaining');
  const reset = Number(headers.get('x-ratelimit-reset'));
  const retryAfterMs = parseRetryAfter(headers.get('retry-after'));
  const requestId = headers.get('x-github-request-id');
  const details: Record<string, unknown> = { status, request: `${method} ${describePath(url)}` };
  if (requestId) details.requestId = requestId;
  if (errorCode) details.errorCode = errorCode;

  const rateLimited =
    (status === 403 || status === 429) &&
    (remaining === '0' || retryAfterMs !== null || /rate limit|abuse/i.test(message));
  if (rateLimited) {
    const upgrade = authenticated
      ? ''
      : ' Set GITHUB_TOKEN or run "gh auth login" to raise the limit from 60 to 5,000 requests per hour.';
    if (remaining === '0' && Number.isFinite(reset) && reset > 0) {
      const resetAt = new Date(reset * 1000);
      const minutes = Math.max(1, Math.ceil((resetAt.getTime() - (input.now ?? Date.now())) / 60_000));
      return {
        error: new MergeStoryError('RATE_LIMITED', 'The GitHub API rate limit is used up.', {
          hint: `The limit resets at ${resetAt.toISOString()} (in about ${minutes} min).${upgrade}`,
          details: { ...details, resetAt: resetAt.toISOString() },
          retryable: true,
        }),
        retryAfterMs: null,
      };
    }
    const waitable = retryAfterMs !== null && retryAfterMs <= MAX_RETRY_AFTER_MS ? retryAfterMs : null;
    return {
      error: new MergeStoryError(
        'RATE_LIMITED',
        'GitHub asked for a pause between requests (secondary rate limit).',
        {
          hint: `Wait a minute and run again.${upgrade}`,
          details,
          retryable: true,
        },
      ),
      retryAfterMs: waitable,
    };
  }

  const write = method !== 'GET' && !url.endsWith('/graphql') && !url.endsWith('/api/graphql');
  const suffix = message ? ` (${message})` : '';
  if (status === 401) {
    return {
      error: new MergeStoryError('GITHUB_AUTH', `GitHub rejected the token (HTTP 401).${suffix}`, {
        hint:
          'Set GITHUB_TOKEN to a valid token, or run "gh auth login". A fine-grained token needs ' +
          '"Pull requests: read" and "Contents: read".',
        details,
      }),
      retryAfterMs: null,
    };
  }
  if (status === 403) {
    const sso = headers.get('x-github-sso') !== null;
    return {
      error: new MergeStoryError('GITHUB_AUTH', `GitHub denied access (HTTP 403).${suffix}`, {
        hint: sso
          ? 'This organization requires SAML SSO. Authorize the token for it in your GitHub token settings.'
          : write
            ? 'The token needs "Pull requests: write" (or "Issues: write"). Tokens in pull requests from forks are read-only.'
            : 'The token needs "Pull requests: read" and "Contents: read" for this repository.',
        details,
      }),
      retryAfterMs: null,
    };
  }
  if (status === 404) {
    return {
      error: new MergeStoryError('SOURCE_NOT_FOUND', `GitHub could not find ${describePath(url)}.${suffix}`, {
        hint: authenticated
          ? 'Check the URL. The token may not have access to this repository.'
          : 'Check the URL. Private repositories need a token: set GITHUB_TOKEN or run "gh auth login".',
        details,
      }),
      retryAfterMs: null,
    };
  }
  return {
    error: new MergeStoryError('GITHUB_FAILED', `GitHub returned HTTP ${status}.${suffix}`, {
      hint:
        status === 422 && /too long/i.test(message)
          ? 'The text is longer than GitHub allows (65,536 characters).'
          : 'Check the request and try again. If it keeps failing, check https://www.githubstatus.com.',
      details,
    }),
    retryAfterMs: null,
  };
}
