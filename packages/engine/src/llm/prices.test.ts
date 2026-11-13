import { describe, expect, it } from 'vitest';
import type { ConfigInput } from '../core/config.ts';
import { testContext } from '../testing/context.ts';
import { baseModelId, budgetLlmCostUsd, llmCostUsd, llmPriceNote } from './prices.ts';

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
  });

  it('counts an unpriced model on a local server as $0 and warns once that the budget does not cover it', () => {
    const { ctx: run, events } = testContext();
    expect(budgetLlmCostUsd('openai-compatible', 'llama3.1', 1_000_000, 1_000_000, run, true)).toBe(0);
    expect(budgetLlmCostUsd('openai-compatible', 'llama3.1', 1, 1, run, true)).toBe(0);
    expect(events.map((e) => [e.status, e.message])).toEqual([
      [
        'warn',
        'openai-compatible model "llama3.1" runs on a server on this machine or your network and has no known price, so it counts as $0 and the budget does not cover it. Add its price to the "pricing" section of the config file to count it.',
      ],
    ]);
    expect(llmPriceNote('openai-compatible', 'llama3.1', run, true)).toBe('local');
    expect(llmPriceNote('anthropic', 'claude-unknown-9', run, false)).toBe('assumed');
    expect(llmPriceNote('openai', 'gpt-6-luna', run, false)).toBeUndefined();
  });

  it('uses a price from the config also on a local server', () => {
    const run = contextFor({
      pricing: { 'openai-compatible:m': { kind: 'llm', inputPerMTok: 1, outputPerMTok: 2 } },
    });
    expect(budgetLlmCostUsd('openai-compatible', 'm', 1_000_000, 1_000_000, run, true)).toBeCloseTo(3, 6);
    expect(llmPriceNote('openai-compatible', 'm', run, true)).toBeUndefined();
  });
});
