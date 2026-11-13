import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ConfigInput, Secrets } from '../core/config.ts';
import { MergeStoryError } from '../core/errors.ts';
import type { LlmRequest } from '../core/providers.ts';
import { testContext } from '../testing/context.ts';
import { createAnthropicProvider } from './anthropic.ts';

const sdk = vi.hoisted(() => {
  const state = { constructed: [] as Record<string, unknown>[], create: vi.fn(), stream: vi.fn() };
  class APIError extends Error {
    status: number | undefined;
    constructor(status: number | undefined, message: string) {
      super(message);
      this.status = status;
    }
  }
  class AuthenticationError extends APIError {}
  class RateLimitError extends APIError {}
  class APIConnectionError extends APIError {}
  class APIConnectionTimeoutError extends APIConnectionError {}
  class Anthropic {
    static AuthenticationError = AuthenticationError;
    messages = { create: state.create, stream: state.stream };
    constructor(options: Record<string, unknown>) {
      state.constructed.push(options);
    }
  }
  return {
    state,
    Anthropic,
    APIError,
    AuthenticationError,
    RateLimitError,
    APIConnectionError,
    APIConnectionTimeoutError,
  };
});

vi.mock('@anthropic-ai/sdk', () => ({
  default: sdk.Anthropic,
  Anthropic: sdk.Anthropic,
  APIError: sdk.APIError,
  AuthenticationError: sdk.AuthenticationError,
  RateLimitError: sdk.RateLimitError,
  APIConnectionError: sdk.APIConnectionError,
  APIConnectionTimeoutError: sdk.APIConnectionTimeoutError,
}));

const KEY = 'test-anthropic-key-0000';
const SCHEMA = {
  type: 'object',
  properties: { a: { type: 'string' } },
  required: ['a'],
  additionalProperties: false,
};

function setup(overrides: ConfigInput = {}, secrets: Record<string, string> = { ANTHROPIC_API_KEY: KEY }) {
  const { llm, ...rest } = overrides;
  const { ctx } = testContext({ config: { ...rest, llm: { provider: 'anthropic', ...llm } }, secrets });
  const { config } = ctx;
  const provider = createAnthropicProvider(config, ctx.secrets, 'claude-haiku-5-5', {});
  return { config, ctx, provider };
}

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

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg_1',
    model: 'claude-haiku-5-5',
    role: 'assistant',
    stop_reason: 'end_turn',
    stop_details: null,
    content: [{ type: 'text', text: '{"a":"x"}' }],
    usage: {
      input_tokens: 1200,
      output_tokens: 300,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
    },
    ...overrides,
  };
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

beforeEach(() => {
  sdk.state.constructed.length = 0;
  sdk.state.create.mockReset();
  sdk.state.stream.mockReset();
});

