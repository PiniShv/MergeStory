/**
 * macOS "say" provider (local, free). Writes a 24 kHz mono 16-bit WAV through /usr/bin/say.
 * The text goes in on standard input, so it never appears in a process list and a line that
 * starts with "-" cannot be read as an option.
 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunContext } from '../core/context.ts';
import { MergeStoryError } from '../core/errors.ts';
import { isExecutable, runCommand } from '../core/process.ts';
import type { TtsProvider, TtsRequest, TtsResult } from '../core/providers.ts';

export const SAY_PATH = '/usr/bin/say';
/** Words per minute at speed 1. */
const BASE_WORDS_PER_MINUTE = 185;
const OUTPUT_RATE = 24_000;

/** Voices that ship with macOS and read English well, best first. Samantha is the compact US voice. */
const KNOWN_ENGLISH_VOICES = ['Samantha', 'Daniel', 'Karen', 'Moira', 'Tessa'];

export interface SayDeps {
  run?: typeof runCommand;
  platform?: NodeJS.Platform;
  sayPath?: string;
  isExecutable?: (path: string) => Promise<boolean>;
}

export interface SayVoice {
  /** Name as listed by `say -v '?'`, for example "Samantha" or "Daniel (English (UK))". */
  name: string;
  /** Locale such as "en_US". */
  locale: string;
}

/** Parse the output of `say -v '?'`. */
export function parseSayVoices(listing: string): SayVoice[] {
  const voices: SayVoice[] = [];
  for (const line of listing.split('\n')) {
    const match = /^(.+?)\s+([A-Za-z]{2,3}[_-][A-Za-z0-9]{2,4})\s+#/.exec(line);
    if (match?.[1] && match[2]) voices.push({ name: match[1].trim(), locale: match[2] });
  }
  return voices;
}

const shortName = (name: string): string =>
  name
    .replace(/\s*\(.*\)\s*$/, '')
    .trim()
    .toLowerCase();

/**
 * Find a voice by the name the user typed. Case does not matter, and the short name ("Daniel")
 * matches the long listing name ("Daniel (English (UK))").
 */
export function findSayVoice(voices: SayVoice[], requested: string): SayVoice | null {
  const wanted = requested.trim().toLowerCase();
  return (
    voices.find((v) => v.name.toLowerCase() === wanted) ??
    voices.find((v) => shortName(v.name) === shortName(requested)) ??
    null
  );
}

/**
 * Best voice for a language when none is configured: a downloaded Premium or Enhanced voice
 * first, then a known good built-in voice. Null means "let the system choose".
 */
export function pickDefaultSayVoice(voices: SayVoice[], language: string): string | null {
  const lang = (language.split(/[-_]/)[0] ?? 'en').toLowerCase();
  const matching = voices.filter(
    (v) => v.locale.toLowerCase().startsWith(`${lang}_`) || v.locale.toLowerCase().startsWith(`${lang}-`),
  );
  if (matching.length === 0) return null;
  const premium = matching.find((v) => /\(premium\)/i.test(v.name));
  if (premium) return premium.name;
  const enhanced = matching.find((v) => /\(enhanced\)/i.test(v.name));
  if (enhanced) return enhanced.name;
  if (lang === 'en') {
    for (const name of KNOWN_ENGLISH_VOICES) {
      const found = matching.find((v) => shortName(v.name) === name.toLowerCase());
      if (found) return found.name;
    }
    return null;
  }
  return matching[0]?.name ?? null;
}

