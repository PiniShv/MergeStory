import { describe, expect, it } from 'vitest';
import type { ConfigInput } from '../core/config.ts';
import { testContext } from '../testing/context.ts';
import { baseModelId, budgetLlmCostUsd, llmCostUsd } from './prices.ts';

function contextFor(config: ConfigInput = {}) {
  return testContext({ config }).ctx;
}

const ctx = contextFor();

/** USD for a million input tokens and for a million output tokens, or null when the model has no price. */
function perMTok(provider: string, model: string, run = ctx): [number, number] | null {
  const input = llmCostUsd(provider, model, 1_000_000, 0, run);
  const output = llmCostUsd(provider, model, 0, 1_000_000, run);
  return input === null || output === null ? null : [input, output];
}

describe('LLM prices', () => {
  it('prices dated snapshot ids like their base model', () => {
    expect(baseModelId('claude-haiku-5-5-20261001')).toBe('claude-haiku-5-5');
    expect(baseModelId('gpt-6-luna-2026-09-01')).toBe('gpt-6-luna');
    expect(llmCostUsd('anthropic', 'claude-haiku-5-5-20261001', 1_000_000, 1_000_000, ctx)).toBeCloseTo(
      0.6,
      6,
    );
  });

  it('lists the OpenAI models from the research and nothing for unknown ones', () => {
    expect(perMTok('openai', 'gpt-6-luna')).toEqual([0.1, 0.5]);
    expect(perMTok('openai', 'gpt-6.1-terra')).toEqual([1, 5]);
    expect(perMTok('openai', 'gpt-6.1-sol')).toEqual([2, 10]);
    expect(perMTok('openai', 'gpt-6-sol')).toEqual([2, 10]);
    expect(perMTok('openai', 'gpt-6-astra')).toEqual([10, 50]);
    expect(perMTok('openai-compatible', 'llama3.1')).toBeNull();
  });

  it('prefers a price from the config over the built-in one', () => {
    const run = contextFor({
      pricing: { 'openai:gpt-6-luna': { kind: 'llm', inputPerMTok: 5, outputPerMTok: 5 } },
    });
    expect(perMTok('openai', 'gpt-6-luna', run)).toEqual([5, 5]);
  });

  it('never lets an unknown model count as free against the budget', () => {
    expect(llmCostUsd('anthropic', 'claude-unknown-9', 1000, 1000, ctx)).toBeNull();
    expect(budgetLlmCostUsd('anthropic', 'claude-unknown-9', 1_000_000, 1_000_000, ctx, false)).toBeCloseTo(
      60,
      6,
    );
    expect(budgetLlmCostUsd('openai-compatible', 'llama3.1', 1_000_000, 1_000_000, ctx, true)).toBe(0);
  });
});
