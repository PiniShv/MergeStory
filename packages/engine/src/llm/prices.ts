/**
 * What an LLM call costs in USD, and what the budget assumes for a model with no price. Prices
 * come from the run's price book: the built-in table in core/cost.ts with the "pricing" section
 * of the config file laid over it, because providers change prices.
 */
import type { RunContext } from '../core/context.ts';
import type { UsageRecord } from '../core/types.ts';

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
 * Cost to check against the budget and to record. A listed or configured price always wins. A model
 * without one counts at UNKNOWN_MODEL_PRICE (with one warning per model), so an unlisted model is
 * not counted as cheap. The exception is a server on this machine or a private network (for
 * example Ollama): it counts as $0, with a warning that the budget does not cover it.
 */
export function budgetLlmCostUsd(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  ctx: RunContext,
  local: boolean,
): number {
  const known = llmCostUsd(provider, model, inputTokens, outputTokens, ctx);
  if (known !== null) return known;
  const firstTime = ctx.firstTime(`unknown-llm-price:${provider}:${model}`);
  if (local) {
    if (firstTime) {
      ctx.progress({
        stage: 'storyboard',
        status: 'warn',
        message:
          `${provider} model "${model}" runs on a server on this machine or your network and has no known price, ` +
          'so it counts as $0 and the budget does not cover it. Add its price to the "pricing" section of the config file to count it.',
      });
    }
    return 0;
  }
  if (firstTime) {
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

/** How budgetLlmCostUsd got its number: undefined when the price is known. */
export function llmPriceNote(
  provider: string,
  model: string,
  ctx: RunContext,
  local: boolean,
): UsageRecord['priceNote'] {
  if (llmCostUsd(provider, model, 0, 0, ctx) !== null) return undefined;
  return local ? 'local' : 'assumed';
}
