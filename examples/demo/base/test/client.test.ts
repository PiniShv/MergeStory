import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WeatherClient } from '../src/client.ts';

test('getForecast asks for the city and returns the forecast', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ city: 'Lisbon', temperatureC: 21, summary: 'Sunny' }),
  );
  const client = new WeatherClient({ apiUrl: 'https://api.test', timeoutMs: 1000 });
  const forecast = await client.getForecast('Lisbon');
  assert.equal(forecast.temperatureC, 21);
  assert.equal(fetch.mock.calls[0]?.arguments[0], 'https://api.test/v1/forecast?city=Lisbon');
});
