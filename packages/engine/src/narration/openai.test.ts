import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MergeStoryError } from '../core/errors.ts';
import type { Logger } from '../core/logger.ts';
import { type FetchMock, makeTestContext, mockFetch, pcmTone } from '../testing/narration.ts';
import { createOpenAiProvider, OPENAI_SPEECH_URL } from './openai.ts';

const KEY = 'sk-test-0123456789abcdefghijklmnop';
const FAST = { attempts: 3, minDelayMs: 1, maxDelayMs: 2 };

let mock: FetchMock | null = null;
afterEach(() => {
  mock?.restore();
  mock = null;
  vi.useRealTimers();
});

const audioResponse = (seconds = 1): Response => new Response(pcmTone(seconds), { status: 200 });

describe('openai provider', () => {
  it('sends the documented request and returns 24 kHz PCM', async () => {
    const { ctx, cleanup } = await makeTestContext({ secrets: { OPENAI_API_KEY: KEY } });
    mock = mockFetch(() => audioResponse(2));
    const provider = createOpenAiProvider({ retry: FAST });
    const result = await provider.synthesize(
      { text: 'Hello from the weather client.', voice: 'marin', language: 'en', speed: 1 },
      ctx,
    );
    expect(mock.requests).toHaveLength(1);
    const request = mock.requests[0];
    expect(request?.url).toBe(OPENAI_SPEECH_URL);
    expect(request?.url).not.toContain('?');
    expect(request?.method).toBe('POST');
    expect(request?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(request?.headers['content-type']).toBe('application/json');
    expect(request?.body).toEqual({
      model: 'gpt-4o-mini-tts',
      voice: 'marin',
      input: 'Hello from the weather client.',
      response_format: 'pcm',
      instructions: 'Calm, clear, friendly technical narrator. Natural pace.',
    });
    expect(JSON.stringify(request?.body)).not.toContain(KEY);
    expect(result.format).toBe('pcm_s16le');
    expect(result.sampleRate).toBe(24_000);
    expect(result.channels).toBe(1);
    expect(result.characters).toBe('Hello from the weather client.'.length);
    expect(result.audio.length).toBe(2 * 24_000 * 2);
    await cleanup();
  });

  it('sends speed only when it is not 1, and uses a configured model without instructions for tts-1', async () => {
    const { ctx, cleanup } = await makeTestContext({
      secrets: { OPENAI_API_KEY: KEY },
      config: { tts: { model: 'tts-1' } },
    });
    mock = mockFetch(() => audioResponse());
    const provider = createOpenAiProvider({ retry: FAST });
    await provider.synthesize({ text: 'Fast.', voice: 'alloy', language: 'en', speed: 1.25 }, ctx);
    expect(mock.requests[0]?.body).toEqual({
      model: 'tts-1',
      voice: 'alloy',
      input: 'Fast.',
      response_format: 'pcm',
      speed: 1.25,
    });
    await cleanup();
  });

  it('picks the default voice from the model, and a configured voice wins', async () => {
    const mini = await makeTestContext();
    const classic = await makeTestContext({ config: { tts: { model: 'tts-1-hd' } } });
    const provider = createOpenAiProvider();
    expect(await provider.voice(mini.ctx)).toBe('marin');
    expect(await provider.voice(classic.ctx)).toBe('alloy');
    const custom = await makeTestContext({ config: { tts: { voice: 'cedar' } } });
    expect(await provider.voice(custom.ctx)).toBe('cedar');
    await Promise.all([mini.cleanup(), classic.cleanup(), custom.cleanup()]);
  });

  it('plans that the narration text goes to OpenAI', async () => {
    const { ctx, cleanup } = await makeTestContext();
    expect(await createOpenAiProvider().plannedEgress(ctx, 1000)).toEqual([
      {
        destination: 'api.openai.com',
        purpose: 'speech synthesis',
        bytes: 1000,
        contains: ['narration-text'],
      },
    ]);
    await cleanup();
  });

  it('names the configured model, else its own default', async () => {
    const plain = await makeTestContext();
    const configured = await makeTestContext({ config: { tts: { model: 'tts-1-hd' } } });
    const provider = createOpenAiProvider();
    expect(provider.model(plain.ctx)).toBe('gpt-4o-mini-tts');
    expect(provider.model(configured.ctx)).toBe('tts-1-hd');
    await Promise.all([plain.cleanup(), configured.cleanup()]);
  });

  it('is available only with a key, and fails clearly without one', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const provider = createOpenAiProvider();
    const problem = await provider.unavailable(ctx);
    expect(problem).toMatchObject({ code: 'CONFIG_INVALID', message: 'OPENAI_API_KEY is not set.' });
    expect(problem?.hint).toContain('OPENAI_API_KEY');
    mock = mockFetch(() => audioResponse());
    const error = await provider
      .synthesize({ text: 'Hi.', voice: 'marin', language: 'en', speed: 1 }, ctx)
      .catch((e: unknown) => e);
    expect((error as MergeStoryError).code).toBe('CONFIG_INVALID');
    expect((error as MergeStoryError).hint).toContain('OPENAI_API_KEY');
    expect(mock.requests).toHaveLength(0);
    const withKey = await makeTestContext({ secrets: { OPENAI_API_KEY: KEY } });
    expect(await provider.unavailable(withKey.ctx)).toBeNull();
    await Promise.all([cleanup(), withKey.cleanup()]);
  });

  it('checks the budget before sending anything', async () => {
    const { ctx, cleanup } = await makeTestContext({
      secrets: { OPENAI_API_KEY: KEY },
      config: { budgetUsd: 0.01 },
    });
    mock = mockFetch(() => audioResponse());
    const provider = createOpenAiProvider({ retry: FAST });
    const error = await provider
      .synthesize({ text: 'word '.repeat(300), voice: 'marin', language: 'en', speed: 1 }, ctx)
      .catch((e: unknown) => e);
    expect((error as MergeStoryError).code).toBe('BUDGET_EXCEEDED');
    expect(mock.requests).toHaveLength(0);
    expect(ctx.egress.list()).toEqual([]);
    expect(ctx.cost.report().records).toEqual([]);
    await cleanup();
  });

  it('records the cost of each call and what text left the machine', async () => {
    const { ctx, cleanup } = await makeTestContext({ secrets: { OPENAI_API_KEY: KEY } });
    mock = mockFetch(() => audioResponse());
    const provider = createOpenAiProvider({ retry: FAST });
    const text = 'Retries now back off exponentially.';
    await provider.synthesize({ text, voice: 'marin', language: 'en', speed: 1 }, ctx);
    const [record] = ctx.cost.report().records;
    expect(record).toMatchObject({
      provider: 'openai',
      kind: 'tts',
      model: 'gpt-4o-mini-tts',
      characters: text.length,
      estimated: true,
    });
    expect(record?.costUsd).toBeCloseTo((text.length * 18) / 1_000_000, 10);
    expect(ctx.egress.list()).toEqual([
      {
        destination: 'api.openai.com',
        purpose: 'speech synthesis',
        bytes: Buffer.byteLength(text),
        contains: ['narration-text'],
      },
    ]);
    await cleanup();
  });

  it('estimates cost from the model price, honouring config overrides', async () => {
    const plain = await makeTestContext();
    const priced = await makeTestContext({
      config: { tts: { model: 'tts-1' }, pricing: { 'openai:tts-1': { kind: 'tts', perMChars: 1000 } } },
    });
    const provider = createOpenAiProvider();
    expect(provider.estimateCostUsd(1000, plain.ctx)).toBeCloseTo(0.018, 8);
    expect(provider.estimateCostUsd(1000, priced.ctx)).toBeCloseTo(1, 8);
    await Promise.all([plain.cleanup(), priced.cleanup()]);
  });

  it('splits very long text into several requests and joins the audio', async () => {
    const { ctx, cleanup } = await makeTestContext({ secrets: { OPENAI_API_KEY: KEY } });
    mock = mockFetch(() => audioResponse(1));
    const provider = createOpenAiProvider({ retry: FAST });
    const sentence = 'This sentence is a little long, but it still reads naturally. ';
    const text = sentence.repeat(60).trim();
    const result = await provider.synthesize({ text, voice: 'marin', language: 'en', speed: 1 }, ctx);
    expect(mock.requests.length).toBeGreaterThan(1);
    for (const request of mock.requests) {
      expect((request.body as { input: string }).input.length).toBeLessThanOrEqual(1500);
    }
    expect(result.audio.length).toBeGreaterThan(24_000 * 2);
    expect(ctx.cost.report().records).toHaveLength(mock.requests.length);
    const sent = mock.requests.map((r) => (r.body as { input: string }).input).join(' ');
    expect(sent).toBe(text);
    await cleanup();
  });

  it('refuses to spend money in a dry run', async () => {
    const { ctx, cleanup } = await makeTestContext({ secrets: { OPENAI_API_KEY: KEY }, dryRun: true });
    mock = mockFetch(() => audioResponse());
    const provider = createOpenAiProvider({ retry: FAST });
    await expect(
      provider.synthesize({ text: 'Hi.', voice: 'marin', language: 'en', speed: 1 }, ctx),
    ).rejects.toThrow(/dry run/);
    expect(mock.requests).toHaveLength(0);
    await cleanup();
  });

  it('retries a server error and records the cost once', async () => {
    const { ctx, cleanup } = await makeTestContext({ secrets: { OPENAI_API_KEY: KEY } });
    mock = mockFetch((_request, attempt) =>
      attempt === 1 ? new Response('{"error":{"message":"server busy"}}', { status: 503 }) : audioResponse(),
    );
    const provider = createOpenAiProvider({ retry: FAST });
    await provider.synthesize({ text: 'Hi there.', voice: 'marin', language: 'en', speed: 1 }, ctx);
    expect(mock.requests).toHaveLength(2);
    expect(ctx.cost.report().records).toHaveLength(1);
    await cleanup();
  });

  it.each([
    [401, '{"error":{"message":"Incorrect API key provided"}}', /rejected the API key/, /OPENAI_API_KEY/],
    [
      429,
      '{"error":{"message":"You exceeded your current quota"}}',
      /rate limiting|out of credit/,
      /billing/,
    ],
    [404, '{"error":{"message":"The model does not exist"}}', /could not find/, /tts\.model/],
    [400, '{"error":{"message":"Invalid voice"}}', /rejected the speech request/, /tts\.voice/],
  ])('maps HTTP %i to a short error with a next step', async (status, body, message, hint) => {
    const { ctx, cleanup } = await makeTestContext({ secrets: { OPENAI_API_KEY: KEY } });
    mock = mockFetch(() => new Response(body, { status }));
    const provider = createOpenAiProvider({ retry: { attempts: 1 } });
    const error = (await provider
      .synthesize({ text: 'Hi.', voice: 'marin', language: 'en', speed: 1 }, ctx)
      .catch((e: unknown) => e)) as MergeStoryError;
    expect(error.code).toBe('TTS_FAILED');
    expect(error.message).toMatch(message);
    expect(error.hint).toMatch(hint);
    expect(error.message).not.toContain(KEY);
    expect(JSON.stringify(error.toJSON())).not.toContain(KEY);
    await cleanup();
  });

  it('warns once, from December 2026, that OpenAI is retiring these models', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-12-15T12:00:00Z'));
    const { createOpenAiProvider: freshProvider } = await import('./openai.ts');
    const warnings: string[] = [];
    const logger: Logger = {
      level: 'debug',
      debug: () => {},
      info: () => {},
      warn: (message) => warnings.push(message),
      error: () => {},
      child: () => logger,
    };
    const { ctx, cleanup } = await makeTestContext({ secrets: { OPENAI_API_KEY: KEY }, logger });
    mock = mockFetch(() => audioResponse());
    const provider = freshProvider({ retry: FAST });
    await provider.synthesize({ text: 'One.', voice: 'marin', language: 'en', speed: 1 }, ctx);
    await provider.synthesize({ text: 'Two.', voice: 'marin', language: 'en', speed: 1 }, ctx);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('2027-01-06');
    await cleanup();
  });

  it('does not warn before December 2026', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-03T12:00:00Z'));
    const { createOpenAiProvider: freshProvider } = await import('./openai.ts');
    const warnings: string[] = [];
    const logger: Logger = {
      level: 'debug',
      debug: () => {},
      info: () => {},
      warn: (message) => warnings.push(message),
      error: () => {},
      child: () => logger,
    };
    const { ctx, cleanup } = await makeTestContext({ secrets: { OPENAI_API_KEY: KEY }, logger });
    mock = mockFetch(() => audioResponse());
    await freshProvider({ retry: FAST }).synthesize(
      { text: 'One.', voice: 'marin', language: 'en', speed: 1 },
      ctx,
    );
    expect(warnings).toEqual([]);
    await cleanup();
  });
});
