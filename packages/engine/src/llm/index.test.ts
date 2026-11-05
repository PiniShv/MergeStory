import { describe, expect, it } from 'vitest';
import { type ConfigInput, resolveConfig, Secrets } from '../core/config.ts';
import { MergeStoryError } from '../core/errors.ts';
import { createLlmProvider, DEFAULT_MODELS } from './index.ts';
import { buildMessages, parseEndpointUrl, parseJsonLoose } from './shared.ts';

function config(llm: NonNullable<ConfigInput['llm']>) {
  return resolveConfig({ skipFile: true, env: {}, overrides: { llm } });
}

function error(fn: () => unknown): MergeStoryError {
  try {
    fn();
  } catch (err) {
    if (err instanceof MergeStoryError) return err;
    throw err;
  }
  throw new Error('expected a failure');
}

describe('createLlmProvider', () => {
  it('returns null for provider "none"', () => {
    expect(createLlmProvider(config({ provider: 'none' }), new Secrets({}))).toBeNull();
  });

  it('defaults to the cheapest Anthropic model', () => {
    const provider = createLlmProvider(
      config({ provider: 'anthropic' }),
      new Secrets({ ANTHROPIC_API_KEY: 'test-key-000000' }),
    );
    expect(provider?.id).toBe('anthropic');
    expect(provider?.model).toBe('claude-haiku-5-5');
    expect(DEFAULT_MODELS.anthropic).toBe('claude-haiku-5-5');
  });

  it('defaults to the cheap OpenAI model', () => {
    const provider = createLlmProvider(
      config({ provider: 'openai' }),
      new Secrets({ OPENAI_API_KEY: 'test-key-000000' }),
    );
    expect(provider?.id).toBe('openai');
    expect(provider?.model).toBe('gpt-6-luna');
    expect(DEFAULT_MODELS.openai).toBe('gpt-6-luna');
    expect(DEFAULT_MODELS['openai-compatible']).toBeNull();
  });

  it('uses the configured model name as given', () => {
    const provider = createLlmProvider(
      config({ provider: 'anthropic', model: 'claude-sonnet-5-5' }),
      new Secrets({ ANTHROPIC_API_KEY: 'test-key-000000' }),
    );
    expect(provider?.model).toBe('claude-sonnet-5-5');
  });

  it('asks for the key variable when a key is missing', () => {
    expect(error(() => createLlmProvider(config({ provider: 'anthropic' }), new Secrets({}))).hint).toContain(
      'ANTHROPIC_API_KEY',
    );
    expect(error(() => createLlmProvider(config({ provider: 'openai' }), new Secrets({}))).hint).toContain(
      'OPENAI_API_KEY',
    );
  });

  it('needs a base URL and a model for an OpenAI-compatible server, but no key', () => {
    expect(
      error(() =>
        createLlmProvider(config({ provider: 'openai-compatible', model: 'llama3.1' }), new Secrets({})),
      ).hint,
    ).toContain('llm.baseUrl');
    expect(
      error(() =>
        createLlmProvider(
          config({ provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' }),
          new Secrets({}),
        ),
      ).hint,
    ).toContain('llm.model');
    const provider = createLlmProvider(
      config({ provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' }),
      new Secrets({}),
    );
    expect(provider?.endpointHost).toBe('localhost:11434');
  });

  it('keeps plain http for local and private servers only', () => {
    const make = (baseUrl: string) =>
      createLlmProvider(config({ provider: 'openai-compatible', baseUrl, model: 'm' }), new Secrets({}));
    expect(() => make('http://192.168.1.20:8000/v1')).not.toThrow();
    expect(() => make('http://gpu-box:8000/v1')).not.toThrow();
    expect(() => make('http://llm.internal/v1')).not.toThrow();
    expect(() => make('https://openrouter.ai/api/v1')).not.toThrow();
    expect(error(() => make('http://api.example.com/v1')).code).toBe('CONFIG_INVALID');
  });
});

describe('endpoint helpers', () => {
  it('rejects URLs with credentials or odd schemes', () => {
    expect(error(() => parseEndpointUrl('https://user:secret@example.com', 'llm.baseUrl')).message).toContain(
      'user name or password',
    );
    expect(error(() => parseEndpointUrl('ftp://example.com', 'llm.baseUrl')).code).toBe('CONFIG_INVALID');
    expect(error(() => parseEndpointUrl('not a url', 'llm.baseUrl')).code).toBe('CONFIG_INVALID');
  });
});

describe('parseJsonLoose', () => {
  it('parses plain JSON, fenced JSON and JSON with text around it', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoose('﻿{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose('Here you go: {"a":1} Hope it helps.')).toEqual({ a: 1 });
  });

  it('returns undefined when nothing parses, including cut-off JSON', () => {
    expect(parseJsonLoose('no json here')).toBeUndefined();
    expect(parseJsonLoose('{"a":')).toBeUndefined();
  });
});

describe('buildMessages', () => {
  it('puts the prompt first and keeps repair turns in order', () => {
    const messages = buildMessages({
      system: 's',
      prompt: 'p',
      schemaName: 'x',
      jsonSchema: {},
      maxOutputTokens: 10,
      history: [
        { role: 'assistant', content: 'a' },
        { role: 'user', content: 'u' },
      ],
    });
    expect(messages.map((m) => m.content)).toEqual(['p', 'a', 'u']);
  });
});
