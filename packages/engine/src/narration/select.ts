/**
 * Choosing the speech provider. An explicit choice is used as configured, or reports why it cannot be
 * used. "auto" only picks free local providers. For English that is always the Kokoro voice, which is
 * installed on first use, because the built-in macOS voice is not good enough to be the default. For
 * other languages (Kokoro speaks English only) and on Windows (no automatic install) it is: Kokoro if
 * installed, then macOS say, then none (captions only).
 * What each provider needs is its own rule (see TtsProvider.unavailable).
 */
import type { RunContext } from '../core/context.ts';
import type { TtsProvider } from '../core/providers.ts';
import { createElevenLabsProvider } from './elevenlabs.ts';
import { createKokoroProvider } from './kokoro.ts';
import { ensureKokoroInstalled, kokoroWindowsError } from './kokoro-install.ts';
import { kokoroManualInstall, pluginsDir } from './kokoro-plugin.ts';
import { createOpenAiProvider } from './openai.ts';
import { createSayProvider } from './say.ts';
import { createSilentProvider } from './silent.ts';

export type ProviderId = 'kokoro' | 'say' | 'openai' | 'elevenlabs' | 'none';

/** Providers are built on demand, so a setting that only one of them reads cannot break the others. */
export type ProviderFactories = Record<ProviderId, () => TtsProvider>;

export function defaultProviderFactories(): ProviderFactories {
  return {
    kokoro: () => createKokoroProvider(),
    say: () => createSayProvider(),
    openai: () => createOpenAiProvider(),
    elevenlabs: () => createElevenLabsProvider(),
    none: () => createSilentProvider(),
  };
}

const isEnglish = (language: string): boolean => /^en(?:[-_]|$)/i.test(language);

export interface SelectDeps {
  /** Installs the Kokoro voice when it is missing. Tests pass their own. */
  installKokoro?: (ctx: RunContext) => Promise<void>;
  platform?: NodeJS.Platform;
}

/**
 * The Kokoro voice, installed first when it is missing. A dry run installs nothing: it plans with
 * Kokoro, and its planned transfers name the downloads of the first real run.
 */
async function kokoroInstalledOnDemand(
  ctx: RunContext,
  kokoro: TtsProvider,
  platform: NodeJS.Platform,
  deps: SelectDeps,
): Promise<TtsProvider> {
  const problem = await kokoro.unavailable(ctx);
  if (!problem) return kokoro;
  // Not English: no install helps.
  if (!isEnglish(ctx.config.language)) throw problem;
  if (ctx.dryRun) {
    if (platform === 'win32') throw kokoroWindowsError(ctx);
    return kokoro;
  }
  await (deps.installKokoro ?? ((c: RunContext) => ensureKokoroInstalled(c, { platform })))(ctx);
  const after = await kokoro.unavailable(ctx);
  if (after) throw after;
  return kokoro;
}

/**
 * Pick the speech provider. An explicit provider is used as configured (error if unavailable);
 * an explicit "kokoro" is installed first when it is missing.
 * "auto" only picks free local providers: Kokoro for English (installed when missing), otherwise
 * Kokoro if installed, then macOS say, then none (captions only).
 * Tests pass their own `factories` and `deps`.
 */
export async function selectTtsProvider(
  ctx: RunContext,
  factories: ProviderFactories = defaultProviderFactories(),
  deps: SelectDeps = {},
): Promise<TtsProvider> {
  const choice = ctx.config.tts.provider;
  const platform = deps.platform ?? process.platform;
  const english = isEnglish(ctx.config.language);

  if (choice === 'kokoro' || (choice === 'auto' && english && platform !== 'win32')) {
    return kokoroInstalledOnDemand(ctx, factories.kokoro(), platform, deps);
  }

  if (choice !== 'auto') {
    const provider = factories[choice]();
    const problem = await provider.unavailable(ctx);
    if (problem) throw problem;
    return provider;
  }

  // auto for another language, or on Windows: free local providers that are already there
  const kokoro = factories.kokoro();
  if (!(await kokoro.unavailable(ctx))) return kokoro;
  const say = factories.say();
  if (!(await say.unavailable(ctx))) return say;
  ctx.progress({
    stage: 'narrate',
    status: 'warn',
    message: english
      ? 'No speech engine is available, so the video will have captions but no voice. ' +
        `The free Kokoro voice cannot install itself on Windows yet. ${kokoroManualInstall(pluginsDir(ctx))} ` +
        'Or choose a paid provider with --tts openai or --tts elevenlabs.'
      : 'No speech engine is available, so the video will have captions but no voice. ' +
        `The free Kokoro voice speaks English only. For "${ctx.config.language}", choose a paid provider with --tts openai or --tts elevenlabs.`,
  });
  return factories.none();
}
