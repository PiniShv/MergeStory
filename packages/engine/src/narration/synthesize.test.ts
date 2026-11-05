import { readdir, readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunContext } from '../core/context.ts';
import type { MergeStoryError } from '../core/errors.ts';
import type { TtsProvider, TtsRequest, TtsResult } from '../core/providers.ts';
import { FakeTts, MemoryCache, makeStoryboard, makeTestContext } from '../testing/narration.ts';
import { measureSpeechRmsDb } from './audio.ts';
import { estimateNarrationCost, synthesizeNarration } from './index.ts';
import { encodeWavPcm16, readCanonicalWav, wavDurationSec } from './wav.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readClip(path: string | null): Promise<{ samples: Int16Array; seconds: number }> {
  const bytes = await readFile(path as string);
  return { samples: readCanonicalWav(bytes), seconds: wavDurationSec(bytes) };
}

describe('synthesizeNarration', () => {
  it('writes one finished clip per line into the run folder', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const storyboard = makeStoryboard({
      s1: ['This pull request adds retry logic.', 'Failed requests now back off.'],
      s2: ['The timeout is configurable.'],
    });
    const provider = new FakeTts();
    const result = await synthesizeNarration(storyboard, provider, ctx);
    expect(result.provider).toBe('fake');
    expect(result.voice).toBe('fake-voice');
    expect(result.clips.map((c) => [c.sceneId, c.beatIndex])).toEqual([
      ['s1', 0],
      ['s1', 1],
      ['s2', 0],
    ]);
    expect(await readdir(`${ctx.runDir}/narration`)).toEqual(['s1-0.wav', 's1-1.wav', 's2-0.wav']);
    for (const clip of result.clips) {
      expect(clip.cached).toBe(false);
      expect(clip.audioPath).toBe(`${ctx.runDir}/narration/${clip.sceneId}-${clip.beatIndex}.wav`);
      const { samples, seconds } = await readClip(clip.audioPath);
      expect(samples.length).toBeGreaterThan(0);
      expect(clip.durationSec).toBeCloseTo(seconds, 3);
    }
    expect(provider.calls).toHaveLength(3);
    expect(provider.calls[0]).toEqual({
      text: 'This pull request adds retry logic.',
      voice: 'fake-voice',
      language: 'en',
      speed: 1,
    });
    await cleanup();
  });

  it('keeps the caption text as written and sends the spoken form to the voice', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const storyboard = makeStoryboard({
      s1: ['Calls `fetchWithRetry` in src/weather/client.ts, e.g. after 340ms.'],
    });
    const provider = new FakeTts();
    const { clips } = await synthesizeNarration(storyboard, provider, ctx);
    expect(clips[0]?.text).toBe('Calls `fetchWithRetry` in src/weather/client.ts, e.g. after 340ms.');
    expect(clips[0]?.spokenText).toBe(
      'Calls fetch With Retry in the client file, for example after 340 milliseconds.',
    );
    expect(provider.calls[0]?.text).toBe(clips[0]?.spokenText);
    await cleanup();
  });

  it('trims silence to 60 ms and brings every voice to the same level', async () => {
    const quiet = await makeTestContext();
    const loud = await makeTestContext();
    const storyboard = makeStoryboard({ s1: ['one two three four'] });
    const a = await synthesizeNarration(storyboard, new FakeTts({ amplitude: 0.02 }), quiet.ctx);
    const b = await synthesizeNarration(storyboard, new FakeTts({ amplitude: 0.8 }), loud.ctx);
    for (const result of [a, b]) {
      const { samples, seconds } = await readClip(result.clips[0]?.audioPath ?? null);
      // 4 words x 0.3 s of tone plus 60 ms before and after.
      expect(seconds).toBeGreaterThan(1.2 + 0.11);
      expect(seconds).toBeLessThan(1.2 + 0.13);
      expect(
        measureSpeechRmsDb(
          Float32Array.from(samples, (v) => v / 32768),
          48_000,
        ),
      ).toBeCloseTo(-18, 0);
      let peak = 0;
      for (const s of samples) peak = Math.max(peak, Math.abs(s));
      expect(peak).toBeLessThanOrEqual(Math.ceil(0.8913 * 32767));
    }
    await Promise.all([quiet.cleanup(), loud.cleanup()]);
  });

  it('does not synthesize again when the text, voice and provider are unchanged', async () => {
    const cache = new MemoryCache();
    const first = await makeTestContext({ cache });
    const second = await makeTestContext({ cache });
    const storyboard = makeStoryboard({ s1: ['First line of narration.', 'Second line of narration.'] });
    const provider = new FakeTts();
    const run1 = await synthesizeNarration(storyboard, provider, first.ctx);
    expect(provider.calls).toHaveLength(2);
    expect(cache.puts).toBe(2);
    const run2 = await synthesizeNarration(storyboard, provider, second.ctx);
    expect(provider.calls).toHaveLength(2);
    expect(cache.puts).toBe(2);
    expect(run2.clips.every((c) => c.cached)).toBe(true);
    expect(run2.clips.map((c) => c.durationSec)).toEqual(run1.clips.map((c) => c.durationSec));
    // The cached clips are copied into the new run folder.
    expect(await readdir(`${second.ctx.runDir}/narration`)).toEqual(['s1-0.wav', 's1-1.wav']);
    expect(await readFile(run2.clips[0]?.audioPath as string)).toEqual(
      await readFile(run1.clips[0]?.audioPath as string),
    );
    await Promise.all([first.cleanup(), second.cleanup()]);
  });

  it('uses the cache for a part of the lines and synthesizes the new ones', async () => {
    const cache = new MemoryCache();
    const first = await makeTestContext({ cache });
    const second = await makeTestContext({ cache });
    const provider = new FakeTts();
    await synthesizeNarration(makeStoryboard({ s1: ['Line one.', 'Line two.'] }), provider, first.ctx);
    const result = await synthesizeNarration(
      makeStoryboard({ s1: ['Line one.', 'A brand new line.'] }),
      provider,
      second.ctx,
    );
    expect(provider.calls.map((c) => c.text)).toEqual(['Line one.', 'Line two.', 'A brand new line.']);
    expect(result.clips.map((c) => c.cached)).toEqual([true, false]);
    await Promise.all([first.cleanup(), second.cleanup()]);
  });

  it('synthesizes repeated lines only once', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const provider = new FakeTts();
    const { clips } = await synthesizeNarration(
      makeStoryboard({ s1: ['Same words.', 'Same words.'], s2: ['Same words.'] }),
      provider,
      ctx,
    );
    expect(provider.calls).toHaveLength(1);
    expect(clips.map((c) => c.cached)).toEqual([false, true, true]);
    expect(new Set(clips.map((c) => c.audioPath)).size).toBe(3);
    await cleanup();
  });

  it('keeps going when the cache cannot be written', async () => {
    const cache = new MemoryCache();
    cache.put = async () => {
      throw new Error('disk full');
    };
    const { ctx, cleanup } = await makeTestContext({ cache });
    const { clips } = await synthesizeNarration(makeStoryboard({ s1: ['Line one.'] }), new FakeTts(), ctx);
    expect(clips[0]?.audioPath).toBeTruthy();
    await cleanup();
  });

  it('does not reuse clips across voices, models, speeds, languages or providers', async () => {
    const cache = new MemoryCache();
    const storyboard = makeStoryboard({ s1: ['Same line.'] });
    const provider = new FakeTts();
    const variants = [
      {},
      { tts: { voice: 'other' } },
      { tts: { model: 'other-model' } },
      { tts: { speed: 1.25 } },
      { language: 'fr' },
    ];
    for (const config of variants) {
      const { ctx, cleanup } = await makeTestContext({ cache, config });
      await synthesizeNarration(storyboard, provider, ctx);
      await cleanup();
    }
    expect(provider.calls).toHaveLength(variants.length);
    const { ctx, cleanup } = await makeTestContext({ cache });
    await synthesizeNarration(storyboard, new FakeTts({ id: 'another' }), ctx);
    expect(cache.puts).toBe(variants.length + 1);
    await cleanup();
  });

  it('ignores a damaged cache entry and synthesizes again', async () => {
    const cache = new MemoryCache();
    const provider = new FakeTts();
    const storyboard = makeStoryboard({ s1: ['Line one.'] });
    const first = await makeTestContext({ cache });
    await synthesizeNarration(storyboard, provider, first.ctx);
    for (const key of cache.store.keys()) cache.store.set(key, Buffer.from('not audio'));
    const second = await makeTestContext({ cache });
    const result = await synthesizeNarration(storyboard, provider, second.ctx);
    expect(provider.calls).toHaveLength(2);
    expect(result.clips[0]?.cached).toBe(false);
    await Promise.all([first.cleanup(), second.cleanup()]);
  });

  it('speaks with the voice the provider names for this run, and tells the voice and the model apart in the cache', async () => {
    class MachineTts extends FakeTts {
      override async voice(ctx: RunContext): Promise<string | null> {
        return ctx.config.tts.voice || 'machine-voice';
      }
    }
    const cache = new MemoryCache();
    const plain = await makeTestContext({ cache });
    const provider = new MachineTts();
    const result = await synthesizeNarration(makeStoryboard({ s1: ['Hi there.'] }), provider, plain.ctx);
    expect(result.voice).toBe('machine-voice');
    expect(provider.calls[0]?.voice).toBe('machine-voice');
    const configured = await makeTestContext({ cache, config: { tts: { voice: 'my-voice' } } });
    const second = await synthesizeNarration(makeStoryboard({ s1: ['Hi there.'] }), provider, configured.ctx);
    expect(second.voice).toBe('my-voice');
    expect(provider.calls.map((call) => call.voice)).toEqual(['machine-voice', 'my-voice']);
    await Promise.all([plain.cleanup(), configured.cleanup()]);
  });

  it('has no voice to name for a provider without one', async () => {
    const { ctx, cleanup } = await makeTestContext();
    class VoicelessTts extends FakeTts {
      override async voice(): Promise<string | null> {
        return null;
      }
    }
    const provider = new VoicelessTts();
    const result = await synthesizeNarration(makeStoryboard({ s1: ['Hi there.'] }), provider, ctx);
    expect(result.voice).toBeNull();
    expect(provider.calls[0]?.voice).toBeNull();
    await cleanup();
  });

  it('does not speak lines with nothing to say', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const provider = new FakeTts();
    const { clips } = await synthesizeNarration(
      makeStoryboard({ s1: ['...', 'Real words here.', '—'] }),
      provider,
      ctx,
    );
    expect(provider.calls).toHaveLength(1);
    expect(clips.map((c) => c.audioPath === null)).toEqual([true, false, true]);
    expect(clips[0]?.durationSec).toBeCloseTo(0.25, 3);
    await cleanup();
  });

  it('masks secrets before they are spoken or shown', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const key = `sk-ant-${'a1B2c3D4'.repeat(4)}`;
    const provider = new FakeTts();
    const { clips } = await synthesizeNarration(
      makeStoryboard({ s1: [`The key ${key} was committed.`] }),
      provider,
      ctx,
    );
    expect(provider.calls[0]?.text).not.toContain('sk-ant');
    expect(provider.calls[0]?.text).toBe('The key a hidden value was committed.');
    expect(clips[0]?.text).not.toContain('sk-ant');
    await cleanup();
  });

  it('keeps clip files inside the narration folder whatever the scene id looks like', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const { clips } = await synthesizeNarration(
      makeStoryboard({ '../../evil': ['One.'], 'a/b': ['Two.'] }),
      new FakeTts(),
      ctx,
    );
    for (const clip of clips) {
      expect(clip.audioPath?.startsWith(`${ctx.runDir}/narration/`)).toBe(true);
      expect(basename(clip.audioPath as string)).toMatch(/^[A-Za-z0-9_-]+\.wav$/);
    }
    expect(new Set(clips.map((c) => c.audioPath)).size).toBe(2);
    await cleanup();
  });

  it('uses the plain markup-only text rules for other languages', async () => {
    const { ctx, cleanup } = await makeTestContext({ config: { language: 'de' } });
    const provider = new FakeTts();
    const { clips } = await synthesizeNarration(
      makeStoryboard({ s1: ['**Hallo** z.B. 340ms'] }),
      provider,
      ctx,
    );
    expect(clips[0]?.spokenText).toBe('Hallo z.B. 340ms');
    await cleanup();
  });

  it('records free usage for a local provider', async () => {
    const { ctx, cleanup } = await makeTestContext();
    await synthesizeNarration(makeStoryboard({ s1: ['Twelve chars.', 'Another one.'] }), new FakeTts(), ctx);
    expect(ctx.cost.report().records).toEqual([
      { provider: 'fake', kind: 'tts', model: 'fake-model', characters: 25, costUsd: 0, estimated: false },
    ]);
    await cleanup();
  });
});

