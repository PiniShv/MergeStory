/**
 * What an LLM call costs in USD, and what the budget assumes for a model with no price. Prices
 * come from the run's price book: the built-in table in core/cost.ts with the "pricing" section
 * of the config file laid over it, because providers change prices.
 */
import type { RunContext } from '../core/context.ts';

interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

/** The model id without a date or snapshot suffix ("claude-haiku-5-5-20261001" -> "claude-haiku-5-5"). */
export function baseModelId(model: string): string {
  return model.replace(/(?:[-@]\d{8}|-\d{4}-\d{2}-\d{2})$/, '');
}

/**
 * Estimated cost of a call in USD, from the run's price book for the exact id and then for the id
 * without a date suffix. Returns null when the price is unknown.
 */
export function llmCostUsd(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  ctx: RunContext,
): number | null {
  for (const id of new Set([model, baseModelId(model)])) {
    const cost = ctx.cost.prices.llmCost(provider, id, inputTokens, outputTokens);
    if (cost !== null) return cost;
  }
  return null;
}

/** Rate used for a model whose price is unknown: the highest listed rate, so it is not counted as cheap. */
export const UNKNOWN_MODEL_PRICE: ModelPrice = { inputPerMTok: 10, outputPerMTok: 50 };

/**
 * Cost to check against the budget and to record. A model without a known price counts at
 * UNKNOWN_MODEL_PRICE (with one warning per model), so an unlisted model is not counted as cheap.
 * Servers on this machine or a private network (for example Ollama) count as 0, even when they
 * forward to a paid service.
 */
export function budgetLlmCostUsd(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  ctx: RunContext,
  local: boolean,
): number {
  if (local) return 0;
  const known = llmCostUsd(provider, model, inputTokens, outputTokens, ctx);
  if (known !== null) return known;
  if (ctx.firstTime(`unknown-llm-price:${provider}:${model}`)) {
    ctx.progress({
      stage: 'storyboard',
      status: 'warn',
      message:
        `No price is known for ${provider} model "${model}"; counting it at $${UNKNOWN_MODEL_PRICE.inputPerMTok}/` +
        `$${UNKNOWN_MODEL_PRICE.outputPerMTok} per million tokens against the budget. Add its price to the "pricing" section of the config file.`,
    });
  }
  return (
    (inputTokens * UNKNOWN_MODEL_PRICE.inputPerMTok + outputTokens * UNKNOWN_MODEL_PRICE.outputPerMTok) /
    1_000_000
  );
}