export function createSayProvider(deps: SayDeps = {}): TtsProvider {
  const run = deps.run ?? runCommand;
  const platform = deps.platform ?? process.platform;
  const sayPath = deps.sayPath ?? SAY_PATH;
  const executable = deps.isExecutable ?? isExecutable;
  let voiceList: Promise<SayVoice[]> | null = null;

  const listVoices = (ctx: RunContext): Promise<SayVoice[]> => {
    voiceList ??= run(sayPath, ['-v', '?'], {
      allowFailure: true,
      timeoutMs: 15_000,
      signal: ctx.signal,
    }).then(
      (result) => (result.code === 0 ? parseSayVoices(result.stdout) : []),
      () => [],
    );
    return voiceList;
  };

  const validName = (name: string): string => {
    if (name.startsWith('-') || name.includes('\n')) {
      throw new MergeStoryError('CONFIG_INVALID', 'The macOS voice name is not valid.', {
        hint: "Run `say -v '?'` to list voices and copy a name into tts.voice.",
      });
    }
    return name;
  };

  return {
    id: 'say',
    local: true,
    speaks: true,
    model: () => null,

    async unavailable(): Promise<MergeStoryError | null> {
      if (platform === 'darwin' && (await executable(sayPath))) return null;
      return new MergeStoryError('TTS_FAILED', 'The macOS "say" voice is only available on macOS.', {
        hint: 'Run `mergestory setup kokoro` for a free local voice, or choose a paid provider with --tts.',
      });
    },

    /** The installed voice that a configured name stands for, else the best installed voice for the language. */
    async voice(ctx: RunContext): Promise<string | null> {
      const voices = await listVoices(ctx);
      const configured = ctx.config.tts.voice;
      if (configured) return findSayVoice(voices, configured)?.name ?? configured;
      return pickDefaultSayVoice(voices, ctx.config.language);
    },

    estimateCostUsd: () => 0,

    plannedEgress: async () => [],

    async synthesize(request: TtsRequest, ctx: RunContext): Promise<TtsResult> {
      const voices = await listVoices(ctx);
      let voice: string | null;
      if (request.voice) {
        const found = findSayVoice(voices, request.voice);
        // say falls back to the default voice without a word when a name is unknown.
        if (!found && voices.length > 0) {
          throw new MergeStoryError('TTS_FAILED', `The macOS voice "${request.voice}" is not installed.`, {
            hint: "Run `say -v '?'` to list installed voices, or install more in System Settings > Accessibility > Spoken Content.",
          });
        }
        voice = validName(found?.name ?? request.voice);
      } else {
        voice = pickDefaultSayVoice(voices, request.language);
        // The system voice would read other languages with an English accent and wrong words.
        if (voice === null && voices.length > 0 && !/^en(?:[-_]|$)/i.test(request.language)) {
          throw new MergeStoryError(
            'TTS_FAILED',
            `No macOS voice is installed for the language "${request.language}".`,
            {
              hint: 'Install one in System Settings > Accessibility > Spoken Content, set tts.voice, or choose another provider with --tts.',
            },
          );
        }
      }
      const rate = Math.max(90, Math.min(400, Math.round(BASE_WORDS_PER_MINUTE * request.speed)));
      await mkdir(ctx.runDir, { recursive: true, mode: 0o700 });
      const dir = await mkdtemp(join(ctx.runDir, '.say-'));
      const outFile = join(dir, 'speech.wav');
      const args = [
        ...(voice ? ['-v', voice] : []),
        '-r',
        String(rate),
        '--file-format=WAVE',
        `--data-format=LEI16@${OUTPUT_RATE}`,
        '-o',
        outFile,
        '-f',
        '-',
      ];
      try {
        // "[[" starts an embedded command in say; keep it from being read as one.
        await run(sayPath, args, {
          input: request.text.replace(/\[\[/g, '[ ['),
          signal: ctx.signal,
          timeoutMs: 120_000,
        });
        const audio = await readFile(outFile);
        return {
          audio,
          format: 'wav',
          sampleRate: OUTPUT_RATE,
          channels: 1,
          characters: request.text.length,
        };
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        if (err instanceof MergeStoryError && err.code !== 'INTERNAL') throw err;
        throw new MergeStoryError('TTS_FAILED', `The macOS "say" command failed: ${(err as Error).message}`, {
          hint: "Run `say -v '?'` to check the voice, or choose another provider with --tts.",
          cause: err,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
