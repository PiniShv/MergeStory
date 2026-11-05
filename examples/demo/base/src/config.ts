export interface WeatherConfig {
  apiUrl: string;
  timeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WeatherConfig {
  return {
    apiUrl: env.WEATHER_API_URL ?? 'https://api.example.com',
    timeoutMs: Number(env.WEATHER_TIMEOUT_MS ?? 10_000),
  };
}
