/**
 * Cost and data-egress accounting.
 *
 * Every paid call records a UsageRecord. Before a run starts, the pipeline estimates the cost
 * and refuses to continue when the estimate is above the budget. Prices are a built-in table
 * that users can override in the config file ("pricing"), because providers change prices.
 */
import { MergeStoryError } from './errors.ts';
import type { CostReport, EgressContent, EgressRecord, UsageRecord } from './types.ts';

export interface LlmPrice {
  kind: 'llm';
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
}

export interface TtsPrice {
  kind: 'tts';
  /** USD per million characters of input text. */
  perMChars: number;
}

export type Price = LlmPrice | TtsPrice;

/**
 * Built-in prices, keyed "<provider>:<model>". Checked 2026-11. Local providers cost nothing.
 * Override or extend with the "pricing" section of the config file.
 */
export const DEFAULT_PRICES: Record<string, Price> = {
  'anthropic:claude-haiku-5-5': { kind: 'llm', inputPerMTok: 0.1, outputPerMTok: 0.5 },
  'anthropic:claude-sonnet-5-5': { kind: 'llm', inputPerMTok: 2, outputPerMTok: 10 },
  'anthropic:claude-opus-5-5': { kind: 'llm', inputPerMTok: 4, outputPerMTok: 20 },
  'anthropic:claude-fable-5-1': { kind: 'llm', inputPerMTok: 10, outputPerMTok: 50 },
  'openai:gpt-6-luna': { kind: 'llm', inputPerMTok: 0.1, outputPerMTok: 0.5 },
  'openai:gpt-6.1-terra': { kind: 'llm', inputPerMTok: 1, outputPerMTok: 5 },
  'openai:gpt-6.1-sol': { kind: 'llm', inputPerMTok: 2, outputPerMTok: 10 },
  'openai:gpt-6-sol': { kind: 'llm', inputPerMTok: 2, outputPerMTok: 10 },
  'openai:gpt-6-astra': { kind: 'llm', inputPerMTok: 10, outputPerMTok: 50 },
  // About $0.015 per minute of speech at roughly 800 characters per minute (token pricing).
  'openai:gpt-4o-mini-tts': { kind: 'tts', perMChars: 18 },
  'openai:gpt-4o-mini-tts-2025-12-15': { kind: 'tts', perMChars: 18 },
  'openai:tts-1': { kind: 'tts', perMChars: 15 },
  'openai:tts-1-hd': { kind: 'tts', perMChars: 30 },
  'elevenlabs:eleven_flash_v2_5': { kind: 'tts', perMChars: 40 },
  'elevenlabs:eleven_flash_v2': { kind: 'tts', perMChars: 40 },
  'elevenlabs:eleven_v4_turbo': { kind: 'tts', perMChars: 40 },
  'elevenlabs:eleven_v4': { kind: 'tts', perMChars: 80 },
  'elevenlabs:eleven_v3': { kind: 'tts', perMChars: 80 },
  'elevenlabs:eleven_multilingual_v2': { kind: 'tts', perMChars: 80 },
  'kokoro:*': { kind: 'tts', perMChars: 0 },
  'say:*': { kind: 'tts', perMChars: 0 },
  'none:*': { kind: 'tts', perMChars: 0 },
};

export class PriceBook {
  private readonly prices: Record<string, Price>;

  constructor(overrides: Record<string, Price> = {}) {
    this.prices = { ...DEFAULT_PRICES, ...overrides };
  }

  find(provider: string, model: string | null): Price | null {
    return this.prices[`${provider}:${model ?? '*'}`] ?? this.prices[`${provider}:*`] ?? null;
  }

  llmCost(provider: string, model: string, inputTokens: number, outputTokens: number): number | null {
    const price = this.find(provider, model);
    if (price?.kind !== 'llm') return null;
    return (inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) / 1_000_000;
  }
}

export class CostTracker {
  readonly budgetUsd: number;
  readonly prices: PriceBook;
  private readonly records: UsageRecord[] = [];

  constructor(budgetUsd: number, prices: PriceBook = new PriceBook()) {
    this.budgetUsd = budgetUsd;
    this.prices = prices;
  }

  record(entry: UsageRecord): void {
    this.records.push(entry);
  }

  get totalUsd(): number {
    return this.records.reduce((sum, r) => sum + r.costUsd, 0);
  }

  /** Throw before spending when `additionalUsd` would take the run over budget. */
  assertWithinBudget(additionalUsd: number, what: string): void {
    const projected = this.totalUsd + additionalUsd;
    if (projected > this.budgetUsd + 1e-9) {
      throw new MergeStoryError(
        'BUDGET_EXCEEDED',
        `${what} would cost about $${additionalUsd.toFixed(4)}, which takes this run to $${projected.toFixed(4)} ` +
          `(budget $${this.budgetUsd.toFixed(2)}).`,
        { hint: 'Raise the limit with --budget <usd>, pick a cheaper model or a local speech provider.' },
      );
    }
  }

  report(): CostReport {
    return {
      totalUsd: Math.round(this.totalUsd * 1e6) / 1e6,
      budgetUsd: this.budgetUsd,
      records: [...this.records],
    };
  }
}

export class EgressTracker {
  private readonly records: EgressRecord[] = [];

  /** Record an outbound transfer. Pass a host name only (no URL, no query string). */
  record(destination: string, purpose: string, bytes: number, contains: EgressContent[]): void {
    const host = destination.replace(/^[a-z]+:\/\//i, '').replace(/[/?#].*$/, '');
    const existing = this.records.find((r) => r.destination === host && r.purpose === purpose);
    if (existing) {
      existing.bytes += bytes;
      for (const c of contains) if (!existing.contains.includes(c)) existing.contains.push(c);
      return;
    }
    this.records.push({ destination: host, purpose, bytes, contains: [...contains] });
  }

  list(): EgressRecord[] {
    return this.records.map((r) => ({ ...r, contains: [...r.contains] }));
  }
}

/** Characters per token that the token estimates assume (code-heavy English text). */
export const CHARS_PER_TOKEN = 3.6;

/** Rough token estimate. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
