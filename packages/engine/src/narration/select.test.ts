import { describe, expect, it, vi } from 'vitest';
import { MergeStoryError } from '../core/errors.ts';
import type { TtsProvider } from '../core/providers.ts';
import { makeTestContext } from '../testing/narration.ts';
import { createElevenLabsProvider } from './elevenlabs.ts';
import { createKokoroProvider } from './kokoro.ts';
import { createOpenAiProvider } from './openai.ts';
import { createSayProvider } from './say.ts';
import { type ProviderFactories, selectTtsProvider } from './select.ts';
import { createSilentProvider } from './silent.ts';

/** A provider that can or cannot speak, and counts how often it was asked. */
function stub(id: string, available: boolean) {
  const problem = new MergeStoryError('TTS_FAILED', `${id} cannot speak.`, { hint: `Fix ${id}.` });
  const state = { available };
  const asked = vi.fn(async () => (state.available ? null : problem));
  const provider: TtsProvider = {
    id,
    local: id === 'kokoro' || id === 'say',
    speaks: true,
    model: () => null,
    voice: async () => null,
    unavailable: asked,
    synthesize: async () => {
      throw new Error('not used');
    },
    estimateCostUsd: () => 0,
    plannedEgress: async () => [],
  };
  return { provider, asked, problem, state };
}

/** For tests where no install may happen: reaching it fails the test, and it never runs npm. */
const NO_INSTALL = {
  installKokoro: async () => {
    throw new Error('this test reached the Kokoro install');
  },
};

/** An installer that never runs npm: it only makes the kokoro stub available, or fails. */
function installer(onInstall: () => void = () => undefined) {
  return vi.fn(async () => onInstall());
}

function factories(available: Partial<Record<'kokoro' | 'say' | 'openai' | 'elevenlabs', boolean>>) {
  const providers = {
    kokoro: stub('kokoro', available.kokoro ?? false),
    say: stub('say', available.say ?? false),
    openai: stub('openai', available.openai ?? false),
    elevenlabs: stub('elevenlabs', available.elevenlabs ?? false),
  };
  const built = { kokoro: vi.fn(), say: vi.fn(), openai: vi.fn(), elevenlabs: vi.fn(), none: vi.fn() };
  const make = <K extends keyof typeof providers>(id: K) => {
    return () => {
      built[id]();
      return providers[id].provider;
    };
  };
  const table: ProviderFactories = {
    kokoro: make('kokoro'),
    say: make('say'),
    openai: make('openai'),
    elevenlabs: make('elevenlabs'),
    none: () => {
      built.none();
      return createSilentProvider();
    },
  };
  return { providers, built, table };
}

