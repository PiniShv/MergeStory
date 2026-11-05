/**
 * HTTP plumbing for the Google APIs: requests with a timeout, retries with backoff, parsing of
 * Google's error bodies, and the translation of failures into MergeStory errors.
 *
 * Nothing here logs request headers or bodies. Access tokens travel only in the Authorization
 * header, never in a URL.
 */
import type { RunContext } from '../../core/context.ts';
import { abortedError, assertNotAborted, MergeStoryError } from '../../core/errors.ts';
import { isRecord } from '../../core/json.ts';
import { parseRetryAfter, retry, sleep } from '../../core/retry.ts';
import { cleanText } from '../text.ts';

/** The Google services the publisher talks to. Tests point these at a local server. */
export interface YouTubeEndpoints {
  /** Origin of the YouTube Data API. */
  apiBase: string;
  tokenUrl: string;
  authUrl: string;
}

export const GOOGLE_ENDPOINTS: YouTubeEndpoints = {
  apiBase: 'https://www.googleapis.com',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
};

export interface Timing {
  /** Failed attempts in a row that are retried before the error is returned. */
  maxRetries: number;
  minDelayMs: number;
  maxDelayMs: number;
  /** Time allowed for one request, before the time for the bytes is added. */
  requestTimeoutMs: number;
}

export const DEFAULT_TIMING: Timing = {
  maxRetries: 8,
  minDelayMs: 1_000,
  maxDelayMs: 30_000,
  requestTimeoutMs: 60_000,
};

/** What a caller needs to make requests: cancellation and timing. */
export interface HttpEnv {
  signal: AbortSignal;
  timing: Timing;
}

/** Supplies access tokens. `invalidate` drops the cached token so the next `get` fetches a new one. */
export interface TokenProvider {
  get(): Promise<string>;
  invalidate(): void;
}

const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);
/** Rate limits that clear within seconds. quotaExceeded is not among them: it lasts until the next day. */
const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'backendError']);

/** A failed call to a Google API, with the parts of the answer that are safe to show. */
export class GoogleApiError extends Error {
  /** HTTP status, or 0 when no answer came back. */
  readonly status: number;
  /** Reason codes from the error body, most specific first (for example "quotaExceeded"). */
  readonly reasons: string[];
  /** Google's own description, shortened and without markup. */
  readonly apiMessage: string;
  readonly retryAfterMs: number | null;
  /** true when the same request may work if sent again shortly. */
  readonly transient: boolean;

  constructor(status: number, reasons: string[], apiMessage: string, retryAfterMs: number | null) {
    super(`Google API error ${status}${reasons[0] ? ` (${reasons[0]})` : ''}`);
    this.name = 'GoogleApiError';
    this.status = status;
    this.reasons = reasons;
    this.apiMessage = apiMessage;
    this.retryAfterMs = retryAfterMs;
    this.transient =
      status === 0 ||
      (TRANSIENT_STATUS.has(status) && !reasons.includes('uploadRateLimitExceeded')) ||
      (status === 403 && reasons.some((reason) => RATE_LIMIT_REASONS.has(reason)));
  }

  has(reason: string): boolean {
    return this.reasons.includes(reason);
  }
}

interface ParsedBody {
  reasons: string[];
  message: string;
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Read the reasons and message of an error body. Both Google error shapes are understood. */
function parseBody(text: string): ParsedBody {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { reasons: [], message: '' };
  }
  if (!isRecord(data)) return { reasons: [], message: '' };
  // OAuth shape: {"error":"invalid_grant","error_description":"..."}
  const oauthError = stringOf(data.error);
  if (oauthError) return { reasons: [oauthError], message: stringOf(data.error_description) ?? '' };
  // API shape: {"error":{"code":403,"message":"...","errors":[{"reason":"..."}],"status":"...","details":[{"reason":"..."}]}}
  const error = data.error;
  if (!isRecord(error)) return { reasons: [], message: '' };
  const reasons: string[] = [];
  const add = (value: unknown) => {
    const reason = stringOf(value);
    if (reason && !reasons.includes(reason)) reasons.push(reason);
  };
  for (const list of [error.errors, error.details]) {
    if (Array.isArray(list)) for (const item of list) add(isRecord(item) ? item.reason : undefined);
  }
  add(error.status);
  return { reasons, message: stringOf(error.message) ?? '' };
}

/** Short, plain text of a Google message: markup and control characters removed. */
function plainMessage(message: string): string {
  return cleanText(message.replace(/<[^>]*>/g, ' '), 200);
}

