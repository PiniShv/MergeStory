# weather-client

A small client for a weather API.

```js
import { WeatherClient, loadConfig } from 'weather-client';

const client = new WeatherClient(loadConfig());
const forecast = await client.getForecast('Lisbon');
console.log(`${forecast.city}: ${forecast.temperatureC} °C, ${forecast.summary}`);
```

Temporary failures are retried with exponential backoff and jitter: network errors, HTTP 429
and 5xx. Other errors, such as 404, fail at once. A `Retry-After` header from the API wins
over the computed wait.

Configuration comes from environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `WEATHER_API_URL` | `https://api.example.com` | Base URL of the weather API |
| `WEATHER_TIMEOUT_MS` | `10000` | Request timeout in milliseconds, for each attempt |
| `WEATHER_RETRIES` | `3` | Extra attempts after a temporary failure |
| `WEATHER_BASE_DELAY_MS` | `250` | First backoff step in milliseconds |
| `WEATHER_MAX_DELAY_MS` | `4000` | Longest backoff wait in milliseconds |