describe('selectTtsProvider: auto', () => {
  it('prefers kokoro when it can speak, and installs nothing', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const { providers, table } = factories({ kokoro: true, say: true });
    const installKokoro = installer();
    expect((await selectTtsProvider(ctx, table, { installKokoro, platform: 'darwin' })).id).toBe('kokoro');
    expect(providers.say.asked).not.toHaveBeenCalled();
    expect(installKokoro).not.toHaveBeenCalled();
    await cleanup();
  });

  it.each(['darwin', 'linux'] as const)(
    'installs a missing kokoro once for English on %s and speaks with it, never with say',
    async (platform) => {
      const { ctx, cleanup } = await makeTestContext();
      const { providers, built, table } = factories({ kokoro: false, say: true });
      const installKokoro = installer(() => {
        providers.kokoro.state.available = true;
      });
      expect((await selectTtsProvider(ctx, table, { installKokoro, platform })).id).toBe('kokoro');
      expect(installKokoro).toHaveBeenCalledTimes(1);
      expect(installKokoro).toHaveBeenCalledWith(ctx);
      expect(built.say).not.toHaveBeenCalled();
      await cleanup();
    },
  );

  it('stops when the install fails, and never falls back to say', async () => {
    const { ctx, cleanup } = await makeTestContext({ config: { language: 'en-US' } });
    const { built, table } = factories({ kokoro: false, say: true });
    const failure = new MergeStoryError(
      'TTS_FAILED',
      'The free Kokoro voice could not be installed: offline',
    );
    const installKokoro = vi.fn(async () => {
      throw failure;
    });
    await expect(selectTtsProvider(ctx, table, { installKokoro, platform: 'darwin' })).rejects.toBe(failure);
    expect(built.say).not.toHaveBeenCalled();
    expect(built.none).not.toHaveBeenCalled();
    await cleanup();
  });

  it('plans with kokoro in a dry run and installs nothing', async () => {
    const { ctx, cleanup } = await makeTestContext({ dryRun: true });
    const { built, table } = factories({ kokoro: false, say: true });
    const installKokoro = installer();
    expect((await selectTtsProvider(ctx, table, { installKokoro, platform: 'linux' })).id).toBe('kokoro');
    expect(installKokoro).not.toHaveBeenCalled();
    expect(built.say).not.toHaveBeenCalled();
    await cleanup();
  });

  it('names the manual install in a dry run on Windows with --tts kokoro', async () => {
    const { ctx, cleanup } = await makeTestContext({ dryRun: true, config: { tts: { provider: 'kokoro' } } });
    const { table } = factories({ kokoro: false });
    const installKokoro = installer();
    const err = (await selectTtsProvider(ctx, table, { installKokoro, platform: 'win32' }).catch(
      (e: unknown) => e,
    )) as MergeStoryError;
    expect(err.code).toBe('TTS_FAILED');
    expect(err.message).toContain('Windows');
    expect(err.hint).toContain('npm ci --ignore-scripts');
    expect(installKokoro).not.toHaveBeenCalled();
    await cleanup();
  });

  it('keeps the old order for other languages and installs nothing: say, then captions only', async () => {
    const { ctx, events, cleanup } = await makeTestContext({ config: { language: 'de' } });
    const installKokoro = installer();
    const withSay = factories({ kokoro: false, say: true });
    expect((await selectTtsProvider(ctx, withSay.table, { installKokoro, platform: 'darwin' })).id).toBe(
      'say',
    );
    const without = factories({});
    expect((await selectTtsProvider(ctx, without.table, { installKokoro, platform: 'linux' })).id).toBe(
      'none',
    );
    expect(installKokoro).not.toHaveBeenCalled();
    const warning = events.find((e) => e.status === 'warn');
    expect(warning?.stage).toBe('narrate');
    expect(warning?.message).toContain('captions but no voice');
    expect(warning?.message).toContain('--tts openai');
    // Kokoro would not help: it speaks English only.
    expect(warning?.message).toContain('English only');
    expect(warning?.message).not.toContain('setup kokoro');
    await cleanup();
  });

  it('keeps the fallback on Windows, installs nothing, and names the manual install', async () => {
    const { ctx, events, cleanup } = await makeTestContext();
    const installKokoro = installer();
    const installed = factories({ kokoro: true });
    expect((await selectTtsProvider(ctx, installed.table, { installKokoro, platform: 'win32' })).id).toBe(
      'kokoro',
    );
    const { table } = factories({});
    expect((await selectTtsProvider(ctx, table, { installKokoro, platform: 'win32' })).id).toBe('none');
    expect(installKokoro).not.toHaveBeenCalled();
    const warning = events.find((e) => e.status === 'warn');
    expect(warning?.message).toContain('captions but no voice');
    expect(warning?.message).toContain('Windows');
    expect(warning?.message).toContain('npm ci --ignore-scripts');
    expect(warning?.message).toContain('--tts openai');
    await cleanup();
  });

  it('never picks a paid provider, even when its key is present', async () => {
    const { ctx, cleanup } = await makeTestContext({
      config: { language: 'fr' },
      secrets: { OPENAI_API_KEY: 'k'.repeat(20), ELEVENLABS_API_KEY: 'k'.repeat(20) },
    });
    const { providers, built, table } = factories({ openai: true, elevenlabs: true });
    expect((await selectTtsProvider(ctx, table, { installKokoro: installer() })).id).toBe('none');
    expect(providers.openai.asked).not.toHaveBeenCalled();
    expect(providers.elevenlabs.asked).not.toHaveBeenCalled();
    expect(built.openai).not.toHaveBeenCalled();
    expect(built.elevenlabs).not.toHaveBeenCalled();
    await cleanup();
  });
});