describe('synthesizeNarration: paid providers', () => {
  it('stops before any call when the whole batch would go over budget', async () => {
    const { ctx, cleanup } = await makeTestContext({ config: { budgetUsd: 0.05 } });
    const provider = new FakeTts({ local: false, pricePerChar: 0.01 });
    const error = (await synthesizeNarration(
      makeStoryboard({ s1: ['Line number one.', 'Line number two.'] }),
      provider,
      ctx,
    ).catch((e: unknown) => e)) as MergeStoryError;
    expect(error.code).toBe('BUDGET_EXCEEDED');
    expect(provider.calls).toHaveLength(0);
    await cleanup();
  });

  it('only counts lines that are not cached against the budget', async () => {
    const cache = new MemoryCache();
    const provider = new FakeTts({ local: false, pricePerChar: 0.001 });
    const storyboard = makeStoryboard({ s1: ['Line number one.', 'Line number two.'] });
    const first = await makeTestContext({ cache, config: { budgetUsd: 1 } });
    await synthesizeNarration(storyboard, provider, first.ctx);
    const second = await makeTestContext({ cache, config: { budgetUsd: 0.0001 } });
    const result = await synthesizeNarration(storyboard, provider, second.ctx);
    expect(result.clips.every((c) => c.cached)).toBe(true);
    expect(provider.calls).toHaveLength(2);
    await Promise.all([first.cleanup(), second.cleanup()]);
  });

  it('reports lines served from the cache as free usage', async () => {
    const cache = new MemoryCache();
    const provider = new FakeTts({ local: false, pricePerChar: 0.001 });
    const storyboard = makeStoryboard({ s1: ['Line number one.'] });
    const first = await makeTestContext({ cache });
    await synthesizeNarration(storyboard, provider, first.ctx);
    const second = await makeTestContext({ cache });
    await synthesizeNarration(storyboard, provider, second.ctx);
    expect(second.ctx.cost.report().records).toEqual([
      {
        provider: 'fake',
        kind: 'tts',
        model: 'fake-model',
        characters: 16,
        costUsd: 0,
        estimated: false,
        cached: true,
      },
    ]);
    await Promise.all([first.cleanup(), second.cleanup()]);
  });

  it('does not call a paid provider in a dry run', async () => {
    const { ctx, events, cleanup } = await makeTestContext({ dryRun: true });
    const provider = new FakeTts({ local: false, pricePerChar: 0.01 });
    const result = await synthesizeNarration(makeStoryboard({ s1: ['One line here.'] }), provider, ctx);
    expect(provider.calls).toHaveLength(0);
    expect(result.clips[0]?.audioPath).toBeNull();
    expect(result.clips[0]?.durationSec).toBeCloseTo(3 / 2.5 + 0.25, 3);
    expect(events.some((e) => e.status === 'skip')).toBe(true);
    await cleanup();
  });

  it('runs up to four requests at once for remote providers and one at a time for local ones', async () => {
    const measure = async (local: boolean): Promise<number> => {
      const { ctx, cleanup } = await makeTestContext();
      const inner = new FakeTts({ local });
      let running = 0;
      let peak = 0;
      const provider: TtsProvider = {
        id: inner.id,
        local: inner.local,
        speaks: true,
        model: (c) => inner.model(c),
        voice: (c) => inner.voice(c),
        unavailable: () => inner.unavailable(),
        estimateCostUsd: () => 0,
        plannedEgress: (c, characters) => inner.plannedEgress(c, characters),
        async synthesize(request: TtsRequest, c): Promise<TtsResult> {
          running++;
          peak = Math.max(peak, running);
          await sleep(15);
          const result = await inner.synthesize(request, c);
          running--;
          return result;
        },
      };
      const lines = Array.from({ length: 10 }, (_, i) => `Distinct narration line number ${i}.`);
      await synthesizeNarration(makeStoryboard({ s1: lines }), provider, ctx);
      await cleanup();
      return peak;
    };
    expect(await measure(true)).toBe(1);
    expect(await measure(false)).toBe(4);
  });
});

