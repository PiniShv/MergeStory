import type { WeatherConfig } from './config.ts';
import { isRetryableStatus, type RetryDecision, withRetry } from './retry.ts';

export interface Forecast {
  city: string;
  temperatureC: number;
  summary: string;
}

export class WeatherError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;

  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Retry-After holds either a number of seconds or an HTTP date. */
function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  const ms = Number.isNaN(seconds) ? Date.parse(header) - Date.now() : seconds * 1000;
  return ms >= 0 ? ms : undefined;
}

/** Network errors, 429 and 5xx are worth another try. Everything else fails at once. */
function retryDecision(error: unknown): RetryDecision {
  if (error instanceof WeatherError) {
    return isRetryableStatus(error.status) ? { retry: true, afterMs: error.retryAfterMs } : { retry: false };
  }
  // fetch rejects with a TypeError when the request gets no response at all.
  return { retry: error instanceof TypeError };
}

export class WeatherClient {
  readonly #config: WeatherConfig;

  constructor(config: WeatherConfig) {
    this.#config = config;
  }

  async getForecast(city: string): Promise<Forecast> {
    const url = `${this.#config.apiUrl}/v1/forecast?city=${encodeURIComponent(city)}`;
    return withRetry(
      async () => {
        const response = await fetch(url, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(this.#config.timeoutMs),
        });
        if (!response.ok) {
          throw new WeatherError(
            `Forecast failed with status ${response.status}`,
            response.status,
            retryAfterMs(response),
          );
        }
        return (await response.json()) as Forecast;
      },
      retryDecision,
      this.#config,
    );
  }
}
