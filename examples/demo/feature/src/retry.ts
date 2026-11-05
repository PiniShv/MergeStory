export interface RetryOptions {
  /** Extra attempts after the first one. */
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryOptions = { retries: 3, baseDelayMs: 250, maxDelayMs: 4_000 };

/** What a failed attempt tells the retry loop: try again or not, and how long to wait. */
export interface RetryDecision {
  retry: boolean;
  afterMs?: number;
}

/** 429 and 5xx responses are temporary; any other 4xx will fail again. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Full jitter: a random wait between 0 and the exponential cap. */
export function backoffDelay(attempt: number, options: RetryOptions): number {
  const cap = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** attempt);
  return Math.random() * cap;
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  shouldRetry: (error: unknown) => RetryDecision,
  overrides: Partial<RetryOptions> = {},
): Promise<T> {
  const options = { ...DEFAULT_RETRY, ...overrides };
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const decision = shouldRetry(error);
      if (!decision.retry || attempt >= options.retries) throw error;
      const wait = decision.afterMs ?? backoffDelay(attempt, options);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}
