/** The shared request sequence of the paid speech providers, with a made-up service. */
import { afterEach, describe, expect, it } from 'vitest';
import { MergeStoryError } from '../core/errors.ts';
import type { TtsRequest } from '../core/providers.ts';
import { type FetchMock, makeTestContext, mockFetch, pcmTone } from '../testing/narration.ts';
import { createRemoteSpeechProvider, type RemoteSpeechSpec } from './remote-speech.ts';

const KEY = 'acme-key-0123456789abcdef';
const FAST = { attempts: 1, minDelayMs: 1, maxDelayMs: 2 };

let mock: FetchMock | null = null;
afterEach(() => {
  mock?.restore();
  mock = null;
});

const audio = (seconds = 1): Response => new Response(pcmTone(seconds), { status: 200 });
const request = (text: string, voice: string | null = 'bella'): TtsRequest => ({
  text,
  voice,
  language: 'en',
  speed: 1,
});

/** A service that calls itself Acme, sends the piece in a query-less body, and does not like voice names with digits. */
function acme(overrides: Partial<RemoteSpeechSpec> = {}) {
  const events: string[] = [];
  const spec: RemoteSpeechSpec = {
    id: 'openai',
    service: 'Acme',
    host: 'speech.acme.test',
    keyName: 'OPENAI_API_KEY',
    defaultModel: 'acme-1',
    defaultVoice: (model) => (model === 'acme-1' ? 'ada' : 'bob'),
    voiceProblem: (voice) => {
      events.push('voice');
      return /\d/.test(voice) ? new MergeStoryError('CONFIG_INVALID', 'No digits in voices.') : null;
    },
    maxChars: 40,
    notices: ({ model, request: asked }) => events.push(`notice ${model} ${asked.speed}`),
    call: ({ key, model, voice, piece, request: asked }) => {
      events.push(`call ${piece}`);
      return {
        url: `https://speech.acme.test/say/${voice}`,
        headers: { 'x-acme-key': key },
        body: { model, text: piece, speed: asked.speed },
      };
    },
    ...overrides,
  };
  return { spec, events };
}

