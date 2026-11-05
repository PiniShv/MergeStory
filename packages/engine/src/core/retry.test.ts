import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MergeStoryError, TimedOutError } from './errors.ts';
import { backoffMs, defaultIsRetryable, fetchWithRetry, HttpError, retry } from './retry.ts';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A fetch that never answers and fails the way Node does when the request signal fires. */
function silentServer(): void {
  fetchMock.mockImplementation(
    (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }),
  );
}

const rejection = (promise: Promise<unknown>): Promise<unknown> => promise.catch((e: unknown) => e);

describe('fetchWithRetry failures', () => {
  it('reports a request that ran out of time as TimedOutError that is worth another try', async () => {
    silentServer();
    const error = await rejection(fetchWithRetry('http://127.0.0.1:9/', {}, { timeoutMs: 20, attempts: 1 }));
    expect(error).toBeInstanceOf(TimedOutError);
    expect(error).toMatchObject({ code: 'INTERNAL', retryable: true });
    expect((error as Error).message).toMatch(/^Network request failed: .*timeout/i);
    expect((error as Error).cause).toBeInstanceOf(DOMException);
  });

  it('keeps other network failures as a plain retryable error', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const error = await rejection(fetchWithRetry('http://127.0.0.1:9/', {}, { attempts: 1 }));
    expect(error).toBeInstanceOf(MergeStoryError);
    expect(error).not.toBeInstanceOf(TimedOutError);
    expect(error).toMatchObject({
      code: 'INTERNAL',
      message: 'Network request failed: fetch failed',
      retryable: true,
    });
  });

  it('passes on the failure of a cancelled request as it is', async () => {
    silentServer();
    const controller = new AbortController();
    const pending = rejection(
      fetchWithRetry('http://127.0.0.1:9/', {}, { signal: controller.signal, timeoutMs: 5_000, attempts: 3 }),
    );
    controller.abort();
    const error = await pending;
    expect(error).not.toBeInstanceOf(MergeStoryError);
    expect((error as Error).name).toBe('AbortError');
  });
});

describe('defaultIsRetryable', () => {
  it('is true for an error that says so, and for nothing else', () => {
    expect(defaultIsRetryable(new MergeStoryError('INTERNAL', 'x', { retryable: true }))).toBe(true);
    expect(defaultIsRetryable(new HttpError(503, 'HTTP 503', '', null))).toBe(true);
    expect(defaultIsRetryable(new HttpError(404, 'HTTP 404', '', null))).toBe(false);
    expect(defaultIsRetryable(new MergeStoryError('INTERNAL', 'x'))).toBe(false);
    for (const value of [null, undefined, 'retryable', 1, { retryable: 'yes' }, new Error('x')]) {
      expect(defaultIsRetryable(value), String(value)).toBe(false);
    }
  });
});

describe('backoffMs', () => {
  const options = { minDelayMs: 100, maxDelayMs: 1_000 };

  it('doubles the wait with each retry, keeps half of it random, and stops at the maximum', () => {
    for (let i = 0; i < 50; i++) {
      expect(backoffMs(1, options)).toBeGreaterThanOrEqual(50);
      expect(backoffMs(1, options)).toBeLessThanOrEqual(100);
      expect(backoffMs(3, options)).toBeGreaterThanOrEqual(200);
      expect(backoffMs(3, options)).toBeLessThanOrEqual(400);
      expect(backoffMs(30, options)).toBeGreaterThanOrEqual(500);
      expect(backoffMs(30, options)).toBeLessThanOrEqual(1_000);
    }
  });

  it('uses the factor that is given', () => {
    for (let i = 0; i < 50; i++) {
      const wait = backoffMs(3, { minDelayMs: 100, maxDelayMs: 100_000, factor: 3 });
      expect(wait).toBeGreaterThanOrEqual(450);
      expect(wait).toBeLessThanOrEqual(900);
    }
  });

  it('takes the suggested wait instead, up to the maximum', () => {
    expect(backoffMs(1, options, 300)).toBe(300);
    expect(backoffMs(5, options, 0)).toBe(0);
    expect(backoffMs(1, options, 60_000)).toBe(1_000);
  });

  it('has defaults for every setting', () => {
    const wait = backoffMs(1);
    expect(wait).toBeGreaterThanOrEqual(250);
    expect(wait).toBeLessThanOrEqual(500);
    expect(backoffMs(99)).toBeLessThanOrEqual(20_000);
  });
});

describe('retry', () => {
  const quick = { minDelayMs: 1, maxDelayMs: 2 };
  const flaky = () => new MergeStoryError('INTERNAL', 'try again', { retryable: true });

  it('runs again after a failure that is worth another try, and numbers the attempts from 1', async () => {
    const seen: number[] = [];
    const result = await retry(async (attempt) => {
      seen.push(attempt);
      if (attempt < 3) throw flaky();
      return 'ok';
    }, quick);
    expect(result).toBe('ok');
    expect(seen).toEqual([1, 2, 3]);
  });

  it('gives up after the attempts that were allowed, with the last error', async () => {
    let calls = 0;
    const error = await rejection(
      retry(
        async () => {
          calls += 1;
          throw flaky();
        },
        { ...quick, attempts: 2 },
      ),
    );
    expect(calls).toBe(2);
    expect(error).toMatchObject({ message: 'try again' });
  });

  it('does not repeat an error that is not retryable', async () => {
    let calls = 0;
    const error = await rejection(
      retry(async () => {
        calls += 1;
        throw new MergeStoryError('USAGE', 'no');
      }, quick),
    );
    expect(calls).toBe(1);
    expect(error).toMatchObject({ code: 'USAGE' });
  });

  it('asks isRetryable, reports each wait, and lets the error suggest it', async () => {
    const waits: { attempt: number; delayMs: number }[] = [];
    let calls = 0;
    await retry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('flaky');
        return 'ok';
      },
      {
        ...quick,
        isRetryable: (err) => err instanceof Error && err.message === 'flaky',
        delayFor: () => 1,
        onRetry: ({ attempt, delayMs }) => waits.push({ attempt, delayMs }),
      },
    );
    expect(waits).toEqual([
      { attempt: 1, delayMs: 1 },
      { attempt: 2, delayMs: 1 },
    ]);
  });

  it('stops waiting when the signal fires', async () => {
    const controller = new AbortController();
    const pending = rejection(
      retry(
        async () => {
          throw flaky();
        },
        {
          minDelayMs: 10_000,
          maxDelayMs: 10_000,
          signal: controller.signal,
          onRetry: () => controller.abort(),
        },
      ),
    );
    expect(await pending).toBe(controller.signal.reason);
  });
});
