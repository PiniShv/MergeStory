import type { WeatherConfig } from './config.ts';

export interface Forecast {
  city: string;
  temperatureC: number;
  summary: string;
}

export class WeatherError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export class WeatherClient {
  readonly #config: WeatherConfig;

  constructor(config: WeatherConfig) {
    this.#config = config;
  }

  async getForecast(city: string): Promise<Forecast> {
    const url = `${this.#config.apiUrl}/v1/forecast?city=${encodeURIComponent(city)}`;
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(this.#config.timeoutMs),
    });
    if (!response.ok) {
      throw new WeatherError(`Forecast failed with status ${response.status}`, response.status);
    }
    return (await response.json()) as Forecast;
  }
}
