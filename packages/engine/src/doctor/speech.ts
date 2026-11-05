/**
 * Checks of the speech: whether a free local voice exists, and whether the chosen provider can speak.
 * The verdict is the one of the provider (TtsProvider.unavailable), the same that a run gets when it
 * chooses the provider; the sentences are the report's own.
 */
import { createElevenLabsProvider } from '../narration/elevenlabs.ts';
import { createKokoroProvider } from '../narration/kokoro.ts';
import { kokoroDownloadMb, kokoroDtype } from '../narration/kokoro-model.ts';
import { KOKORO_PACKAGES_MB, kokoroManualInstall, pluginsDir } from '../narration/kokoro-plugin.ts';
import { createOpenAiProvider } from '../narration/openai.ts';
import { createSayProvider } from '../narration/say.ts';
import { check } from './check.ts';
import type { DoctorCheck, DoctorContext } from './types.ts';

const PAID = {
  openai: { keyName: 'OPENAI_API_KEY', build: () => createOpenAiProvider() },
  elevenlabs: { keyName: 'ELEVENLABS_API_KEY', build: () => createElevenLabsProvider() },
} as const;

/** The key and the host are named, never the value of the key. */
async function checkPaid(provider: keyof typeof PAID, { ctx }: DoctorContext): Promise<DoctorCheck> {
  const { keyName, build } = PAID[provider];
  const speech = build();
  if (await speech.unavailable(ctx)) {
    return check(
      'speech',
      'Speech provider',
      'fail',
      `${provider} selected but ${keyName} is not set`,
      `Set ${keyName} in your environment, or use --tts auto for a free local voice.`,
    );
  }
  const hosts = (await speech.plannedEgress(ctx, 0)).map((record) => record.destination).join(', ');
  return check(
    'speech',
    'Speech provider',
    'pass',
    `${provider}: ${keyName} is set. Narration text is sent to ${hosts}, and each run costs money.`,
  );
}

/** Packages and model together, in megabytes: what the first English run downloads. */
function firstRunMb(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): number {
  let model: number;
  try {
    model = kokoroDownloadMb(kokoroDtype(env, platform));
  } catch {
    model = kokoroDownloadMb(kokoroDtype({}, platform));
  }
  return KOKORO_PACKAGES_MB + model;
}

export async function checkSpeech(c: DoctorContext): Promise<DoctorCheck[]> {
  const { config, ctx, deps } = c;
  let kokoro: { installed: boolean; version: string | null; modelCached: boolean } = {
    installed: false,
    version: null,
    modelCached: false,
  };
  let kokoroNote = '';
  try {
    kokoro = await deps.kokoroStatus(config);
  } catch (err) {
    kokoroNote = ` (could not be checked: ${err instanceof Error ? err.message : String(err)})`;
  }
  // The providers, with the machine as the report finds it.
  const sayVoice = createSayProvider({
    platform: deps.platform,
    isExecutable: async () => (await deps.which('say')) !== null,
  });
  const sayAvailable = (await sayVoice.unavailable(ctx)) === null;
  // Everywhere but Windows, the first English run installs the voice by itself.
  const installsItself = deps.platform !== 'win32';
  const firstRun = `not installed yet; the first English run installs it once (about ${firstRunMb(deps.env, deps.platform)} MB)`;
  const kokoroText = kokoro.installed
    ? `installed${kokoro.version ? ` ${kokoro.version}` : ''}${kokoro.modelCached ? ', model cached' : ', model downloads on first use'}`
    : kokoroNote
      ? `not installed${kokoroNote}`
      : installsItself
        ? firstRun
        : 'not installed, and it cannot install itself on Windows yet';
  const sayText =
    deps.platform === 'darwin' ? (sayAvailable ? 'available' : 'not found') : 'not available on this system';
  const local = kokoro.installed || sayAvailable || installsItself;
  const manual = `${kokoroManualInstall(pluginsDir(ctx))} Without a voice, videos have captions only.`;
  const checks: DoctorCheck[] = [
    check(
      'speech-local',
      'Free local speech',
      local ? 'pass' : 'warn',
      `Kokoro: ${kokoroText}; macOS say: ${sayText}`,
      local ? null : manual,
    ),
  ];

  switch (config.tts.provider) {
    case 'auto':
      checks.push(
        check(
          'speech',
          'Speech provider',
          'pass',
          installsItself
            ? 'auto: the free Kokoro voice for English (installed on the first run); for other languages a free local voice if there is one, otherwise captions only'
            : 'auto: a free local voice if there is one, otherwise captions only',
        ),
      );
      break;
    case 'none':
      checks.push(check('speech', 'Speech provider', 'pass', 'none: videos have captions only'));
      break;
    case 'kokoro': {
      const problem = await createKokoroProvider({ isInstalled: async () => kokoro.installed }).unavailable(
        ctx,
      );
      if (!problem) {
        checks.push(check('speech', 'Speech provider', 'pass', 'kokoro: installed'));
      } else if (problem.code !== 'TTS_FAILED') {
        // A run would refuse it whether or not it is installed (the narration language): in its own words.
        checks.push(check('speech', 'Speech provider', 'fail', problem.message, problem.hint ?? null));
      } else if (installsItself) {
        checks.push(
          check('speech', 'Speech provider', 'pass', `kokoro: ${firstRun.replace(' English', '')}`),
        );
      } else {
        checks.push(
          check('speech', 'Speech provider', 'fail', 'kokoro selected but it is not installed', manual),
        );
      }
      break;
    }
    case 'say':
      checks.push(
        sayAvailable
          ? check('speech', 'Speech provider', 'pass', 'say: available')
          : check(
              'speech',
              'Speech provider',
              'fail',
              'say selected but it is only available on macOS',
              'Use --tts kokoro (free) or --tts none.',
            ),
      );
      break;
    case 'openai':
    case 'elevenlabs':
      checks.push(await checkPaid(config.tts.provider, c));
      break;
  }
  return checks;
}