describe('synthesizeNarration: failures', () => {
  it('wraps an unexpected error with a next step and keeps readable errors as they are', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const storyboard = makeStoryboard({ s1: ['Hello there.'] });
    const wrapped = (await synthesizeNarration(
      storyboard,
      new FakeTts({ failWith: new Error('engine exploded') }),
      ctx,
    ).catch((e: unknown) => e)) as MergeStoryError;
    expect(wrapped.code).toBe('TTS_FAILED');
    expect(wrapped.message).toContain('engine exploded');
    expect(wrapped.hint).toContain('--tts');
    const original = new (await import('../core/errors.ts')).MergeStoryError('CONFIG_INVALID', 'bad voice', {
      hint: 'fix it',
    });
    const same = (await synthesizeNarration(storyboard, new FakeTts({ failWith: original }), ctx).catch(
      (e: unknown) => e,
    )) as MergeStoryError;
    expect(same).toBe(original);
    await cleanup();
  });

  it('starts no more lines after one fails, and reports that failure', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const inner = new FakeTts({ local: true });
    const calls: string[] = [];
    const provider: TtsProvider = {
      id: inner.id,
      local: inner.local,
      speaks: true,
      model: (c) => inner.model(c),
      voice: (c) => inner.voice(c),
      unavailable: () => inner.unavailable(),
      estimateCostUsd: () => 0,
      plannedEgress: (c, characters) => inner.plannedEgress(c, characters),
      async synthesize(request: TtsRequest, c): Promise<TtsResult> {
        calls.push(request.text);
        if (calls.length === 2) throw new Error('voice crashed');
        return inner.synthesize(request, c);
      },
    };
    const lines = Array.from({ length: 6 }, (_, i) => `Distinct narration line number ${i}.`);
    const error = (await synthesizeNarration(makeStoryboard({ s1: lines }), provider, ctx).catch(
      (e: unknown) => e,
    )) as MergeStoryError;
    expect(error.code).toBe('TTS_FAILED');
    expect(error.message).toContain('voice crashed');
    expect(calls).toHaveLength(2);
    await cleanup();
  });

  it('fails when the provider returns only silence', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const inner = new FakeTts();
    const silent: TtsProvider = {
      id: 'silent-fake',
      local: inner.local,
      speaks: true,
      model: (c) => inner.model(c),
      voice: (c) => inner.voice(c),
      unavailable: () => inner.unavailable(),
      estimateCostUsd: () => 0,
      plannedEgress: (c, characters) => inner.plannedEgress(c, characters),
      synthesize: async (request) => ({
        audio: encodeWavPcm16(new Int16Array(24_000), 24_000),
        format: 'wav',
        sampleRate: 24_000,
        channels: 1,
        characters: request.text.length,
      }),
    };
    const error = (await synthesizeNarration(makeStoryboard({ s1: ['Hello there.'] }), silent, ctx).catch(
      (e: unknown) => e,
    )) as MergeStoryError;
    expect(error.code).toBe('TTS_FAILED');
    expect(error.message).toContain('silence');
    await cleanup();
  });

  it('stops when the run is cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const { ctx, cleanup } = await makeTestContext({ signal: controller.signal });
    const provider = new FakeTts();
    const error = (await synthesizeNarration(makeStoryboard({ s1: ['One.', 'Two.'] }), provider, ctx).catch(
      (e: unknown) => e,
    )) as MergeStoryError;
    expect(error.code).toBe('ABORTED');
    expect(provider.calls).toHaveLength(0);
    await cleanup();
  });
});

describe('estimateNarrationCost', () => {
  it('counts the characters that would be spoken and prices them', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const storyboard = makeStoryboard({ s1: ['Hello there.', '...'], s2: ['Calls `fetchWithRetry`.'] });
    const provider = new FakeTts({ local: false, pricePerChar: 0.001 });
    const { characters, costUsd } = estimateNarrationCost(storyboard, provider, ctx);
    // "Hello there." = 12 characters, "Calls fetch With Retry." = 23, and "..." is not spoken.
    expect(characters).toBe(35);
    expect(costUsd).toBeCloseTo(0.035, 8);
    await cleanup();
  });
});
