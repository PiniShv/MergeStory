import { describe, expect, it } from 'vitest';
import { makeTestContext } from '../testing/narration.ts';
import { splitForSynthesis } from './chunking.ts';
import { ttsCostUsd, ttsPricePerMChars } from './pricing.ts';

describe('splitForSynthesis', () => {
  it('keeps short text whole and drops empty text', () => {
    expect(splitForSynthesis('Hello there.', 100)).toEqual(['Hello there.']);
    expect(splitForSynthesis('   ', 100)).toEqual([]);
  });

  it('cuts at sentence ends and packs sentences into pieces', () => {
    const text = 'One is short. Two is also short. Three follows here. Four ends it.';
    const pieces = splitForSynthesis(text, 35);
    expect(pieces).toEqual(['One is short. Two is also short.', 'Three follows here. Four ends it.']);
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(35);
  });

  it('cuts a long sentence at commas, then at spaces', () => {
    const sentence =
      'First we parse the input, then we validate every field, and finally we write the result to disk';
    const pieces = splitForSynthesis(sentence, 40);
    expect(pieces.join(' ')).toBe(sentence);
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(40);
    const words = 'word '.repeat(40).trim();
    const byWord = splitForSynthesis(words, 30);
    expect(byWord.join(' ')).toBe(words);
    for (const piece of byWord) expect(piece.length).toBeLessThanOrEqual(30);
  });

  it('cuts a single word that is longer than the limit', () => {
    const pieces = splitForSynthesis('x'.repeat(95), 40);
    expect(pieces.map((p) => p.length)).toEqual([40, 40, 15]);
  });

  it('never loses text', () => {
    const text = 'A. '.repeat(50).trim();
    expect(splitForSynthesis(text, 20).join(' ')).toBe(text);
  });
});

describe('ttsPricePerMChars', () => {
  it('knows the paid providers', async () => {
    const { ctx, cleanup } = await makeTestContext();
    expect(ttsPricePerMChars(ctx, 'openai', 'tts-1')).toBe(15);
    expect(ttsPricePerMChars(ctx, 'openai', 'tts-1-hd')).toBe(30);
    expect(ttsPricePerMChars(ctx, 'openai', 'gpt-4o-mini-tts')).toBe(18);
    expect(ttsPricePerMChars(ctx, 'openai', 'gpt-4o-mini-tts-2025-12-15')).toBe(18);
    expect(ttsPricePerMChars(ctx, 'elevenlabs', 'eleven_flash_v2_5')).toBe(40);
    expect(ttsPricePerMChars(ctx, 'elevenlabs', 'eleven_flash_v2')).toBe(40);
    expect(ttsPricePerMChars(ctx, 'elevenlabs', 'eleven_v4')).toBe(80);
    expect(ttsPricePerMChars(ctx, 'elevenlabs', 'eleven_v3')).toBe(80);
    await cleanup();
  });

  it('lets the config override a price', async () => {
    const { ctx, cleanup } = await makeTestContext({
      config: { pricing: { 'openai:tts-1': { kind: 'tts', perMChars: 99 } } },
    });
    expect(ttsPricePerMChars(ctx, 'openai', 'tts-1')).toBe(99);
    expect(ttsCostUsd(ctx, 'openai', 'tts-1', 1_000_000)).toBe(99);
    await cleanup();
  });

  it('assumes the dearest price for an unknown model so budgets stay safe', async () => {
    const { ctx, cleanup } = await makeTestContext();
    expect(ttsPricePerMChars(ctx, 'openai', 'some-future-model')).toBe(30);
    expect(ttsPricePerMChars(ctx, 'elevenlabs', 'some-future-model')).toBe(80);
    await cleanup();
  });

  it('computes cost from characters', async () => {
    const { ctx, cleanup } = await makeTestContext();
    expect(ttsCostUsd(ctx, 'elevenlabs', 'eleven_flash_v2_5', 1350)).toBeCloseTo(0.054, 6);
    await cleanup();
  });
});