/** Turn a non-success answer into a GoogleApiError. */
export function parseApiFailure(status: number, bodyText: string, headers?: Headers): GoogleApiError {
  const { reasons, message } = parseBody(bodyText.slice(0, 64 * 1024));
  return new GoogleApiError(
    status,
    reasons,
    plainMessage(message),
    parseRetryAfter(headers?.get('retry-after') ?? null),
  );
}

function describeNetworkError(err: unknown): string {
  if (err instanceof Error && err.name === 'TimeoutError') return 'the request timed out';
  const cause = err instanceof Error ? (err as { cause?: unknown }).cause : undefined;
  const code = cause && typeof cause === 'object' ? (cause as { code?: unknown }).code : undefined;
  if (typeof code === 'string') return code;
  return err instanceof Error ? cleanText(err.message, 120) : 'unknown network error';
}

/**
 * One request with a timeout. Redirects are never followed, so a stray Location header can
 * never carry the Authorization header to another host. Network failures become transient
 * GoogleApiErrors; a cancelled run becomes ABORTED.
 */
export async function sendRequest(
  url: string,
  init: RequestInit,
  options: { signal: AbortSignal; timeoutMs: number },
): Promise<Response> {
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]);
  try {
    return await fetch(url, { ...init, redirect: 'manual', signal });
  } catch (err) {
    if (options.signal.aborted) throw abortedError(err);
    const failure = new GoogleApiError(0, [], describeNetworkError(err), null);
    failure.cause = err;
    throw failure;
  }
}

/** Read an answer's body. A connection that breaks half way is a transient failure, not a crash. */
export async function readAnswerBody(response: Response, signal: AbortSignal): Promise<string> {
  try {
    return await response.text();
  } catch (err) {
    if (signal.aborted) throw abortedError(err);
    const failure = new GoogleApiError(0, [], describeNetworkError(err), null);
    failure.cause = err;
    throw failure;
  }
}

/** sleep() that reports a cancelled run as ABORTED. */
export async function pause(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await sleep(ms, signal);
  } catch (err) {
    throw abortedError(err);
  }
}

/** Run `fn`, and run it again after a pause while it fails with a transient GoogleApiError. */
export async function withRetries<T>(
  fn: () => Promise<T>,
  env: HttpEnv,
  onRetry?: (failures: number, err: GoogleApiError) => void,
): Promise<T> {
  try {
    return await retry(
      async () => {
        assertNotAborted(env.signal);
        return fn();
      },
      {
        attempts: env.timing.maxRetries + 1,
        minDelayMs: env.timing.minDelayMs,
        maxDelayMs: env.timing.maxDelayMs,
        signal: env.signal,
        isRetryable: (err) => err instanceof GoogleApiError && err.transient,
        delayFor: (err) => (err instanceof GoogleApiError ? err.retryAfterMs : null),
        onRetry: ({ attempt, error }) => onRetry?.(attempt, error as GoogleApiError),
      },
    );
  } catch (err) {
    // A cancelled run that ends the wait between two attempts ends it with the signal's own reason.
    throw env.signal.aborted && err === env.signal.reason ? abortedError(err) : err;
  }
}

export interface ApiCall {
  url: string;
  method: 'GET' | 'POST' | 'PUT';
  headers?: Record<string, string>;
  /** Must be replayable (a string or bytes): the call is repeated after a transient failure. */
  body?: string | Uint8Array;
  /** Statuses outside 2xx that still count as an answer. */
  acceptStatus?: number[];
  /** Extra time for large bodies. */
  timeoutMs?: number;
}

export interface ApiAnswer {
  status: number;
  headers: Headers;
  text: string;
}

/**
 * An authorised API call. Retries transient failures, and refreshes the access token once when
 * Google answers 401 (the token may simply have expired).
 */
export async function callApi(
  call: ApiCall,
  env: HttpEnv & { tokens: TokenProvider },
  onRetry?: (failures: number, err: GoogleApiError) => void,
): Promise<ApiAnswer> {
  let refreshed = false;
  const attempt = async (): Promise<ApiAnswer> => {
    const token = await env.tokens.get();
    const init: RequestInit = {
      method: call.method,
      headers: { ...call.headers, Authorization: `Bearer ${token}` },
      ...(call.body === undefined ? {} : { body: call.body }),
    };
    const response = await sendRequest(call.url, init, {
      signal: env.signal,
      timeoutMs: call.timeoutMs ?? env.timing.requestTimeoutMs,
    });
    const text = await readAnswerBody(response, env.signal);
    if (response.ok || call.acceptStatus?.includes(response.status)) {
      return { status: response.status, headers: response.headers, text };
    }
    throw parseApiFailure(response.status, text, response.headers);
  };
  return withRetries(
    async () => {
      try {
        return await attempt();
      } catch (err) {
        if (err instanceof GoogleApiError && err.status === 401 && !refreshed) {
          refreshed = true;
          env.tokens.invalidate();
          return attempt();
        }
        throw err;
      }
    },
    env,
    onRetry,
  );
}

