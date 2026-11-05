import { DEFAULT_RETRY, type RetryOptions } from './retry.ts';

export interface WeatherConfig extends Partial<RetryOptions> {
  apiUrl: string;
  timeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WeatherConfig {
  return {
    apiUrl: env.WEATHER_API_URL ?? 'https://api.example.com',
    timeoutMs: Number(env.WEATHER_TIMEOUT_MS ?? 10_000),
    retries: Number(env.WEATHER_RETRIES ?? DEFAULT_RETRY.retries),
    baseDelayMs: Number(env.WEATHER_BASE_DELAY_MS ?? DEFAULT_RETRY.baseDelayMs),
    maxDelayMs: Number(env.WEATHER_MAX_DELAY_MS ?? DEFAULT_RETRY.maxDelayMs),
  };
}