describe('selectTtsProvider: explicit choice', () => {
  it('uses none without asking anything', async () => {
    const { ctx, cleanup } = await makeTestContext({ config: { tts: { provider: 'none' } } });
    const { providers, table } = factories({ kokoro: true, say: true, openai: true, elevenlabs: true });
    expect((await selectTtsProvider(ctx, table, NO_INSTALL)).id).toBe('none');
    for (const { asked } of Object.values(providers)) expect(asked).not.toHaveBeenCalled();
    await cleanup();
  });

  it.each(['kokoro', 'say', 'openai', 'elevenlabs'] as const)(
    'uses %s as it is when it can speak, and builds no other provider',
    async (id) => {
      const { ctx, cleanup } = await makeTestContext({ config: { tts: { provider: id } } });
      const { providers, built, table } = factories({ [id]: true });
      expect((await selectTtsProvider(ctx, table, NO_INSTALL)).id).toBe(id);
      expect(providers[id].asked).toHaveBeenCalledWith(ctx);
      for (const [other, builder] of Object.entries(built)) {
        expect(builder, other).toHaveBeenCalledTimes(other === id ? 1 : 0);
      }
      await cleanup();
    },
  );

  it.each(['kokoro', 'say', 'openai', 'elevenlabs'] as const)(
    'stops with what %s says when it cannot speak',
    async (id) => {
      const { ctx, cleanup } = await makeTestContext({ config: { tts: { provider: id } } });
      const { providers, table } = factories({});
      // For kokoro the install is tried first; it did not make the voice available.
      const installKokoro = installer();
      await expect(selectTtsProvider(ctx, table, { installKokoro, platform: 'linux' })).rejects.toBe(
        providers[id].problem,
      );
      expect(installKokoro).toHaveBeenCalledTimes(id === 'kokoro' ? 1 : 0);
      await cleanup();
    },
  );

  it('builds real providers for the default selection', async () => {
    const none = await makeTestContext({ config: { tts: { provider: 'none' } } });
    expect((await selectTtsProvider(none.ctx, undefined, NO_INSTALL)).id).toBe('none');
    const openai = await makeTestContext({
      config: { tts: { provider: 'openai' } },
      secrets: { OPENAI_API_KEY: 'k'.repeat(20) },
    });
    const provider = await selectTtsProvider(openai.ctx, undefined, NO_INSTALL);
    expect(provider.id).toBe('openai');
    expect(provider.local).toBe(false);
    expect((await provider.plannedEgress(openai.ctx, 10)).map((e) => e.destination)).toEqual([
      'api.openai.com',
    ]);
    await Promise.all([none.cleanup(), openai.cleanup()]);
  });

  it('installs a missing kokoro when it is chosen, and stops when the install fails', async () => {
    const { ctx, cleanup } = await makeTestContext({ config: { tts: { provider: 'kokoro' } } });
    const { providers, built, table } = factories({ say: true });
    const installKokoro = installer(() => {
      providers.kokoro.state.available = true;
    });
    expect((await selectTtsProvider(ctx, table, { installKokoro, platform: 'linux' })).id).toBe('kokoro');
    expect(installKokoro).toHaveBeenCalledTimes(1);
    providers.kokoro.state.available = false;
    const failure = new MergeStoryError(
      'TTS_FAILED',
      'The free Kokoro voice could not be installed: offline',
    );
    const failing = vi.fn(async () => {
      throw failure;
    });
    await expect(selectTtsProvider(ctx, table, { installKokoro: failing, platform: 'linux' })).rejects.toBe(
      failure,
    );
    expect(built.say).not.toHaveBeenCalled();
    await cleanup();
  });

  it.each(['say', 'none', 'openai', 'elevenlabs'] as const)(
    'never installs anything for an explicit %s, even when kokoro is missing',
    async (id) => {
      const { ctx, cleanup } = await makeTestContext({ config: { tts: { provider: id } } });
      const { table } = factories({ say: true, openai: true, elevenlabs: true });
      const installKokoro = installer();
      expect((await selectTtsProvider(ctx, table, { installKokoro, platform: 'darwin' })).id).toBe(id);
      expect(installKokoro).not.toHaveBeenCalled();
      await cleanup();
    },
  );
});

