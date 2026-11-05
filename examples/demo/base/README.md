# weather-client

A small client for a weather API.

```js
import { WeatherClient, loadConfig } from 'weather-client';

const client = new WeatherClient(loadConfig());
const forecast = await client.getForecast('Lisbon');
console.log(`${forecast.city}: ${forecast.temperatureC} °C, ${forecast.summary}`);
```

Configuration comes from environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `WEATHER_API_URL` | `https://api.example.com` | Base URL of the weather API |
| `WEATHER_TIMEOUT_MS` | `10000` | Request timeout in milliseconds |
