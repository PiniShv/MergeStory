import { mkdir, open, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MergeStoryError } from '../core/errors.ts';
import { makeTestContext, mockFetch } from '../testing/narration.ts';
import { createKokoroProvider, KOKORO_VOICES, type KokoroRuntime } from './kokoro.ts';
import { kokoroModelDir, kokoroModelFiles } from './kokoro-model.ts';
import { decodeWavToMono } from './wav.ts';

/** A runtime that speaks 80 ms per character and records what it was asked. */
function fakeRuntime(options: { secondsPerChar?: number } = {}) {
  const calls: { text: string; voice: string; speed: number }[] = [];
  const runtime: KokoroRuntime = {
    async generate(text, voice, speed) {
      calls.push({ text, voice, speed });
      const rate = 24_000;
      const samples = new Float32Array(Math.round(text.length * (options.secondsPerChar ?? 0.08) * rate));
      for (let i = 0; i < samples.length; i++) samples[i] = 0.2 * Math.sin((2 * Math.PI * 200 * i) / rate);
      return { samples, sampleRate: rate };
    },
  };
  return { runtime, calls };
}

const request = (
  text: string,
  extra: Partial<{ voice: string | null; language: string; speed: number }> = {},
) => ({
  text,
  voice: 'af_heart' as string | null,
  language: 'en',
  speed: 1,
  ...extra,
});

