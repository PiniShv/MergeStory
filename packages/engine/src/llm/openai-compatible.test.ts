import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { noCache } from '../core/cache.ts';
import { type Config, type ConfigInput, resolveConfig, Secrets } from '../core/config.ts';
import { createRunContext, type RunContext } from '../core/context.ts';
import { estimateTokens } from '../core/cost.ts';
import { MergeStoryError } from '../core/errors.ts';
import { silentLogger } from '../core/logger.ts';
import type { LlmProvider, LlmRequest } from '../core/providers.ts';
import { testContext } from '../testing/context.ts';
import { createOpenAiFromConfig } from './openai-compatible.ts';

const KEY = 'test-openai-key-0000';
const SCHEMA = {
  type: 'object',
  properties: { a: { type: 'string' } },
  required: ['a'],
  additionalProperties: false,
};

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Setup {
  config: Config;
  ctx: RunContext;
  provider: LlmProvider;
}

function setup(
  flavor: 'openai' | 'openai-compatible',
  llm: NonNullable<ConfigInput['llm']> = {},
  secrets: Record<string, string> = {},
): Setup {
  const { ctx } = testContext({ config: { llm: { provider: flavor, ...llm } }, secrets });
  const { config } = ctx;
  const model = config.llm.model ?? (flavor === 'openai' ? 'gpt-6-luna' : 'local-model');
  return { config, ctx, provider: createOpenAiFromConfig(flavor, config, ctx.secrets, model) };
}

const openai = () => setup('openai', {}, { OPENAI_API_KEY: KEY });
const ollama = () => setup('openai-compatible', { baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' });

function request(partial: Partial<LlmRequest> = {}): LlmRequest {
  return {
    system: 'You write storyboards.',
    prompt: 'Evidence pack goes here.',
    schemaName: 'storyboard',
    jsonSchema: SCHEMA,
    maxOutputTokens: 8000,
    ...partial,
  };
}

function completion(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chatcmpl-1',
    model: 'gpt-6-luna',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: '{"a":"x"}', refusal: null },
      },
    ],
    usage: { prompt_tokens: 900, completion_tokens: 250, prompt_tokens_details: { cached_tokens: 100 } },
    ...overrides,
  };
}

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function sentBody(call = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[call]![1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function sentHeaders(call = 0): Record<string, string> {
  return (fetchMock.mock.calls[call]![1] as RequestInit).headers as Record<string, string>;
}

async function failure(promise: Promise<unknown>): Promise<MergeStoryError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof MergeStoryError) return err;
    throw err;
  }
  throw new Error('expected the call to fail');
}

describe('OpenAI request', () => {
  it('posts a strict json_schema request to Chat Completions and sends no sampling parameters', async () => {
    const { ctx, provider } = openai();
    fetchMock.mockResolvedValue(reply(completion()));

    const response = await provider.generateJson(request(), ctx);

    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.openai.com/v1/chat/completions');
    expect(sentHeaders()).toMatchObject({
      authorization: `Bearer ${KEY}`,
      'content-type': 'application/json',
    });
    const body = sentBody();
    expect(body.model).toBe('gpt-6-luna');
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'storyboard', strict: true, schema: SCHEMA },
    });
    expect(body.max_completion_tokens).toBe(8000);
    expect(body).not.toHaveProperty('max_tokens');
    for (const forbidden of ['temperature', 'top_p', 'top_k']) expect(body).not.toHaveProperty(forbidden);
    expect(body.messages).toEqual([
      { role: 'system', content: 'You write storyboards.' },
      { role: 'user', content: 'Evidence pack goes here.' },
    ]);
    expect(response.json).toEqual({ a: 'x' });
  });

  it('does not store the request and avoids paying for implicit prompt-cache writes', async () => {
    const { ctx, provider } = openai();
    fetchMock.mockResolvedValue(reply(completion()));

    await provider.generateJson(request(), ctx);

    const body = sentBody();
    expect(body.store).toBe(false);
    expect(body.prompt_cache_options).toEqual({ mode: 'explicit' });
    expect(body.reasoning_effort).toBe('medium');
  });

  it('reports usage including cached tokens, and the model the server used', async () => {
    const { ctx, provider } = openai();
    fetchMock.mockResolvedValue(reply(completion({ model: 'gpt-6-luna-2026' })));

    const response = await provider.generateJson(request(), ctx);

    expect(response.usage).toEqual({
      inputTokens: 900,
      outputTokens: 250,
      cacheReadTokens: 100,
      cacheWriteTokens: undefined,
    });
    expect(response.model).toBe('gpt-6-luna-2026');
    expect(response.stopReason).toBe('stop');
  });

  it('appends repair turns after the original prompt', async () => {
    const { ctx, provider } = openai();
    fetchMock.mockResolvedValue(reply(completion()));

    await provider.generateJson(
      request({
        history: [
          { role: 'assistant', content: '{"a":"old"}' },
          { role: 'user', content: 'Fix the errors.' },
        ],
      }),
      ctx,
    );

    const roles = (sentBody().messages as { role: string }[]).map((m) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'user']);
  });
});