describe('Anthropic provider request', () => {
  it('asks for the JSON schema with output_config and sends no sampling parameters', async () => {
    const { ctx, provider } = setup();
    sdk.state.create.mockResolvedValue(message());

    await provider.generateJson(request(), ctx);

    const params = sdk.state.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(params.model).toBe('claude-haiku-5-5');
    expect(params.max_tokens).toBe(8000);
    expect(params.system).toBe('You write storyboards.');
    expect(params.output_config).toEqual({
      format: { type: 'json_schema', schema: SCHEMA },
      effort: 'medium',
    });
    for (const forbidden of ['temperature', 'top_p', 'top_k', 'thinking']) {
      expect(params).not.toHaveProperty(forbidden);
    }
    expect(params.messages).toEqual([{ role: 'user', content: 'Evidence pack goes here.' }]);
  });

  it('creates the client with the key from the run secrets, retries and the configured timeout', async () => {
    const { ctx, provider } = setup({ llm: { timeoutMs: 90_000 } });
    sdk.state.create.mockResolvedValue(message());

    await provider.generateJson(request(), ctx);

    expect(sdk.state.constructed).toHaveLength(1);
    expect(sdk.state.constructed[0]).toMatchObject({
      apiKey: KEY,
      baseURL: 'https://api.anthropic.com',
      maxRetries: 0,
      timeout: 90_000,
    });
  });

  it('sends repair turns after the original prompt and ends with a user turn', async () => {
    const { ctx, provider } = setup();
    sdk.state.create.mockResolvedValue(message());

    await provider.generateJson(
      request({
        history: [
          { role: 'assistant', content: '{"a":"old"}' },
          { role: 'user', content: '1. scenes[0]: fix this' },
        ],
      }),
      ctx,
    );

    const params = sdk.state.create.mock.calls[0]![0] as { messages: { role: string }[] };
    expect(params.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('sends the request again without effort when the model does not accept it', async () => {
    const { ctx, provider } = setup();
    sdk.state.create
      .mockRejectedValueOnce(
        new sdk.APIError(400, 'invalid_request_error: effort is not supported for this model'),
      )
      .mockResolvedValueOnce(message());

    const response = await provider.generateJson(request(), ctx);

    expect(sdk.state.create).toHaveBeenCalledTimes(2);
    const first = sdk.state.create.mock.calls[0]![0] as { output_config: Record<string, unknown> };
    const second = sdk.state.create.mock.calls[1]![0] as { output_config: Record<string, unknown> };
    expect(first.output_config).toHaveProperty('effort', 'medium');
    expect(second.output_config).not.toHaveProperty('effort');
    expect(second.output_config).toHaveProperty('format');
    expect(response.json).toEqual({ a: 'x' });
  });

  it('does not keep retrying: a second rejection is reported', async () => {
    const { ctx, provider } = setup();
    sdk.state.create.mockRejectedValue(new sdk.APIError(400, 'effort is not supported'));
    const error = await failure(provider.generateJson(request(), ctx));
    expect(error.code).toBe('LLM_FAILED');
    expect(sdk.state.create).toHaveBeenCalledTimes(2);
  });

  it('does not drop effort for an unrelated bad request', async () => {
    const { ctx, provider } = setup();
    sdk.state.create.mockRejectedValue(new sdk.APIError(400, 'max_tokens is too large for this model'));
    const error = await failure(provider.generateJson(request(), ctx));
    expect(error.code).toBe('LLM_FAILED');
    expect(sdk.state.create).toHaveBeenCalledTimes(1);
  });

  it('refuses a history that would end with an assistant turn (prefill)', async () => {
    const { ctx, provider } = setup();
    const error = await failure(
      provider.generateJson(request({ history: [{ role: 'assistant', content: '{' }] }), ctx),
    );
    expect(error.code).toBe('INTERNAL');
    expect(sdk.state.create).not.toHaveBeenCalled();
  });

  it('streams very long answers instead of one idle request', async () => {
    const { ctx, provider } = setup();
    sdk.state.stream.mockReturnValue({ finalMessage: async () => message() });

    const response = await provider.generateJson(request({ maxOutputTokens: 30_000 }), ctx);

    expect(sdk.state.stream).toHaveBeenCalledTimes(1);
    expect(sdk.state.create).not.toHaveBeenCalled();
    expect(response.json).toEqual({ a: 'x' });
  });
});

describe('Anthropic provider response', () => {
  it('reads only text blocks and reports usage and model', async () => {
    const { ctx, provider } = setup();
    sdk.state.create.mockResolvedValue(
      message({
        content: [
          { type: 'thinking', thinking: 'private reasoning', signature: 'x' },
          { type: 'text', text: '{"a":"hello"}' },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 7,
        },
      }),
    );

    const response = await provider.generateJson(request(), ctx);

    expect(response.text).toBe('{"a":"hello"}');
    expect(response.json).toEqual({ a: 'hello' });
    // input counts every input token: 10 new + 5 read from the cache + 7 written to it
    expect(response.usage).toEqual({
      inputTokens: 22,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheWriteTokens: 7,
    });
    expect(response.model).toBe('claude-haiku-5-5');
    expect(response.stopReason).toBe('end_turn');
  });

  it('returns undefined json when the text is not JSON, so the caller can ask for a repair', async () => {
    const { ctx, provider } = setup();
    sdk.state.create.mockResolvedValue(
      message({ content: [{ type: 'text', text: 'Sorry, here is a summary instead.' }] }),
    );
    const response = await provider.generateJson(request(), ctx);
    expect(response.json).toBeUndefined();
  });

  it('maps a refusal to LLM_REFUSED with its category and records the billed cost', async () => {
    const { ctx, provider } = setup();
    sdk.state.create.mockResolvedValue(
      message({
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'cyber', explanation: null },
        content: [],
      }),
    );

    const error = await failure(provider.generateJson(request(), ctx));

    expect(error.code).toBe('LLM_REFUSED');
    expect(error.message).toContain('cyber');
    expect(error.hint).toBeTruthy();
    const records = ctx.cost.report().records;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      provider: 'anthropic',
      kind: 'llm',
      inputTokens: 1200,
      outputTokens: 300,
      estimated: true,
    });
    expect(records[0]!.costUsd).toBeGreaterThan(0);
  });

  it('maps max_tokens to LLM_FAILED with a hint about llm.maxOutputTokens', async () => {
    const { ctx, provider } = setup();
    sdk.state.create.mockResolvedValue(message({ stop_reason: 'max_tokens' }));

    const error = await failure(provider.generateJson(request(), ctx));

    expect(error.code).toBe('LLM_FAILED');
    expect(error.hint).toContain('llm.maxOutputTokens');
    expect(ctx.cost.report().records).toHaveLength(1);
  });

  it('fails clearly when the answer has no text', async () => {
    const { ctx, provider } = setup();
    sdk.state.create.mockResolvedValue(
      message({ content: [{ type: 'thinking', thinking: 'x', signature: 'y' }] }),
    );
    const error = await failure(provider.generateJson(request(), ctx));
    expect(error.code).toBe('LLM_FAILED');
  });
});

