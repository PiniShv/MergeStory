import { afterEach, describe, expect, it } from 'vitest';
import type { MergeStoryError } from '../core/errors.ts';
import type { Logger } from '../core/logger.ts';
import { type FetchMock, makeTestContext, mockFetch, pcmTone } from '../testing/narration.ts';
import { createElevenLabsProvider, ELEVENLABS_DEFAULT_VOICE } from './elevenlabs.ts';

const KEY = 'xi-test-key-0123456789abcdef';
const FAST = { attempts: 3, minDelayMs: 1, maxDelayMs: 2 };
const VOICE = 'abcDEF1234567890wxyz';

let mock: FetchMock | null = null;
afterEach(() => {
  mock?.restore();
  mock = null;
});

/** The JSON body of the n-th request sent through the mock. */
const bodyOf = (index: number): { voice_settings?: unknown; language_code?: string } =>
  (mock?.requests[index]?.body ?? {}) as { voice_settings?: unknown; language_code?: string };

const audioResponse = (seconds = 1): Response => new Response(pcmTone(seconds), { status: 200 });

describe('elevenlabs provider', () => {
  it('sends the documented request and returns 24 kHz PCM', async () => {
    const { ctx, cleanup } = await makeTestContext({ secrets: { ELEVENLABS_API_KEY: KEY } });
    mock = mockFetch(() => audioResponse(2));
    const provider = createElevenLabsProvider({ retry: FAST });
    const result = await provider.synthesize(
      { text: 'Hello from the weather client.', voice: VOICE, language: 'en', speed: 1 },
      ctx,
    );
    const request = mock.requests[0];
    expect(request?.url).toBe(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}?output_format=pcm_24000`);
    expect(request?.method).toBe('POST');
    expect(request?.headers['xi-api-key']).toBe(KEY);
    expect(request?.headers['content-type']).toBe('application/json');
    expect(request?.body).toEqual({ text: 'Hello from the weather client.', model_id: 'eleven_flash_v2_5' });
    expect(request?.url).not.toContain(KEY);
    expect(JSON.stringify(request?.body)).not.toContain(KEY);
    expect(result.format).toBe('pcm_s16le');
    expect(result.sampleRate).toBe(24_000);
    expect(result.channels).toBe(1);
    expect(result.audio.length).toBe(2 * 24_000 * 2);
    await cleanup();
  });

  it('uses the default voice and reports it, unless a voice is configured', async () => {
    const { ctx, cleanup } = await makeTestContext({ secrets: { ELEVENLABS_API_KEY: KEY } });
    mock = mockFetch(() => audioResponse());
    const provider = createElevenLabsProvider({ retry: FAST });
    expect(await provider.voice(ctx)).toBe(ELEVENLABS_DEFAULT_VOICE);
    await provider.synthesize({ text: 'Hi.', voice: null, language: 'en', speed: 1 }, ctx);
    expect(mock.requests[0]?.url).toContain(`/${ELEVENLABS_DEFAULT_VOICE}?`);
    const configured = await makeTestContext({ config: { tts: { voice: VOICE } } });
    expect(await provider.voice(configured.ctx)).toBe(VOICE);
    await Promise.all([cleanup(), configured.cleanup()]);
  });

  it('plans that the narration text goes to ElevenLabs', async () => {
    const { ctx, cleanup } = await makeTestContext();
    expect(await createElevenLabsProvider().plannedEgress(ctx, 1000)).toEqual([
      {
        destination: 'api.elevenlabs.io',
        purpose: 'speech synthesis',
        bytes: 1000,
        contains: ['narration-text'],
      },
    ]);
    await cleanup();
  });

  it('names the configured model, else its own default', async () => {
    const plain = await makeTestContext();
    const configured = await makeTestContext({ config: { tts: { model: 'eleven_v4' } } });
    const provider = createElevenLabsProvider();
    expect(provider.model(plain.ctx)).toBe('eleven_flash_v2_5');
    expect(provider.model(configured.ctx)).toBe('eleven_v4');
    await Promise.all([plain.cleanup(), configured.cleanup()]);
  });

  it('passes a speed setting only to models that have one, within the range the API accepts', async () => {
    const flash = await makeTestContext({ secrets: { ELEVENLABS_API_KEY: KEY } });
    mock = mockFetch(() => audioResponse());
    const provider = createElevenLabsProvider({ retry: FAST });
    await provider.synthesize({ text: 'Fast.', voice: VOICE, language: 'en', speed: 1.5 }, flash.ctx);
    expect(bodyOf(0).voice_settings).toEqual({ speed: 1.2 });
    await provider.synthesize({ text: 'Slow.', voice: VOICE, language: 'en', speed: 0.5 }, flash.ctx);
    expect(bodyOf(1).voice_settings).toEqual({ speed: 0.7 });
    mock.restore();

    const v4 = await makeTestContext({
      secrets: { ELEVENLABS_API_KEY: KEY },
      config: { tts: { model: 'eleven_v4' } },
    });
    mock = mockFetch(() => audioResponse());
    await provider.synthesize({ text: 'Fast.', voice: VOICE, language: 'en', speed: 1.5 }, v4.ctx);
    expect(mock.requests[0]?.body).toEqual({ text: 'Fast.', model_id: 'eleven_v4' });
    await Promise.all([flash.cleanup(), v4.cleanup()]);
  });

  it('says once that a model without a speed setting ignores tts.speed', async () => {
    const warnings: string[] = [];
    const logger: Logger = {
      level: 'debug',
      debug: () => {},
      info: () => {},
      warn: (message) => warnings.push(message),
      error: () => {},
      child: () => logger,
    };
    const { ctx, cleanup } = await makeTestContext({
      secrets: { ELEVENLABS_API_KEY: KEY },
      config: { tts: { model: 'eleven_v3' } },
      logger,
    });
    mock = mockFetch(() => audioResponse());
    const provider = createElevenLabsProvider({ retry: FAST });
    await provider.synthesize({ text: 'One.', voice: VOICE, language: 'en', speed: 1.4 }, ctx);
    await provider.synthesize({ text: 'Two.', voice: VOICE, language: 'en', speed: 1.4 }, ctx);
    expect(warnings).toEqual([
      'The ElevenLabs model eleven_v3 has no speed setting, so tts.speed is ignored.',
    ]);
    await cleanup();
  });

  it('sends a language code for other languages, except to the multilingual v2 model', async () => {
    const flash = await makeTestContext({ secrets: { ELEVENLABS_API_KEY: KEY } });
    const multi = await makeTestContext({
      secrets: { ELEVENLABS_API_KEY: KEY },
      config: { tts: { model: 'eleven_multilingual_v2' } },
    });
    mock = mockFetch(() => audioResponse());
    const provider = createElevenLabsProvider({ retry: FAST });
    await provider.synthesize({ text: 'Hallo.', voice: VOICE, language: 'de-DE', speed: 1 }, flash.ctx);
    await provider.synthesize({ text: 'Hallo.', voice: VOICE, language: 'de', speed: 1 }, multi.ctx);
    expect(bodyOf(0).language_code).toBe('de');
    expect(bodyOf(1).language_code).toBeUndefined();
    await Promise.all([flash.cleanup(), multi.cleanup()]);
  });

  it('only accepts plain voice IDs, because the ID becomes part of the URL', async () => {
    const { ctx, cleanup } = await makeTestContext({ secrets: { ELEVENLABS_API_KEY: KEY } });
    mock = mockFetch(() => audioResponse());
    const provider = createElevenLabsProvider({ retry: FAST });
    for (const voice of ['../../v1/user', 'abc/def', 'voice?x=1', 'short', 'has space in it']) {
      const error = (await provider
        .synthesize({ text: 'Hi.', voice, language: 'en', speed: 1 }, ctx)
        .catch((e: unknown) => e)) as MergeStoryError;
      expect(error.code).toBe('CONFIG_INVALID');
    }
    expect(mock.requests).toHaveLength(0);
    await cleanup();
  });

  it('is available only with a key, and fails clearly without one', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const provider = createElevenLabsProvider();
    const problem = await provider.unavailable(ctx);
    expect(problem).toMatchObject({ code: 'CONFIG_INVALID', message: 'ELEVENLABS_API_KEY is not set.' });
    expect(problem?.hint).toContain('ELEVENLABS_API_KEY');
    mock = mockFetch(() => audioResponse());
    const error = (await provider
      .synthesize({ text: 'Hi.', voice: VOICE, language: 'en', speed: 1 }, ctx)
      .catch((e: unknown) => e)) as MergeStoryError;
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.hint).toContain('ELEVENLABS_API_KEY');
    expect(mock.requests).toHaveLength(0);
    const withKey = await makeTestContext({ secrets: { ELEVENLABS_API_KEY: KEY } });
    expect(await provider.unavailable(withKey.ctx)).toBeNull();
    await Promise.all([cleanup(), withKey.cleanup()]);
  });

  it('checks the budget before sending anything', async () => {
    const { ctx, cleanup } = await makeTestContext({
      secrets: { ELEVENLABS_API_KEY: KEY },
      config: { budgetUsd: 0.01 },
    });
    mock = mockFetch(() => audioResponse());
    const provider = createElevenLabsProvider({ retry: FAST });
    const error = (await provider
      .synthesize({ text: 'word '.repeat(100), voice: VOICE, language: 'en', speed: 1 }, ctx)
      .catch((e: unknown) => e)) as MergeStoryError;
    expect(error.code).toBe('BUDGET_EXCEEDED');
    expect(mock.requests).toHaveLength(0);
    expect(ctx.egress.list()).toEqual([]);
    await cleanup();
  });

  it('records the cost of each call and what text left the machine', async () => {
    const { ctx, cleanup } = await makeTestContext({ secrets: { ELEVENLABS_API_KEY: KEY } });
    mock = mockFetch(() => audioResponse());
    const provider = createElevenLabsProvider({ retry: FAST });
    const text = 'Retries now back off exponentially.';
    await provider.synthesize({ text, voice: VOICE, language: 'en', speed: 1 }, ctx);
    const [record] = ctx.cost.report().records;
    expect(record).toMatchObject({
      provider: 'elevenlabs',
      kind: 'tts',
      model: 'eleven_flash_v2_5',
      characters: text.length,
      estimated: true,
    });
    expect(record?.costUsd).toBeCloseTo((text.length * 40) / 1_000_000, 10);
    expect(ctx.egress.list()).toEqual([
      {
        destination: 'api.elevenlabs.io',
        purpose: 'speech synthesis',
        bytes: Buffer.byteLength(text),
        contains: ['narration-text'],
      },
    ]);
    await cleanup();
  });

  it('estimates cost from the model price', async () => {
    const flash = await makeTestContext();
    const v4 = await makeTestContext({ config: { tts: { model: 'eleven_v4' } } });
    const provider = createElevenLabsProvider();
    expect(provider.estimateCostUsd(1350, flash.ctx)).toBeCloseTo(0.054, 8);
    expect(provider.estimateCostUsd(1350, v4.ctx)).toBeCloseTo(0.108, 8);
    await Promise.all([flash.cleanup(), v4.cleanup()]);
  });

  it('refuses to spend money in a dry run', async () => {
    const { ctx, cleanup } = await makeTestContext({ secrets: { ELEVENLABS_API_KEY: KEY }, dryRun: true });
    mock = mockFetch(() => audioResponse());
    const provider = createElevenLabsProvider({ retry: FAST });
    await expect(
      provider.synthesize({ text: 'Hi.', voice: VOICE, language: 'en', speed: 1 }, ctx),
    ).rejects.toThrow(/dry run/);
    expect(mock.requests).toHaveLength(0);
    await cleanup();
  });

  it('retries when the concurrency limit is hit (429) and then succeeds', async () => {
    const { ctx, cleanup } = await makeTestContext({ secrets: { ELEVENLABS_API_KEY: KEY } });
    mock = mockFetch((_request, attempt) =>
      attempt === 1
        ? new Response('{"detail":{"status":"too_many_concurrent_requests","message":"Too many requests"}}', {
            status: 429,
            headers: { 'retry-after': '0' },
          })
        : audioResponse(),
    );
    const provider = createElevenLabsProvider({ retry: FAST });
    await provider.synthesize({ text: 'Hi there.', voice: VOICE, language: 'en', speed: 1 }, ctx);
    expect(mock.requests).toHaveLength(2);
    expect(ctx.cost.report().records).toHaveLength(1);
    await cleanup();
  });

  it.each([
    [
      401,
      '{"detail":{"status":"invalid_api_key","message":"Invalid API key"}}',
      /rejected the API key/,
      /ELEVENLABS_API_KEY/,
    ],
    [
      404,
      '{"detail":{"status":"voice_not_found","message":"A voice with this id does not exist"}}',
      /could not find/,
      /tts\.voice/,
    ],
    [422, '{"detail":[{"msg":"bad"}]}', /rejected the speech request/, /tts\.model/],
    [500, 'oops', /speech request failed \(HTTP 500\)/, /another speech provider/],
  ])('maps HTTP %i to a short error with a next step', async (status, body, message, hint) => {
    const { ctx, cleanup } = await makeTestContext({ secrets: { ELEVENLABS_API_KEY: KEY } });
    mock = mockFetch(() => new Response(body, { status }));
    const provider = createElevenLabsProvider({ retry: { attempts: 1 } });
    const error = (await provider
      .synthesize({ text: 'Hi.', voice: VOICE, language: 'en', speed: 1 }, ctx)
      .catch((e: unknown) => e)) as MergeStoryError;
    expect(error.code).toBe('TTS_FAILED');
    expect(error.message).toMatch(message);
    expect(error.hint).toMatch(hint);
    expect(JSON.stringify(error.toJSON())).not.toContain(KEY);
    await cleanup();
  });
});