describe('kokoro provider', () => {
  it('is a free local provider with the best-graded voice as the default', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const provider = createKokoroProvider({ platform: 'darwin', arch: 'arm64', env: {} });
    expect(provider.id).toBe('kokoro');
    expect(provider.local).toBe(true);
    expect(await provider.voice(ctx)).toBe('af_heart');
    expect(provider.model(ctx)).toBe('Kokoro-82M-v1.0-fp32');
    expect(createKokoroProvider({ platform: 'linux', arch: 'x64', env: {} }).model(ctx)).toBe(
      'Kokoro-82M-v1.0-q8',
    );
    expect(
      createKokoroProvider({
        platform: 'darwin',
        arch: 'arm64',
        env: { MERGESTORY_KOKORO_DTYPE: 'q8' },
      }).model(ctx),
    ).toBe('Kokoro-82M-v1.0-q8');
    await cleanup();
  });

  it('speaks with the configured voice, and the model that is loaded is not a setting', async () => {
    const { ctx, cleanup } = await makeTestContext({ config: { tts: { voice: 'bf_emma', model: 'tts-1' } } });
    const provider = createKokoroProvider({ platform: 'darwin', arch: 'arm64', env: {} });
    expect(await provider.voice(ctx)).toBe('bf_emma');
    expect(provider.model(ctx)).toBe('Kokoro-82M-v1.0-fp32');
    await cleanup();
  });

  it('plans the one-time package and model downloads, with nothing of the change in them', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const provider = createKokoroProvider({ platform: 'linux', arch: 'x64', env: {} });
    expect(await provider.plannedEgress(ctx, 1000)).toEqual([
      {
        destination: 'registry.npmjs.org',
        purpose: 'voice package download (first run only)',
        bytes: 0,
        contains: [],
      },
      {
        destination: 'huggingface.co',
        purpose: 'voice model download (first run only)',
        bytes: 0,
        contains: [],
      },
    ]);
    await cleanup();
  });

  it('plans the one-time model download, and nothing once the model is on disk', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const provider = createKokoroProvider({
      platform: 'linux',
      arch: 'x64',
      env: {},
      isInstalled: async () => true,
    });
    expect(await provider.plannedEgress(ctx, 1000)).toEqual([
      {
        destination: 'huggingface.co',
        purpose: 'voice model download (first run only)',
        bytes: 0,
        contains: [],
      },
    ]);
    // Files of the right size, without the disk space: the check does not read them.
    for (const file of kokoroModelFiles('q8')) {
      const target = join(kokoroModelDir(ctx.home.models), file.path);
      await mkdir(dirname(target), { recursive: true });
      const handle = await open(target, 'w');
      await handle.truncate(file.bytes);
      await handle.close();
    }
    expect(await provider.plannedEgress(ctx, 1000)).toEqual([]);
    await cleanup();
  });

  it('lists the 28 English voices', () => {
    expect(KOKORO_VOICES).toHaveLength(28);
    expect(new Set(KOKORO_VOICES).size).toBe(28);
    expect(KOKORO_VOICES.every((v) => /^[ab][fm]_[a-z]+$/.test(v))).toBe(true);
  });

  it('is unavailable until the plugin is installed, and says how to install it', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const missing = await createKokoroProvider().unavailable(ctx);
    expect(missing).toMatchObject({ code: 'TTS_FAILED', message: 'The Kokoro voice is not installed.' });
    expect(missing?.hint).toContain('mergestory setup kokoro');
    expect(await createKokoroProvider({ isInstalled: async () => true }).unavailable(ctx)).toBeNull();
    await cleanup();
  });

  it('is unavailable for a narration language other than English, even when it is installed', async () => {
    const installed = createKokoroProvider({ isInstalled: async () => true });
    for (const language of ['en', 'en-GB', 'en_US']) {
      const { ctx, cleanup } = await makeTestContext({ config: { language } });
      expect(await installed.unavailable(ctx), language).toBeNull();
      await cleanup();
    }
    for (const language of ['fr', 'de-DE', 'english']) {
      const { ctx, cleanup } = await makeTestContext({ config: { language } });
      const problem = await installed.unavailable(ctx);
      expect(problem, language).toMatchObject({
        code: 'CONFIG_INVALID',
        message: 'The Kokoro voice only speaks English.',
      });
      expect(problem?.hint, language).toContain(`"${language}"`);
      await cleanup();
    }
  });

  it('tells the user how to install the plugin when it is missing', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const error = (await createKokoroProvider()
      .synthesize(request('Hello there.'), ctx)
      .catch((e: unknown) => e)) as MergeStoryError;
    expect(error.code).toBe('TTS_FAILED');
    expect(error.hint).toContain('mergestory setup kokoro');
    await cleanup();
  });

  it('reports a plugin that is installed but cannot be loaded, before downloading anything', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const dir = join(ctx.home.home, 'plugins', 'node_modules');
    await mkdir(join(dir, 'kokoro-js'), { recursive: true });
    await mkdir(join(dir, '@huggingface', 'transformers'), { recursive: true });
    await writeFile(
      join(dir, 'kokoro-js', 'package.json'),
      JSON.stringify({ name: 'kokoro-js', version: '1.2.1' }),
    );
    await writeFile(
      join(dir, '@huggingface', 'transformers', 'package.json'),
      JSON.stringify({ name: '@huggingface/transformers', version: '3.8.1' }),
    );
    await writeFile(
      join(dir, '..', 'mergestory-kokoro-installed.json'),
      JSON.stringify({ version: '1.2.1' }),
    );
    const mock = mockFetch(() => new Response('should not be asked', { status: 500 }));
    try {
      const error = (await createKokoroProvider()
        .synthesize(request('Hello there.'), ctx)
        .catch((e: unknown) => e)) as MergeStoryError;
      expect(error.code).toBe('TTS_FAILED');
      expect(error.message).toContain('could not be loaded');
      expect(error.hint).toContain('mergestory setup kokoro');
      expect(mock.requests).toHaveLength(0);
    } finally {
      mock.restore();
      await cleanup();
    }
  });

  it('speaks one short line in one call and returns lossless 24 kHz audio', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const { runtime, calls } = fakeRuntime();
    const provider = createKokoroProvider({ load: async () => runtime });
    const result = await provider.synthesize(
      request('Hello there, this is a test.', { voice: 'bf_emma' }),
      ctx,
    );
    expect(calls).toEqual([{ text: 'Hello there, this is a test.', voice: 'bf_emma', speed: 1 }]);
    expect(result.format).toBe('wav');
    expect(result.sampleRate).toBe(24_000);
    expect(result.channels).toBe(1);
    expect(result.characters).toBe('Hello there, this is a test.'.length);
    const decoded = decodeWavToMono(result.audio);
    expect(decoded.sampleRate).toBe(24_000);
    expect(decoded.samples.length).toBe(Math.round(28 * 0.08 * 24_000));
    await cleanup();
  });

  it('uses the default voice when none is given', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const { runtime, calls } = fakeRuntime();
    await createKokoroProvider({ load: async () => runtime }).synthesize(
      request('Hi there.', { voice: null }),
      ctx,
    );
    expect(calls[0]?.voice).toBe('af_heart');
    await cleanup();
  });

  it('clamps the speed to the range the model handles', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const { runtime, calls } = fakeRuntime();
    const provider = createKokoroProvider({ load: async () => runtime });
    for (const speed of [0.1, 0.5, 1.3, 2, 10, -1])
      await provider.synthesize(request('Hi there.', { speed }), ctx);
    expect(calls.map((c) => c.speed)).toEqual([0.5, 0.5, 1.3, 2, 2, 0.5]);
    await cleanup();
  });

  it('splits long text so no call gets more than the model can read, and joins the audio with pauses', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const { runtime, calls } = fakeRuntime({ secondsPerChar: 0.04 });
    const provider = createKokoroProvider({ load: async () => runtime });
    const text = 'This sentence is long enough to need company when the text is split. '.repeat(12).trim();
    const result = await provider.synthesize(request(text), ctx);
    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) expect(call.text.length).toBeLessThanOrEqual(280);
    expect(calls.map((c) => c.text).join(' ')).toBe(text);
    const seconds = decodeWavToMono(result.audio).samples.length / 24_000;
    const spoken = (text.length * 0.04) as number;
    // Each piece keeps a little edge silence and pieces are separated by a pause.
    expect(seconds).toBeGreaterThan(spoken * 0.9);
    expect(seconds).toBeLessThan(spoken + calls.length * 0.3);
    await cleanup();
  });

  it('refuses a result that is too short for its text, because the model cuts off silently', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const { runtime } = fakeRuntime({ secondsPerChar: 0.001 });
    const error = (await createKokoroProvider({ load: async () => runtime })
      .synthesize(request('A line of narration that should take a few seconds.'), ctx)
      .catch((e: unknown) => e)) as MergeStoryError;
    expect(error.code).toBe('TTS_FAILED');
    expect(error.message).toContain('less audio');
    await cleanup();
  });

  it('skips pieces that are only punctuation', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const { runtime, calls } = fakeRuntime();
    await createKokoroProvider({ load: async () => runtime })
      .synthesize(request('...'), ctx)
      .catch(() => undefined);
    expect(calls).toHaveLength(0);
    await cleanup();
  });

  it('only speaks English', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const { runtime, calls } = fakeRuntime();
    const provider = createKokoroProvider({ load: async () => runtime });
    const error = (await provider
      .synthesize(request('Bonjour.', { language: 'fr' }), ctx)
      .catch((e: unknown) => e)) as MergeStoryError;
    expect(error.code).toBe('CONFIG_INVALID');
    expect(calls).toHaveLength(0);
    await provider.synthesize(request('Hello.', { language: 'en-GB' }), ctx);
    expect(calls).toHaveLength(1);
    await cleanup();
  });

  it('rejects a voice that kokoro-js does not know, before loading the model', async () => {
    const { ctx, cleanup } = await makeTestContext();
    let loaded = false;
    const provider = createKokoroProvider({
      load: async () => {
        loaded = true;
        return fakeRuntime().runtime;
      },
    });
    const error = (await provider
      .synthesize(request('Hello.', { voice: 'jf_alpha' }), ctx)
      .catch((e: unknown) => e)) as MergeStoryError;
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.hint).toContain('af_heart');
    expect(loaded).toBe(false);
    await cleanup();
  });

  it('stops between pieces when the run is cancelled', async () => {
    const controller = new AbortController();
    const { ctx, cleanup } = await makeTestContext({ signal: controller.signal });
    const calls: string[] = [];
    const runtime: KokoroRuntime = {
      async generate(text) {
        calls.push(text);
        controller.abort();
        return { samples: new Float32Array(24_000 * 20).fill(0.2), sampleRate: 24_000 };
      },
    };
    const text = 'This sentence is long enough to need company when the text is split. '.repeat(12).trim();
    const error = (await createKokoroProvider({ load: async () => runtime })
      .synthesize(request(text), ctx)
      .catch((e: unknown) => e)) as MergeStoryError;
    expect(error.code).toBe('ABORTED');
    expect(calls).toHaveLength(1);
    await cleanup();
  });

  it('costs nothing', async () => {
    const { ctx, cleanup } = await makeTestContext();
    expect(createKokoroProvider().estimateCostUsd(10_000, ctx)).toBe(0);
    await cleanup();
  });
});
