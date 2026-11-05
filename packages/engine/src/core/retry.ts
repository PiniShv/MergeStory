/** Retries with exponential backoff and jitter, plus a fetch wrapper that honours Retry-After. */
import { MergeStoryError, TimedOutError } from './errors.ts';

interface BackoffOptions {
  /** Wait before the first retry. Default 500. */
  minDelayMs?: number;
  /** No wait is longer than this. Default 20 000. */
  maxDelayMs?: number;
  /** How much longer each wait is than the one before. Default 2. */
  factor?: number;
}

export interface RetryOptions extends BackoffOptions {
  /** Total attempts including the first one. */
  attempts?: number;
  signal?: AbortSignal;
  /** Return true when the error is worth retrying. Defaults to `err.retryable === true`. */
  isRetryable?: (err: unknown) => boolean;
  /** Called before each wait. `delayMs` may come from a Retry-After header. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  /** Lets an error dictate the wait (for example from Retry-After). */
  delayFor?: (err: unknown) => number | null;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** True for an error that says it is worth another try (`retryable: true`), such as a MergeStoryError or HttpError. */
export function defaultIsRetryable(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { retryable?: unknown }).retryable === true);
}

/**
 * The wait before retry number `attempt` (1 for the first retry). It grows with each retry up to
 * `maxDelayMs`, and half of it is random, so that clients that failed together do not retry together.
 * A `suggestedMs` (for example from Retry-After) takes the place of the computed wait, still capped.
 */
export function backoffMs(
  attempt: number,
  options: BackoffOptions = {},
  suggestedMs: number | null = null,
): number {
  const minDelay = options.minDelayMs ?? 500;
  const maxDelay = options.maxDelayMs ?? 20_000;
  const factor = options.factor ?? 2;
  const backoff = Math.min(maxDelay, minDelay * factor ** (attempt - 1));
  const jittered = backoff / 2 + Math.random() * (backoff / 2);
  return Math.min(maxDelay, suggestedMs ?? jittered);
}

export async function retry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 4);
  const isRetryable = options.isRetryable ?? defaultIsRetryable;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt >= attempts || !isRetryable(err) || options.signal?.aborted) throw err;
      const delayMs = backoffMs(attempt, options, options.delayFor?.(err) ?? null);
      options.onRetry?.({ attempt, delayMs, error: err });
      await sleep(delayMs, options.signal);
    }
  }
  throw lastError;
}

/** Parse a Retry-After header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null | undefined): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

export class HttpError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  /** First part of the response body, for diagnostics. Never contains request headers. */
  readonly bodySnippet: string;

  constructor(status: number, message: string, bodySnippet: string, retryAfterMs: number | null) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.bodySnippet = bodySnippet;
    this.retryAfterMs = retryAfterMs;
    this.retryable = status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  }
}

export interface FetchRetryOptions extends RetryOptions {
  timeoutMs?: number;
  /** Status codes that should be returned instead of thrown (e.g. 404 handled by the caller). */
  allowStatus?: number[];
}

/**
 * fetch with timeout, retries on network errors / 408 / 429 / 5xx, and Retry-After support.
 * Non-OK responses (other than allowStatus) throw HttpError with a short body snippet.
 */
export async function fetchWithRetry(
  url: string | URL,
  init: RequestInit = {},
  options: FetchRetryOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  return retry(
    async () => {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await fetch(url, { ...init, signal });
      } catch (err) {
        if (options.signal?.aborted) throw err;
        const reason = err instanceof Error ? err.message : String(err);
        const message = `Network request failed: ${reason}`;
        const failure = { cause: err, retryable: true };
        // Only the timeout of this request counts as one: the caller's own signal was checked above.
        throw timeout.aborted
          ? new TimedOutError(message, failure)
          : new MergeStoryError('INTERNAL', message, failure);
      }
      if (response.ok || options.allowStatus?.includes(response.status)) return response;
      const text = await response.text().catch(() => '');
      throw new HttpError(
        response.status,
        `HTTP ${response.status} ${response.statusText}`.trim(),
        text.slice(0, 500),
        parseRetryAfter(response.headers.get('retry-after')),
      );
    },
    {
      ...options,
      delayFor: options.delayFor ?? ((err) => (err instanceof HttpError ? err.retryAfterMs : null)),
    },
  );
}
