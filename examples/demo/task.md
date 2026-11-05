Forecast requests sometimes fail with 429 or 503 when the weather API is busy, or with a network error,
and callers have to retry by hand. Add automatic retries to WeatherClient.getForecast for temporary
failures (network errors, 429 and 5xx), with exponential backoff, and respect Retry-After.