describe('OpenAI-compatible servers', () => {
  it('uses max_tokens, needs no key, and leaves out OpenAI-only fields', async () => {
    const { ctx, provider } = ollama();
    fetchMock.mockResolvedValue(reply(completion({ model: 'llama3.1' })));

    await provider.generateJson(request(), ctx);

    expect(fetchMock.mock.calls[0]![0]).toBe('http://localhost:11434/v1/chat/completions');
    expect(sentHeaders()).not.toHaveProperty('authorization');
    const body = sentBody();
    expect(body.max_tokens).toBe(8000);
    for (const field of ['max_completion_tokens', 'store', 'reasoning_effort', 'prompt_cache_options']) {
      expect(body).not.toHaveProperty(field);
    }
    expect((body.response_format as { type: string }).type).toBe('json_schema');
  });

  it('sends the key when one is configured', async () => {
    const { ctx, provider } = setup(
      'openai-compatible',
      { baseUrl: 'https://gateway.example.com/v1', model: 'some/model' },
      { MERGESTORY_LLM_API_KEY: KEY },
    );
    fetchMock.mockResolvedValue(reply(completion()));
    await provider.generateJson(request(), ctx);
    expect(sentHeaders().authorization).toBe(`Bearer ${KEY}`);
  });

  it('retries once with json_object and the schema in the prompt when response_format is rejected', async () => {
    const { ctx, provider } = ollama();
    fetchMock
      .mockResolvedValueOnce(
        reply(
          { error: { message: "This server does not support response_format of type 'json_schema'" } },
          400,
        ),
      )
      .mockResolvedValueOnce(reply(completion()));

    const response = await provider.generateJson(request(), ctx);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retried = sentBody(1);
    expect(retried.response_format).toEqual({ type: 'json_object' });
    const system = (retried.messages as { content: string }[])[0]!.content;
    expect(system).toContain(JSON.stringify(SCHEMA));
    expect(system).toContain('JSON');
    expect(response.json).toEqual({ a: 'x' });
  });

  it('does not loop: a second rejection of the same field becomes an error', async () => {
    const { ctx, provider } = ollama();
    fetchMock.mockImplementation(async () => reply({ error: { message: 'bad response_format' } }, 400));

    const error = await failure(provider.generateJson(request(), ctx));

    expect(error.code).toBe('LLM_FAILED');
    expect(error.message).toContain('HTTP 400');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('switches the output limit field when the server names the one it does not accept', async () => {
    const { ctx, provider } = ollama();
    fetchMock
      .mockResolvedValueOnce(
        reply(
          { error: { message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead." } },
          400,
        ),
      )
      .mockResolvedValueOnce(reply(completion()));

    await provider.generateJson(request(), ctx);

    expect(sentBody(1)).toHaveProperty('max_completion_tokens', 8000);
    expect(sentBody(1)).not.toHaveProperty('max_tokens');
  });

  it('drops reasoning_effort for models that reject it, but never drops store', async () => {
    const { ctx, provider } = openai();
    fetchMock
      .mockResolvedValueOnce(
        reply({ error: { message: 'Unrecognized request argument supplied: reasoning_effort' } }, 400),
      )
      .mockResolvedValueOnce(reply(completion()));
    await provider.generateJson(request(), ctx);
    expect(sentBody(1)).not.toHaveProperty('reasoning_effort');
    expect(sentBody(1)).toHaveProperty('store', false);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(reply({ error: { message: "Unknown parameter: 'store'" } }, 400));
    const error = await failure(provider.generateJson(request(), ctx));
    expect(error.code).toBe('LLM_FAILED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('OpenAI response handling', () => {
  it('maps a refusal to LLM_REFUSED and records the billed cost', async () => {
    const { ctx, provider } = openai();
    fetchMock.mockResolvedValue(
      reply(
        completion({
          choices: [
            { finish_reason: 'stop', message: { content: null, refusal: 'I cannot help with that.' } },
          ],
        }),
      ),
    );

    const error = await failure(provider.generateJson(request(), ctx));

    expect(error.code).toBe('LLM_REFUSED');
    expect(ctx.cost.report().records).toHaveLength(1);
    expect(ctx.cost.report().records[0]).toMatchObject({
      provider: 'openai',
      inputTokens: 900,
      outputTokens: 250,
    });
  });

  it('maps finish_reason length to LLM_FAILED with a hint about the output limit', async () => {
    const { ctx, provider } = openai();
    fetchMock.mockResolvedValue(
      reply(
        completion({ choices: [{ finish_reason: 'length', message: { content: '{"a":', refusal: null } }] }),
      ),
    );
    const error = await failure(provider.generateJson(request(), ctx));
    expect(error.code).toBe('LLM_FAILED');
    expect(error.hint).toContain('llm.maxOutputTokens');
  });

  it('treats an error inside an HTTP 200 answer as a failure', async () => {
    const { ctx, provider } = openai();
    fetchMock.mockResolvedValue(
      reply({ error: { code: 502, message: 'Provider returned an invalid response' } }),
    );
    const error = await failure(provider.generateJson(request(), ctx));
    expect(error.code).toBe('LLM_FAILED');
    expect(error.message).toContain('invalid response');
  });

  it('returns undefined json when the text is not JSON, so the caller can ask for a repair', async () => {
    const { ctx, provider } = openai();
    fetchMock.mockResolvedValue(
      reply(
        completion({
          choices: [{ finish_reason: 'stop', message: { content: 'not json at all', refusal: null } }],
        }),
      ),
    );
    expect((await provider.generateJson(request(), ctx)).json).toBeUndefined();
  });

  it('counts the repair history in the input when the server reports no usage', async () => {
    const { ctx, provider } = ollama();
    fetchMock.mockResolvedValue(reply({ model: 'llama3.1', choices: completion().choices }));
    const history = [
      { role: 'assistant' as const, content: 'a'.repeat(3600) },
      { role: 'user' as const, content: 'Fix it.' },
    ];
    const asked = request({ history });
    const response = await provider.generateJson(asked, ctx);
    expect(response.usage.inputTokens).toBe(
      estimateTokens(asked.system + asked.prompt + history[0]!.content + history[1]!.content),
    );
  });

  it('estimates usage from text length when the server reports none', async () => {
    const { ctx, provider } = ollama();
    fetchMock.mockResolvedValue(reply({ model: 'llama3.1', choices: completion().choices }));
    const response = await provider.generateJson(request(), ctx);
    expect(response.usage.inputTokens).toBeGreaterThan(0);
    expect(response.usage.outputTokens).toBeGreaterThan(0);
  });
});

describe('OpenAI errors', () => {
  it('maps 401 to CONFIG_INVALID naming the key variable', async () => {
    const { ctx, provider } = openai();
    fetchMock.mockResolvedValue(reply({ error: { message: 'Incorrect API key provided' } }, 401));
    const error = await failure(provider.generateJson(request(), ctx));
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.hint).toContain('OPENAI_API_KEY');
  });

  it('does not retry a quota error and explains it', async () => {
    const { ctx, provider } = openai();
    fetchMock.mockResolvedValue(
      reply({ error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } }, 429),
    );
    const error = await failure(provider.generateJson(request(), ctx));
    expect(error.code).toBe('LLM_FAILED');
    expect(error.hint).toContain('billing');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('redacts a key that the server echoes back in an error', async () => {
    const { ctx, provider } = openai();
    fetchMock.mockResolvedValue(reply({ error: { message: `bad token ${KEY}` } }, 403));
    const error = await failure(provider.generateJson(request(), ctx));
    expect(error.message).not.toContain(KEY);
  });

  it('stops reading an answer that is too large, with LLM_FAILED', async () => {
    const { ctx, provider } = ollama();
    let sent = 0;
    const huge = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        if (sent > 100) controller.close();
        controller.enqueue(new TextEncoder().encode(`{"a":"${'x'.repeat(1_048_576)}`));
      },
    });
    fetchMock.mockResolvedValue(new Response(huge, { status: 200 }));
    const error = await failure(provider.generateJson(request(), ctx));
    expect(error.code).toBe('LLM_FAILED');
    expect(error.message).toBe('localhost:11434 sent an answer larger than 32 MB.');
    // The server answered, so it may bill the call.
    expect(error.details).toEqual({ mayBeBilled: true });
    expect(sent).toBeLessThan(40);
  });

  it('marks an answer with nothing in it as possibly billed, and an error inside the answer as not billed', async () => {
    const { ctx, provider } = ollama();
    fetchMock.mockResolvedValueOnce(reply({}));
    expect((await failure(provider.generateJson(request(), ctx))).details).toEqual({ mayBeBilled: true });
    fetchMock.mockResolvedValueOnce(reply({ error: { message: 'model not found' } }));
    const error = await failure(provider.generateJson(request(), ctx));
    expect(error.message).toContain('model not found');
    expect(error.details).toBeUndefined();
  });

  it('keeps ABORTED, with no billing doubt, when the run is cancelled while the answer is read', async () => {
    const { ctx, provider } = ollama();
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      pull() {
        controller.abort();
        throw new Error('aborted');
      },
    });
    fetchMock.mockResolvedValue(new Response(body, { status: 200 }));
    const error = await failure(provider.generateJson(request(), { ...ctx, signal: controller.signal }));
    expect(error.code).toBe('ABORTED');
    expect(error.details).toBeUndefined();
  });

  it('reports an unreachable server with a hint, not a stack trace', async () => {
    vi.useFakeTimers();
    try {
      const { ctx, provider } = ollama();
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      const pending = failure(provider.generateJson(request(), ctx));
      await vi.runAllTimersAsync();
      const error = await pending;
      expect(error.code).toBe('LLM_FAILED');
      expect(error.message).toContain('localhost:11434');
      expect(error.message).not.toContain('did not answer');
      // The request never reached a server, so nothing can be billed.
      expect(error.details).toBeUndefined();
      expect(error.hint).toContain('llm.baseUrl');
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says that the model did not answer in time, and that another try may work, when the request times out', async () => {
    vi.useFakeTimers();
    // A request whose time limit has already run out, so the test does not wait for it.
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation(() =>
        AbortSignal.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
      );
    try {
      const { ctx, provider } = ollama();
      fetchMock.mockImplementation((_url: string, init: RequestInit) => Promise.reject(init.signal?.reason));
      const pending = failure(provider.generateJson(request(), ctx));
      await vi.runAllTimersAsync();
      const error = await pending;
      expect(error.code).toBe('LLM_FAILED');
      expect(error.message).toBe('The model did not answer within 240 seconds.');
      expect(error.hint).toContain('llm.timeoutMs');
      expect(error.retryable).toBe(true);
      expect(error.details).toEqual({ mayBeBilled: true });
      // The model may still be working on a timed-out request, and bill it: it is not sent again.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });

  it('fails with CONFIG_INVALID when the OpenAI key is missing', async () => {
    const { config, ctx } = openai();
    const provider = createOpenAiFromConfig(
      'openai',
      config,
      new Secrets({ OPENAI_API_KEY: KEY }),
      'gpt-6-luna',
    );
    const error = await failure(provider.generateJson(request(), { ...ctx, secrets: new Secrets({}) }));
    expect(error.code).toBe('CONFIG_INVALID');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('OpenAI provider setup and cost', () => {
  it('never sends the OpenAI key to a base URL that is not the OpenAI API', () => {
    const error = (() => {
      try {
        setup('openai', { baseUrl: 'https://attacker.example/v1' }, { OPENAI_API_KEY: KEY });
      } catch (err) {
        return err as MergeStoryError;
      }
      throw new Error('expected an error');
    })();
    expect(error).toBeInstanceOf(MergeStoryError);
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.hint).toContain('openai-compatible');
    expect(error.hint).toContain('MERGESTORY_LLM_API_KEY');
    expect(fetchMock).not.toHaveBeenCalled();
    // The official endpoint, written out, is still accepted.
    const official = setup('openai', { baseUrl: 'https://api.openai.com/v1/' }, { OPENAI_API_KEY: KEY });
    expect(official.provider.endpointHost).toBe('api.openai.com');
  });

  it('reports the endpoint host for the egress report', () => {
    expect(openai().provider.endpointHost).toBe('api.openai.com');
    expect(ollama().provider.endpointHost).toBe('localhost:11434');
    expect(openai().provider.id).toBe('openai');
    expect(ollama().provider.id).toBe('openai-compatible');
  });

  it('estimates the cost of the default model from the fallback table', () => {
    const { ctx, provider } = openai();
    // gpt-6-luna: $0.10 in, $0.50 out per million tokens
    expect(provider.estimateCostUsd(1_000_000, 1_000_000, ctx)).toBeCloseTo(0.6, 6);
  });

  it('is free on a local server, counts an unpriced hosted model at the highest rate, and uses a configured price', () => {
    const { ctx, provider } = ollama();
    expect(provider.estimateCostUsd(1000, 1000, ctx)).toBe(0);

    const { ctx: hostedCtx } = testContext({
      config: {
        llm: { provider: 'openai-compatible', baseUrl: 'https://gateway.example.com/v1', model: 'mystery' },
      },
    });
    const unpriced = createOpenAiFromConfig(
      'openai-compatible',
      hostedCtx.config,
      hostedCtx.secrets,
      'mystery',
    );
    // $10 per million input tokens plus $50 per million output tokens.
    expect(unpriced.estimateCostUsd(1_000_000, 1_000_000, hostedCtx)).toBeCloseTo(60, 6);
    // A look-alike of a loopback address is a public host, not a free local server.
    const lookalike = createOpenAiFromConfig(
      'openai-compatible',
      resolveConfig({
        skipFile: true,
        env: {},
        overrides: {
          llm: {
            provider: 'openai-compatible',
            baseUrl: 'https://127.0.0.1.example.com/v1',
            model: 'mystery',
          },
        },
      }),
      new Secrets({}),
      'mystery',
    );
    expect(lookalike.estimateCostUsd(1_000_000, 0, hostedCtx)).toBeCloseTo(10, 6);

    const priced = resolveConfig({
      skipFile: true,
      env: {},
      overrides: {
        llm: { provider: 'openai-compatible', baseUrl: 'https://gateway.example.com/v1', model: 'm' },
        pricing: { 'openai-compatible:m': { kind: 'llm', inputPerMTok: 1, outputPerMTok: 2 } },
      },
    });
    const pricedCtx = createRunContext({
      config: priced,
      runId: 't',
      runDir: '/x',
      logger: silentLogger,
      secrets: new Secrets({}),
      cache: noCache,
    });
    const pricedProvider = createOpenAiFromConfig('openai-compatible', priced, new Secrets({}), 'm');
    expect(pricedProvider.estimateCostUsd(1_000_000, 1_000_000, pricedCtx)).toBeCloseTo(3, 6);
  });
});
