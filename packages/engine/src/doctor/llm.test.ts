import { describe, expect, it } from 'vitest';
import { byId, doctor } from '../testing/doctor.ts';

describe('LLM', () => {
  it('needs the key of the chosen provider and names it without showing it', async () => {
    const missing = await doctor({ llm: { provider: 'anthropic' } });
    expect(byId(missing.checks, 'llm')).toMatchObject({
      status: 'fail',
      detail: 'anthropic selected but ANTHROPIC_API_KEY is not set',
    });
    expect(byId(missing.checks, 'llm').fix).toContain('--llm none');
    expect(missing.ok).toBe(false);

    const key = 'sk-ant-api03-SECRET-VALUE-0123456789';
    const present = await doctor(
      { llm: { provider: 'anthropic', model: 'claude-haiku-5-5' } },
      {},
      { ANTHROPIC_API_KEY: key },
    );
    const check = byId(present.checks, 'llm');
    expect(check.status).toBe('pass');
    expect(check.detail).toContain('ANTHROPIC_API_KEY is set');
    expect(check.detail).toContain('claude-haiku-5-5');
    expect(check.detail).toContain('api.anthropic.com');
    expect(check.detail).toContain('that provider bills your account');
    expect(JSON.stringify(present)).not.toContain(key);

    const openai = await doctor({ llm: { provider: 'openai' } });
    expect(byId(openai.checks, 'llm').detail).toContain('OPENAI_API_KEY is not set');
  });

  it('fails the openai provider with a base URL that is not the OpenAI API', async () => {
    const other = await doctor(
      { llm: { provider: 'openai', baseUrl: 'https://openrouter.ai/api/v1' } },
      {},
      { OPENAI_API_KEY: 'sk-test-0123456789' },
    );
    expect(byId(other.checks, 'llm')).toMatchObject({
      status: 'fail',
      detail: 'The openai provider only talks to the OpenAI API.',
    });
    expect(byId(other.checks, 'llm').fix).toContain('MERGESTORY_LLM_BASE_URL');
    const same = await doctor(
      { llm: { provider: 'openai', baseUrl: 'https://api.openai.com/v1/' } },
      {},
      { OPENAI_API_KEY: 'sk-test-0123456789' },
    );
    expect(byId(same.checks, 'llm').status).toBe('pass');
  });

  it('needs a base URL for an OpenAI-compatible server but no key', async () => {
    const noUrl = await doctor({ llm: { provider: 'openai-compatible' } });
    expect(byId(noUrl.checks, 'llm')).toMatchObject({ status: 'fail' });
    expect(byId(noUrl.checks, 'llm').fix).toContain('MERGESTORY_LLM_BASE_URL');
    const local = await doctor({
      llm: { provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' },
    });
    expect(byId(local.checks, 'llm').status).toBe('pass');
    expect(byId(local.checks, 'llm').detail).toContain('localhost:11434');
    expect(byId(local.checks, 'llm').detail).toContain('no key set');
    const withKey = await doctor(
      { llm: { provider: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1' } },
      {},
      { MERGESTORY_LLM_API_KEY: 'router-key-0123456789' },
    );
    expect(byId(withKey.checks, 'llm').detail).toContain('MERGESTORY_LLM_API_KEY is set');
    expect(JSON.stringify(withKey)).not.toContain('router-key');
  });
});
