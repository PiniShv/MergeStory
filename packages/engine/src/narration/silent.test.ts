import { describe, expect, it } from 'vitest';
import { makeStoryboard, makeTestContext } from '../testing/narration.ts';
import { estimateNarrationCost, synthesizeNarration } from './index.ts';
import { createSilentProvider } from './silent.ts';

describe('silent provider', () => {
  const provider = createSilentProvider();

  it('is free, local and always available', async () => {
    const { ctx, cleanup } = await makeTestContext();
    expect(provider.id).toBe('none');
    expect(provider.local).toBe(true);
    expect(await provider.unavailable(ctx)).toBeNull();
    expect(provider.model(ctx)).toBeNull();
    expect(await provider.voice(ctx)).toBeNull();
    expect(provider.estimateCostUsd(10_000, ctx)).toBe(0);
    expect(await provider.plannedEgress(ctx, 10_000)).toEqual([]);
    await cleanup();
  });

  it('is the only provider that does not speak, and refuses a direct call', async () => {
    const { ctx, cleanup } = await makeTestContext();
    expect(provider.speaks).toBe(false);
    await expect(
      provider.synthesize({ text: 'one two', voice: null, language: 'en', speed: 1 }, ctx),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
    await cleanup();
  });
});

describe('narration without a voice', () => {
  it('gives every line an estimated duration and no audio file', async () => {
    const { ctx, events, cleanup } = await makeTestContext();
    const storyboard = makeStoryboard({
      s1: ['This pull request adds retry logic to the weather client.', 'It is small.'],
      s2: ['Done.'],
    });
    const result = await synthesizeNarration(storyboard, createSilentProvider(), ctx);
    expect(result.provider).toBe('none');
    expect(result.voice).toBeNull();
    expect(result.clips).toHaveLength(3);
    for (const clip of result.clips) {
      expect(clip.audioPath).toBeNull();
      expect(clip.cached).toBe(false);
    }
    expect(result.clips[0]?.durationSec).toBeCloseTo(10 / 2.5 + 0.25, 3);
    expect(result.clips[1]?.durationSec).toBeCloseTo(3 / 2.5 + 0.25, 3);
    expect(result.clips[2]?.durationSec).toBeCloseTo(1 / 2.5 + 0.25, 3);
    expect(events.some((e) => e.stage === 'narrate' && e.status === 'skip')).toBe(true);
    await cleanup();
  });

  it('estimates zero characters of cost', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const storyboard = makeStoryboard({ s1: ['Hello there.'] });
    expect(estimateNarrationCost(storyboard, createSilentProvider(), ctx)).toEqual({
      characters: 12,
      costUsd: 0,
    });
    await cleanup();
  });
});
