import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WeatherClient, WeatherError } from '../src/client.ts';
import { backoffDelay, withRetry } from '../src/retry.ts';

const config = { apiUrl: 'https://api.test', timeoutMs: 1000, baseDelayMs: 0, maxDelayMs: 0 };
const sunny = { city: 'Lisbon', temperatureC: 21, summary: 'Sunny' };

test('getForecast retries a network error and a 503, then returns the forecast', async (t) => {
  const replies = [
    () => Promise.reject(new TypeError('fetch failed')),
    () => Promise.resolve(new Response(null, { status: 503, headers: { 'retry-after': '0' } })),
    () => Promise.resolve(Response.json(sunny)),
  ];
  const fetch = t.mock.method(globalThis, 'fetch', () => replies.shift()!());
  const forecast = await new WeatherClient(config).getForecast('Lisbon');
  assert.deepEqual(forecast, sunny);
  assert.equal(fetch.mock.callCount(), 3);
});

test('getForecast does not retry a 404', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 404 }));
  await assert.rejects(new WeatherClient(config).getForecast('Atlantis'), (error) => {
    return error instanceof WeatherError && error.status === 404;
  });
  assert.equal(fetch.mock.callCount(), 1);
});

test('backoff never exceeds the cap', () => {
  const options = { retries: 5, baseDelayMs: 100, maxDelayMs: 1000 };
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.ok(backoffDelay(attempt, options) <= 1000);
  }
});

test('withRetry stops after the configured retries', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw new Error('temporary');
      },
      () => ({ retry: true, afterMs: 0 }),
      { retries: 2 },
    ),
  );
  assert.equal(calls, 3);
});