/** The rules sit in the providers; these check that selection follows them. */
describe('selectTtsProvider with the real providers', () => {
  const real = (machine: { kokoro: boolean; say: boolean }): ProviderFactories => ({
    kokoro: () => createKokoroProvider({ isInstalled: async () => machine.kokoro }),
    say: () =>
      createSayProvider({ platform: machine.say ? 'darwin' : 'linux', isExecutable: async () => true }),
    openai: () => createOpenAiProvider(),
    elevenlabs: () => createElevenLabsProvider(),
    none: () => createSilentProvider(),
  });
  const rejection = (promise: Promise<unknown>) =>
    promise.catch((e: unknown) => e) as Promise<MergeStoryError>;

  it('skips the English-only kokoro voice for other languages', async () => {
    const { ctx, cleanup } = await makeTestContext({ config: { language: 'de' } });
    expect((await selectTtsProvider(ctx, real({ kokoro: true, say: true }), NO_INSTALL)).id).toBe('say');
    expect((await selectTtsProvider(ctx, real({ kokoro: true, say: false }), NO_INSTALL)).id).toBe('none');
    await cleanup();
  });

  it('refuses an explicit kokoro for a non-English narration language, and installs nothing for it', async () => {
    const french = await makeTestContext({ config: { tts: { provider: 'kokoro' }, language: 'fr' } });
    const installKokoro = installer();
    for (const kokoro of [true, false]) {
      const error = await rejection(
        selectTtsProvider(french.ctx, real({ kokoro, say: false }), { installKokoro, platform: 'linux' }),
      );
      expect(error.code).toBe('CONFIG_INVALID');
      expect(error.message).toContain('English');
    }
    expect(installKokoro).not.toHaveBeenCalled();
    await french.cleanup();
  });

  it('installs an explicit kokoro that is missing, then uses it', async () => {
    const missing = await makeTestContext({ config: { tts: { provider: 'kokoro' } } });
    const machine = { kokoro: false, say: false };
    const installKokoro = installer(() => {
      machine.kokoro = true;
    });
    expect(
      (await selectTtsProvider(missing.ctx, real(machine), { installKokoro, platform: 'linux' })).id,
    ).toBe('kokoro');
    expect(installKokoro).toHaveBeenCalledTimes(1);
    // An install that did not take stops with the provider's own reason.
    machine.kokoro = false;
    const error = await rejection(
      selectTtsProvider(missing.ctx, real(machine), { installKokoro: installer(), platform: 'linux' }),
    );
    expect(error.code).toBe('TTS_FAILED');
    expect(error.message).toContain('not installed');
    await missing.cleanup();
  });

  it('refuses an explicit say where it does not exist', async () => {
    const { ctx, cleanup } = await makeTestContext({ config: { tts: { provider: 'say' } } });
    expect((await selectTtsProvider(ctx, real({ kokoro: false, say: true }), NO_INSTALL)).id).toBe('say');
    const error = await rejection(selectTtsProvider(ctx, real({ kokoro: true, say: false }), NO_INSTALL));
    expect(error.code).toBe('TTS_FAILED');
    expect(error.message).toContain('macOS');
    await cleanup();
  });

  it.each([
    ['openai', 'OPENAI_API_KEY'],
    ['elevenlabs', 'ELEVENLABS_API_KEY'],
  ] as const)('requires the key for %s and says which variable to set', async (id, keyName) => {
    const without = await makeTestContext({ config: { tts: { provider: id } } });
    const error = await rejection(
      selectTtsProvider(without.ctx, real({ kokoro: false, say: false }), NO_INSTALL),
    );
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toContain(keyName);
    expect(error.hint).toContain(keyName);
    const withKey = await makeTestContext({
      config: { tts: { provider: id } },
      secrets: { [keyName]: 'k'.repeat(20) },
    });
    expect((await selectTtsProvider(withKey.ctx, real({ kokoro: false, say: false }), NO_INSTALL)).id).toBe(
      id,
    );
    await Promise.all([without.cleanup(), withKey.cleanup()]);
  });
});
