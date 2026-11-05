import { describe, expect, it } from 'vitest';
import { budgetLlmCostUsd } from '../llm/prices.ts';
import { ttsPricePerMChars } from '../narration/pricing.ts';
import { testContext } from '../testing/context.ts';

describe('notices that appear once per run', () => {
  it('remembers a key within one run only', () => {
    const first = testContext().ctx;
    const second = testContext().ctx;
    expect(first.firstTime('key')).toBe(true);
    expect(first.firstTime('key')).toBe(false);
    expect(second.firstTime('key')).toBe(true);
  });

  it('gives each run its own unknown-price notices', () => {
    for (let run = 0; run < 2; run++) {
      const { ctx, logs, events } = testContext({ captureLogs: true });
      for (let call = 0; call < 2; call++) {
        budgetLlmCostUsd('acme', 'unlisted-model', 10, 10, ctx, false);
        ttsPricePerMChars(ctx, 'elevenlabs', 'unlisted-voice-model');
      }
      expect(events.filter((e) => e.status === 'warn')).toHaveLength(1);
      expect(logs.filter((line) => line.includes('No price is known'))).toHaveLength(2);
    }
  });
});