describe('createRemoteSpeechProvider', () => {
  it('describes the provider from its spec: id, host, model, voice and key rule', async () => {
    const plain = await makeTestContext({ secrets: { OPENAI_API_KEY: KEY } });
    const configured = await makeTestContext({ config: { tts: { model: 'acme-2', voice: 'cy' } } });
    const provider = createRemoteSpeechProvider(acme().spec);
    expect(provider).toMatchObject({ id: 'openai', local: false });
    expect(await provider.plannedEgress(plain.ctx, 1234)).toEqual([
      {
        destination: 'speech.acme.test',
        purpose: 'speech synthesis',
        bytes: 1234,
        contains: ['narration-text'],
      },
    ]);
    expect(provider.model(plain.ctx)).toBe('acme-1');
    expect(await provider.voice(plain.ctx)).toBe('ada');
    expect(provider.model(configured.ctx)).toBe('acme-2');
    expect(await provider.voice(configured.ctx)).toBe('cy');
    expect(await provider.unavailable(plain.ctx)).toBeNull();
    const problem = await provider.unavailable(configured.ctx);
    expect(problem).toMatchObject({ code: 'CONFIG_INVALID', message: 'OPENAI_API_KEY is not set.' });
    expect(problem?.hint).toBe(
      'Set OPENAI_API_KEY in the environment (never in a config file), or use a free voice with --tts kokoro.',
    );
    await Promise.all([plain.cleanup(), configured.cleanup()]);
  });

  it('sends one request for each piece of the text, as the spec builds it', async () => {
    const { ctx, cleanup } = await makeTestContext({ secrets: { OPENAI_API_KEY: KEY } });
    mock = mockFetch(() => audio());
    const { spec } = acme();
    const text = 'First sentence is here. Second sentence is here.';
    const result = await createRemoteSpeechProvider(spec, { retry: FAST }).synthesize(request(text), ctx);
    expect(mock.requests).toHaveLength(2);
    expect(mock.requests.map((r) => [r.url, r.method, r.headers['x-acme-key']])).toEqual([
      ['https://speech.acme.test/say/bella', 'POST', KEY],
      ['https://speech.acme.test/say/bella', 'POST', KEY],
    ]);
    const sent = mock.requests.map((r) => (r.body as { text: string }).text);
    expect(sent).toEqual(['First sentence is here.', 'Second sentence is here.']);
    expect(mock.requests[0]?.body).toMatchObject({ model: 'acme-1', speed: 1 });
    // The spaces between the pieces are not spoken, so they are not counted.
    expect(result).toMatchObject({ format: 'pcm_s16le', sampleRate: 24_000, channels: 1, characters: 47 });
    // Both pieces, joined with a short pause.
    expect(result.audio.length).toBeGreaterThanOrEqual(2 * 24_000 * 2);
    await cleanup();
  });

  it('stops reading an answer that is too large, with TTS_FAILED', async () => {
    const { ctx, cleanup } = await makeTestContext({ secrets: { OPENAI_API_KEY: KEY } });
    let sent = 0;
    const huge = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        if (sent > 100) controller.close();
        controller.enqueue(new Uint8Array(1_048_576));
      },
    });
    mock = mockFetch(() => new Response(huge, { status: 200 }));
    const error = await createRemoteSpeechProvider(acme().spec, { retry: FAST })
      .synthesize(request('Hello.'), ctx)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'TTS_FAILED',
      message: 'speech.acme.test sent an answer larger than 64 MB.',
    });
    expect(sent).toBeLessThan(70);
    // The service answered, so the request may still be billed.
    expect(ctx.cost.report().records).toHaveLength(1);
    await cleanup();
  });

  it('counts a request that timed out, also when it is tried again, because the service may still bill it', async () => {
    const { ctx, events, cleanup } = await makeTestContext({ secrets: { OPENAI_API_KEY: KEY } });
    const stalled = (): Promise<Response> =>
      new Promise((_, reject) => setTimeout(() => reject(new Error('stalled')), 60));
    // The first try times out and the second one answers: both may be billed.
    let calls = 0;
    mock = mockFetch(() => (++calls === 1 ? stalled() : audio()));
    const retried = createRemoteSpeechProvider(acme().spec, {
      retry: { attempts: 2, minDelayMs: 1, maxDelayMs: 2 },
      timeoutMs: 10,
    });
    await retried.synthesize(request('Hello.'), ctx);
    expect(ctx.cost.report().records).toMatchObject([
      { kind: 'tts', characters: 6, estimated: true },
      { kind: 'tts', characters: 6, estimated: true },
    ]);
    mock.restore();
    // The only try times out: it is counted once, and the line fails.
    mock = mockFetch(() => stalled());
    const once = createRemoteSpeechProvider(acme().spec, { retry: FAST, timeoutMs: 10 });
    await expect(once.synthesize(request('Hello.'), ctx)).rejects.toMatchObject({ code: 'TTS_FAILED' });
    expect(ctx.cost.report().records).toHaveLength(3);
    mock.restore();
    // A timed-out try followed by a refused one (HTTP 500): only the timed-out try may be billed.
    calls = 0;
    mock = mockFetch(() => (++calls === 1 ? stalled() : new Response('{}', { status: 500 })));
    await expect(retried.synthesize(request('Hello.'), ctx)).rejects.toMatchObject({ code: 'TTS_FAILED' });
    expect(ctx.cost.report().records).toHaveLength(4);
    // The warning is said once per run.
    expect(
      events.filter((event) => event.message.includes('timed out or its audio could not be read')),
    ).toHaveLength(1);
    await cleanup();
  });

  it('counts nothing for a request the user cancels', async () => {
    const { ctx, cleanup } = await makeTestContext({ secrets: { OPENAI_API_KEY: KEY } });
    const controller = new AbortController();
    const cancelled = { ...ctx, signal: controller.signal };
    mock = mockFetch(() => {
      setTimeout(() => controller.abort(), 5);
      return new Promise((_, reject) => setTimeout(() => reject(new Error('cancelled')), 30));
    });
    const provider = createRemoteSpeechProvider(acme().spec, { retry: FAST, timeoutMs: 1_000 });
    await expect(provider.synthesize(request('Hello.'), cancelled)).rejects.toBeInstanceOf(Error);
    expect(ctx.cost.report().records).toEqual([]);
    await cleanup();
  });

  it('records the cost and the egress of every request with the id and the host of the spec', async () => {
    const { ctx, cleanup } = await makeTestContext({ secrets: { OPENAI_API_KEY: KEY } });
    mock = mockFetch(() => audio());
    await createRemoteSpeechProvider(acme().spec, { retry: FAST }).synthesize(
      request('First sentence is here. Second sentence is here.'),
      ctx,
    );
    const records = ctx.cost.report().records;
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      provider: 'openai',
      kind: 'tts',
      model: 'acme-1',
      estimated: true,
      // The model has no listed price, so the fallback rate was used.
      priceNote: 'assumed',
    });
    // Transfers to the same host for the same purpose are added up.
    expect(ctx.egress.list()).toEqual([
      {
        destination: 'speech.acme.test',
        purpose: 'speech synthesis',
        bytes: 47,
        contains: ['narration-text'],
      },
    ]);
    await cleanup();
  });

  it('records every answered request, also when the line fails after it', async () => {
    const { ctx, cleanup } = await makeTestContext({ secrets: { OPENAI_API_KEY: KEY } });
    const provider = createRemoteSpeechProvider(acme().spec, { retry: FAST });
    const twoPieces = request('First sentence is here. Second sentence is here.');
    // The second answer arrives but holds no audio: the service bills it all the same.
    let calls = 0;
    mock = mockFetch(() => (++calls === 1 ? audio() : new Response(Buffer.alloc(1), { status: 200 })));
    await expect(provider.synthesize(twoPieces, ctx)).rejects.toMatchObject({ code: 'TTS_FAILED' });
    expect(ctx.cost.report().records).toHaveLength(2);
    mock.restore();
    // The second request fails without an answer: only the first one is billed.
    calls = 0;
    mock = mockFetch(() => (++calls === 1 ? audio() : new Response('{}', { status: 500 })));
    await expect(provider.synthesize(twoPieces, ctx)).rejects.toMatchObject({ code: 'TTS_FAILED' });
    expect(ctx.cost.report().records).toHaveLength(3);
    await cleanup();
  });

  it('uses the default voice for the model when the request names none', async () => {
    const { ctx, cleanup } = await makeTestContext({
      secrets: { OPENAI_API_KEY: KEY },
      config: { tts: { model: 'acme-2' } },
    });
    mock = mockFetch(() => audio());
    await createRemoteSpeechProvider(acme().spec, { retry: FAST }).synthesize(request('Hello.', null), ctx);
    expect(mock.requests[0]?.url).toBe('https://speech.acme.test/say/bob');
    await cleanup();
  });

  it('judges the voice, then the budget, then says its notices, and only then sends', async () => {
    const { ctx, cleanup } = await makeTestContext({ secrets: { OPENAI_API_KEY: KEY } });
    mock = mockFetch(() => audio());
    const { spec, events } = acme();
    const provider = createRemoteSpeechProvider(spec, { retry: FAST });
    const bad = await provider.synthesize(request('Hello.', 'bella9'), ctx).catch((e: unknown) => e);
    expect(bad).toMatchObject({ code: 'CONFIG_INVALID', message: 'No digits in voices.' });
    expect(events).toEqual(['voice']);
    expect(mock.requests).toEqual([]);

    events.length = 0;
    await provider.synthesize({ ...request('Hello.'), speed: 1.5 }, ctx);
    expect(events).toEqual(['voice', 'notice acme-1 1.5', 'call Hello.']);

    // A text that costs more than the budget is refused before any notice and any request.
    const poor = await makeTestContext({ secrets: { OPENAI_API_KEY: KEY }, config: { budgetUsd: 0.000001 } });
    events.length = 0;
    const requestsBefore = mock.requests.length;
    const refused = await provider.synthesize(request('Hello there.'), poor.ctx).catch((e: unknown) => e);
    expect((refused as MergeStoryError).code).toBe('BUDGET_EXCEEDED');
    expect((refused as MergeStoryError).message).toContain('Acme speech synthesis');
    expect(events).toEqual(['voice']);
    expect(mock.requests).toHaveLength(requestsBefore);
    await Promise.all([cleanup(), poor.cleanup()]);
  });

  it('stops without a key, in a dry run and without text, before it sends anything', async () => {
    mock = mockFetch(() => audio());
    const provider = createRemoteSpeechProvider(acme().spec, { retry: FAST });
    const withoutKey = await makeTestContext();
    const keyError = await provider.synthesize(request('Hello.'), withoutKey.ctx).catch((e: unknown) => e);
    expect(keyError).toMatchObject({ code: 'CONFIG_INVALID', message: 'OPENAI_API_KEY is not set.' });
    const dry = await makeTestContext({ secrets: { OPENAI_API_KEY: KEY }, dryRun: true });
    await expect(provider.synthesize(request('Hello.'), dry.ctx)).rejects.toThrow(/dry run/);
    const ready = await makeTestContext({ secrets: { OPENAI_API_KEY: KEY } });
    const empty = await provider.synthesize(request('   '), ready.ctx).catch((e: unknown) => e);
    expect(empty).toMatchObject({ code: 'TTS_FAILED', message: 'There is no text to speak.' });
    expect(mock.requests).toEqual([]);
    await Promise.all([withoutKey.cleanup(), dry.cleanup(), ready.cleanup()]);
  });

  it('names its service when the answer has no audio, and maps failures with its key name', async () => {
    const { ctx, cleanup } = await makeTestContext({ secrets: { OPENAI_API_KEY: KEY } });
    const provider = createRemoteSpeechProvider(acme().spec, { retry: FAST });
    mock = mockFetch(() => new Response(Buffer.alloc(1), { status: 200 }));
    const silent = await provider.synthesize(request('Hello.'), ctx).catch((e: unknown) => e);
    expect(silent).toMatchObject({
      code: 'TTS_FAILED',
      message: 'Acme returned no audio for a narration line.',
      hint: 'Run again; finished lines are cached.',
    });
    mock.restore();
    mock = mockFetch(() => new Response('{"error":"bad key"}', { status: 401 }));
    const rejected = (await provider
      .synthesize(request('Hello.'), ctx)
      .catch((e: unknown) => e)) as MergeStoryError;
    expect(rejected.code).toBe('TTS_FAILED');
    expect(rejected.message).toContain('Acme rejected the API key (HTTP 401)');
    expect(rejected.hint).toContain('OPENAI_API_KEY');
    expect(JSON.stringify(rejected.toJSON())).not.toContain(KEY);
    await cleanup();
  });

  it('prices a text with the price book of its id and the model in use', async () => {
    const { ctx, cleanup } = await makeTestContext({
      config: { tts: { model: 'acme-1' }, pricing: { 'openai:acme-1': { kind: 'tts', perMChars: 100 } } },
    });
    expect(createRemoteSpeechProvider(acme().spec).estimateCostUsd(1000, ctx)).toBeCloseTo(0.1, 8);
    await cleanup();
  });
});