describe('Anthropic provider errors', () => {
  it('maps a rejected key to CONFIG_INVALID and tells the user which variable to set', async () => {
    const { ctx, provider } = setup();
    sdk.state.create.mockRejectedValue(new sdk.AuthenticationError(401, 'invalid x-api-key'));
    const error = await failure(provider.generateJson(request(), ctx));
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.hint).toContain('ANTHROPIC_API_KEY');
  });

  it('maps rate limiting to a retryable RATE_LIMITED, after trying again', async () => {
    vi.useFakeTimers();
    try {
      const { ctx, provider } = setup();
      sdk.state.create.mockRejectedValue(new sdk.RateLimitError(429, 'slow down'));
      const pending = failure(provider.generateJson(request(), ctx));
      await vi.runAllTimersAsync();
      const error = await pending;
      expect(error.code).toBe('RATE_LIMITED');
      expect(error.retryable).toBe(true);
      expect(sdk.state.create).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps other API errors to LLM_FAILED with the status, and redacts the key from the message', async () => {
    const { ctx, provider } = setup();
    sdk.state.create.mockRejectedValue(new sdk.APIError(400, `bad request for key ${KEY}`));
    const error = await failure(provider.generateJson(request(), ctx));
    expect(error.code).toBe('LLM_FAILED');
    expect(error.message).toContain('HTTP 400');
    expect(error.message).not.toContain(KEY);
    expect(error.details).toEqual({ status: 400 });
  });

  it('tries a server error again and marks it retryable', async () => {
    vi.useFakeTimers();
    try {
      const { ctx, provider } = setup();
      sdk.state.create
        .mockRejectedValueOnce(new sdk.APIError(529, 'overloaded'))
        .mockResolvedValueOnce(message());
      const pending = provider.generateJson(request(), ctx);
      await vi.runAllTimersAsync();
      expect((await pending).json).toEqual({ a: 'x' });
      expect(sdk.state.create).toHaveBeenCalledTimes(2);

      sdk.state.create.mockReset();
      sdk.state.create.mockRejectedValue(new sdk.APIError(529, 'overloaded'));
      const failing = failure(provider.generateJson(request(), ctx));
      await vi.runAllTimersAsync();
      expect((await failing).retryable).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not send a timed-out request again, and hints to raise llm.timeoutMs', async () => {
    const { ctx, provider } = setup();
    sdk.state.create.mockRejectedValue(new sdk.APIConnectionTimeoutError(undefined, 'Request timed out.'));
    const timedOut = await failure(provider.generateJson(request(), ctx));
    expect(timedOut.code).toBe('LLM_FAILED');
    expect(timedOut.hint).toContain('llm.timeoutMs');
    expect(timedOut.details).toEqual({ mayBeBilled: true });
    // The model may still be working on it, and bill it.
    expect(sdk.state.create).toHaveBeenCalledTimes(1);
  });

  it('reports a cancelled run as ABORTED', async () => {
    const { ctx, provider } = setup();
    const controller = new AbortController();
    const cancelled = { ...ctx, signal: controller.signal };
    sdk.state.create.mockImplementation(async () => {
      controller.abort();
      throw new sdk.APIError(undefined, 'aborted');
    });
    const error = await failure(provider.generateJson(request(), cancelled));
    expect(error.code).toBe('ABORTED');
  });

  it('marks an answer that is not a message as possibly billed, instead of failing with a TypeError', async () => {
    const { ctx, provider } = setup();
    sdk.state.create.mockResolvedValue({ unexpected: 'body' });
    const error = await failure(provider.generateJson(request(), ctx));
    expect(error.code).toBe('LLM_FAILED');
    expect(error.message).toBe('The answer could not be read.');
    expect(error.details).toEqual({ mayBeBilled: true });
  });

  it('marks a message without token counts or content as possibly billed, so no cost becomes NaN', async () => {
    const { ctx, provider } = setup();
    for (const body of [
      { usage: {}, content: [], stop_reason: 'end_turn' },
      { usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'end_turn' },
    ]) {
      sdk.state.create.mockResolvedValue(body);
      const error = await failure(provider.generateJson(request(), ctx));
      expect(error.message).toBe('The answer could not be read.');
      expect(error.details).toEqual({ mayBeBilled: true });
    }
    expect(ctx.cost.report().records).toEqual([]);
  });

  it('fails with CONFIG_INVALID when the run has no key', async () => {
    const { ctx, provider } = setup();
    const withoutKey = { ...ctx, secrets: new Secrets({}) };
    const error = await failure(provider.generateJson(request(), withoutKey));
    expect(error.code).toBe('CONFIG_INVALID');
    expect(sdk.state.create).not.toHaveBeenCalled();
  });
});

describe('Anthropic provider setup', () => {
  it('counts a gateway on this machine at the built-in price of a known model', () => {
    const { config, ctx } = setup();
    const provider = createAnthropicProvider(
      config,
      new Secrets({ ANTHROPIC_API_KEY: KEY }),
      'claude-haiku-5-5',
      {
        ANTHROPIC_BASE_URL: 'http://localhost:8080',
      },
    );
    expect(provider.estimateCostUsd(1e6, 1e6, ctx)).toBeCloseTo(0.6, 9);
    expect(provider.priceNote?.(ctx)).toBeUndefined();
  });

  it('reports api.anthropic.com as the egress host by default', () => {
    expect(setup().provider.endpointHost).toBe('api.anthropic.com');
    expect(setup().provider.id).toBe('anthropic');
  });

  it('uses the host of ANTHROPIC_BASE_URL and passes it to the SDK without a trailing slash', async () => {
    const { config, ctx } = setup();
    const provider = createAnthropicProvider(
      config,
      new Secrets({ ANTHROPIC_API_KEY: KEY }),
      'claude-haiku-5-5',
      {
        ANTHROPIC_BASE_URL: 'https://gateway.example.com/anthropic/',
      },
    );
    expect(provider.endpointHost).toBe('gateway.example.com');
    sdk.state.create.mockResolvedValue(message());
    await provider.generateJson(request(), ctx);
    expect(sdk.state.constructed[0]).toMatchObject({ baseURL: 'https://gateway.example.com/anthropic' });
  });

  it('rejects plain http to a public host and credentials in the URL', () => {
    const { config } = setup();
    const secrets = new Secrets({ ANTHROPIC_API_KEY: KEY });
    expect(() =>
      createAnthropicProvider(config, secrets, 'm', { ANTHROPIC_BASE_URL: 'http://api.example.com' }),
    ).toThrow(/plain http/);
    expect(() =>
      createAnthropicProvider(config, secrets, 'm', { ANTHROPIC_BASE_URL: 'https://user:pw@example.com' }),
    ).toThrow(/user name or password/);
    expect(() =>
      createAnthropicProvider(config, secrets, 'm', { ANTHROPIC_BASE_URL: 'http://localhost:8080' }),
    ).not.toThrow();
  });

  it('throws CONFIG_INVALID with a hint when no key is set', () => {
    const { config } = setup();
    try {
      createAnthropicProvider(config, new Secrets({}), 'claude-haiku-5-5', {});
      throw new Error('expected a failure');
    } catch (err) {
      expect(err).toBeInstanceOf(MergeStoryError);
      expect((err as MergeStoryError).code).toBe('CONFIG_INVALID');
      expect((err as MergeStoryError).hint).toContain('ANTHROPIC_API_KEY');
    }
  });

  it('estimates cost from the price book', () => {
    const { ctx, provider } = setup();
    // claude-haiku-5-5: $0.10 in, $0.50 out per million tokens
    expect(provider.estimateCostUsd(1_000_000, 1_000_000, ctx)).toBeCloseTo(0.6, 6);
  });
});
