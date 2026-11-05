/**
 * What speech costs in USD. Prices come from the run's price book: the built-in table in
 * core/cost.ts with the "pricing" section of the config file laid over it (for example
 * "openai:gpt-4o-mini-tts"), because providers change prices.
 */
import type { RunContext } from '../core/context.ts';

/** Used for a model with no known price: the dearest model of that provider, so budgets stay safe. */
const UNKNOWN_MODEL_PER_MCHARS: Record<string, number> = { openai: 30, elevenlabs: 80 };

export function ttsPricePerMChars(ctx: RunContext, provider: string, model: string): number {
  const listed = ctx.cost.prices.find(provider, model);
  if (listed?.kind === 'tts') return listed.perMChars;
  const assumed = UNKNOWN_MODEL_PER_MCHARS[provider] ?? 80;
  if (ctx.firstTime(`unknown-tts-price:${provider}:${model}`)) {
    ctx.logger.warn(
      `No price is known for ${provider} model "${model}"; assuming $${assumed} per million characters. ` +
        'Set "pricing" in the config to correct it.',
    );
  }
  return assumed;
}

export function ttsCostUsd(ctx: RunContext, provider: string, model: string, characters: number): number {
  return (characters * ttsPricePerMChars(ctx, provider, model)) / 1_000_000;
}