const SIGN_IN_AGAIN =
  'Run `mergestory setup youtube` to sign in again. If the OAuth consent screen is External and its status is "Testing", ' +
  'Google ends each sign-in after 7 days: publish the app, or use an Internal app, so the sign-in lasts (see docs/youtube.md in the MergeStory repository).';

/** How a failed call is explained to the person who ran the command. */
interface Explanation {
  code: 'CONFIG_INVALID' | 'PUBLISH_FAILED';
  message: string;
  hint: string;
}

function explain(err: GoogleApiError, forToken: 'refresh' | 'exchange' | null): Explanation {
  const { status } = err;
  if (status === 0) {
    return {
      code: 'PUBLISH_FAILED',
      message: `YouTube could not be reached (${err.apiMessage}).`,
      hint: 'Check your network connection, then try again.',
    };
  }
  if (forToken === 'exchange' && err.has('invalid_grant')) {
    return {
      code: 'CONFIG_INVALID',
      message: 'Google did not accept the sign-in code.',
      hint: 'Run `mergestory setup youtube` again and finish the sign-in in the browser soon after it opens. Each code works once.',
    };
  }
  if (err.has('invalid_grant')) {
    return {
      code: 'CONFIG_INVALID',
      message: 'Google no longer accepts the saved YouTube sign-in.',
      hint: SIGN_IN_AGAIN,
    };
  }
  if (err.has('invalid_client') || err.has('unauthorized_client')) {
    return {
      code: 'CONFIG_INVALID',
      message: 'Google rejected the OAuth client id or secret.',
      hint:
        'Check MERGESTORY_YOUTUBE_CLIENT_ID and MERGESTORY_YOUTUBE_CLIENT_SECRET, or run `mergestory setup youtube` again. ' +
        'The client must be of the type "Desktop app".',
    };
  }
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
  if (status === 401) {
    return {
      code: 'CONFIG_INVALID',
      message: 'YouTube did not accept the saved sign-in.',
      hint: SIGN_IN_AGAIN,
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
  if (status === 403) {
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
  if (status === 400 && invalid) {
    return {
      code: 'PUBLISH_FAILED',
      message: `YouTube rejected the video details (${invalid}).`,
      hint: 'Check publish.youtube.categoryId and the language setting, then try again.',
    };
  }
  if (err.transient) {
    return {
      code: 'PUBLISH_FAILED',
      message: `YouTube had a temporary problem (HTTP ${status}).`,
      hint: 'Try again in a few minutes.',
    };
  }
  return {
    code: 'PUBLISH_FAILED',
    message: `YouTube answered HTTP ${status}${err.reasons[0] ? ` (${err.reasons[0]})` : ''}.`,
    hint: 'Check your settings and the sign-in, then try again.',
  };
}

/**
 * Turn anything thrown while talking to Google into a MergeStoryError: authorisation problems
 * become CONFIG_INVALID, everything else PUBLISH_FAILED. Cancellation stays ABORTED.
 */
export function toYouTubeError(
  err: unknown,
  action: string,
  ctx: Pick<RunContext, 'redactor' | 'signal'>,
  forToken: 'refresh' | 'exchange' | null = null,
): MergeStoryError {
  if (err instanceof MergeStoryError) return err;
  if (ctx.signal.aborted || (err instanceof Error && err.name === 'AbortError')) return abortedError(err);
  if (err instanceof GoogleApiError) {
    const { code, message, hint } = explain(err, forToken);
    return new MergeStoryError(
      code,
      ctx.redactor.redact(code === 'PUBLISH_FAILED' ? `${action} failed: ${message}` : message),
      {
        hint: ctx.redactor.redact(hint),
        cause: err,
        retryable: err.transient,
        details: {
          status: err.status,
          ...(err.reasons[0] ? { reason: err.reasons[0] } : {}),
          ...(err.apiMessage ? { google: ctx.redactor.redact(err.apiMessage) } : {}),
        },
      },
    );
  }
  const text = err instanceof Error ? err.message : String(err);
  return new MergeStoryError(
    'PUBLISH_FAILED',
    ctx.redactor.redact(`${action} failed: ${cleanText(text, 200)}`),
    {
      cause: err,
      hint: 'Run again with --log-level debug for details.',
    },
  );
}
