/**
 * Kokoro speech provider (local, free): the Kokoro-82M model through the optional kokoro-js
 * plugin. English only. Nothing leaves the machine after the one-time model download.
 */
import { pathToFileURL } from 'node:url';
import type { RunContext } from '../core/context.ts';
import { assertNotAborted, MergeStoryError } from '../core/errors.ts';
import type { TtsProvider, TtsRequest, TtsResult } from '../core/providers.ts';
import type { EgressRecord } from '../core/types.ts';
import { joinWithGaps } from './audio.ts';
import { splitForSynthesis } from './chunking.ts';
import {
  ensureModelFiles,
  isKokoroModelCached,
  KOKORO_MODEL_HOST,
  KOKORO_MODEL_ID,
  KOKORO_MODEL_REVISION,
  type KokoroDtype,
  kokoroDownloadMb,
  kokoroDtype,
  kokoroModelFiles,
} from './kokoro-model.ts';
import { ensureLoaderFile, isKokoroInstalled, KOKORO_PACKAGES_HOST, pluginsDir } from './kokoro-plugin.ts';
import { encodeWavFloat32 } from './wav.ts';

export const KOKORO_DEFAULT_VOICE = 'af_heart';
/** The 28 English voices kokoro-js accepts: American (af, am) and British (bf, bm). */
export const KOKORO_VOICES = [
  'af_heart',
  'af_alloy',
  'af_aoede',
  'af_bella',
  'af_jessica',
  'af_kore',
  'af_nicole',
  'af_nova',
  'af_river',
  'af_sarah',
  'af_sky',
  'am_adam',
  'am_echo',
  'am_eric',
  'am_fenrir',
  'am_liam',
  'am_michael',
  'am_onyx',
  'am_puck',
  'am_santa',
  'bf_alice',
  'bf_emma',
  'bf_isabella',
  'bf_lily',
  'bm_daniel',
  'bm_fable',
  'bm_george',
  'bm_lewis',
] as const;

/** One call handles about 510 tokens (roughly 27 seconds of speech); longer input is silently cut. */
const MAX_CHUNK_CHARS = 280;
/** A result shorter than this many seconds per character means part of the text was dropped. */
const MIN_SECONDS_PER_CHAR = 0.012;
const OUTPUT_RATE = 24_000;

export interface KokoroRuntime {
  /** Speak one short piece of text. Returns mono floats and their sample rate. */
  generate(
    text: string,
    voice: string,
    speed: number,
  ): Promise<{ samples: Float32Array; sampleRate: number }>;
}

interface KokoroModule {
  KokoroTTS: {
    from_pretrained(
      id: string,
      options: { dtype: KokoroDtype; device: 'cpu' },
    ): Promise<{
      generate(
        text: string,
        options: { voice: string; speed: number },
      ): Promise<{ audio: Float32Array; sampling_rate: number }>;
    }>;
  };
  env: Record<string, unknown>;
}

let loaded: { key: string; runtime: Promise<KokoroRuntime> } | null = null;

const isEnglish = (language: string): boolean => /^en(?:[-_]|$)/i.test(language);

/** Kokoro-82M speaks English only. */
function notEnglish(language: string): MergeStoryError {
  return new MergeStoryError('CONFIG_INVALID', 'The Kokoro voice only speaks English.', {
    hint: `The narration language is "${language}". Use --tts say (macOS), a paid provider, or --tts none.`,
  });
}

function notInstalled(): MergeStoryError {
  return new MergeStoryError('TTS_FAILED', 'The Kokoro voice is not installed.', {
    hint: 'Run `mergestory setup kokoro` to install the free local voice, or choose another provider with --tts.',
  });
}

/** A plugin that is present but does not load (damaged install, unsupported platform). */
function loadFailure(dir: string, err: unknown): MergeStoryError {
  return new MergeStoryError(
    'TTS_FAILED',
    `The Kokoro voice could not be loaded: ${(err as Error).message}`,
    {
      hint: `Delete ${dir} and run \`mergestory setup kokoro\` again, or choose another provider with --tts.`,
      cause: err,
    },
  );
}

async function loadRuntime(ctx: RunContext, dtype: KokoroDtype): Promise<KokoroRuntime> {
  const dir = pluginsDir(ctx);
  if (!(await isKokoroInstalled(ctx))) throw notInstalled();

  // Load the packages first, so a broken install is found before a large model is downloaded.
  let mod: KokoroModule;
  try {
    mod = (await import(pathToFileURL(await ensureLoaderFile(dir)).href)) as KokoroModule;
  } catch (err) {
    throw loadFailure(dir, err);
  }

  const lastReport = { value: -1 };
  await ensureModelFiles({
    modelsRoot: ctx.home.models,
    files: kokoroModelFiles(dtype),
    signal: ctx.signal,
    onDownloadStart: (file) => {
      if (file.bytes > 1_000_000) {
        // Nothing of the user's is sent, but the connection is part of the run's record.
        ctx.egress.record(KOKORO_MODEL_HOST, 'voice model download', 0, []);
        ctx.progress({
          stage: 'narrate',
          status: 'progress',
          message: `Downloading the Kokoro voice model (${kokoroDownloadMb(dtype)} MB, one time) from ${KOKORO_MODEL_HOST}`,
        });
      }
    },
    onProgress: ({ file, loaded: bytes, total }) => {
      const percent = Math.floor((bytes / total) * 10) * 10;
      if (total > 1_000_000 && percent > lastReport.value) {
        lastReport.value = percent;
        ctx.progress({
          stage: 'narrate',
          status: 'progress',
          progress: bytes / total,
          message: `Downloading ${file}: ${percent}%`,
        });
      }
    },
  });

  // Everything is already on disk and verified, so transformers.js is not allowed to fetch.
  mod.env.cacheDir = ctx.home.models;
  mod.env.allowRemoteModels = false;
  mod.env.remotePathTemplate = `{model}/resolve/${KOKORO_MODEL_REVISION}/`;
  ctx.progress({ stage: 'narrate', status: 'progress', message: 'Loading the Kokoro voice model' });
  let tts: Awaited<ReturnType<KokoroModule['KokoroTTS']['from_pretrained']>>;
  try {
    tts = await mod.KokoroTTS.from_pretrained(KOKORO_MODEL_ID, { dtype, device: 'cpu' });
  } catch (err) {
    throw loadFailure(dir, err);
  }
  return {
    async generate(text, voice, speed) {
      const audio = await tts.generate(text, { voice, speed });
      return { samples: audio.audio, sampleRate: audio.sampling_rate };
    },
  };
}

/** The model loads once per process; a failed load can be retried. */
function runtimeFor(ctx: RunContext, dtype: KokoroDtype): Promise<KokoroRuntime> {
  const key = `${pluginsDir(ctx)}|${ctx.home.models}|${dtype}`;
  if (loaded?.key === key) return loaded.runtime;
  const runtime = loadRuntime(ctx, dtype);
  loaded = { key, runtime };
  runtime.catch(() => {
    if (loaded?.runtime === runtime) loaded = null;
  });
  return runtime;
}

export interface KokoroDeps {
  /** Replaces the plugin and model loading (tests). */
  load?: (ctx: RunContext) => Promise<KokoroRuntime>;
  /** Replaces the check for the installed plugin (tests). */
  isInstalled?: (ctx: RunContext) => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
}

export function createKokoroProvider(deps: KokoroDeps = {}): TtsProvider {
  const dtype = kokoroDtype(deps.env, deps.platform, deps.arch);
  const isInstalled = (ctx: RunContext): Promise<boolean> =>
    deps.isInstalled ? deps.isInstalled(ctx) : isKokoroInstalled(ctx);
  return {
    id: 'kokoro',
    local: true,
    speaks: true,

    // The model that is loaded is the one for this machine, whatever tts.model says.
    model: () => `Kokoro-82M-v1.0-${dtype}`,

    async voice(ctx: RunContext): Promise<string | null> {
      return ctx.config.tts.voice || KOKORO_DEFAULT_VOICE;
    },

    async unavailable(ctx: RunContext): Promise<MergeStoryError | null> {
      if (!isEnglish(ctx.config.language)) return notEnglish(ctx.config.language);
      return (await isInstalled(ctx)) ? null : notInstalled();
    },

    estimateCostUsd: () => 0,

    /**
     * Nothing of the change leaves the machine, but the first run installs the voice packages
     * (when they are missing) and downloads the model.
     */
    async plannedEgress(ctx: RunContext): Promise<EgressRecord[]> {
      const records: EgressRecord[] = [];
      if (!(await isInstalled(ctx))) {
        records.push({
          destination: KOKORO_PACKAGES_HOST,
          purpose: 'voice package download (first run only)',
          bytes: 0,
          contains: [],
        });
      }
      if (!(await isKokoroModelCached(ctx.home.models, dtype))) {
        records.push({
          destination: KOKORO_MODEL_HOST,
          purpose: 'voice model download (first run only)',
          bytes: 0,
          contains: [],
        });
      }
      return records;
    },

    async synthesize(request: TtsRequest, ctx: RunContext): Promise<TtsResult> {
      if (!isEnglish(request.language)) throw notEnglish(request.language);
      const voice = request.voice ?? KOKORO_DEFAULT_VOICE;
      if (!(KOKORO_VOICES as readonly string[]).includes(voice)) {
        throw new MergeStoryError('CONFIG_INVALID', `"${voice.slice(0, 40)}" is not a Kokoro voice.`, {
          hint: `Choose one of: ${KOKORO_VOICES.join(', ')}.`,
        });
      }
      // The model rejects nothing, so out-of-range speeds give garbled or ten-times-long audio.
      const speed = Math.min(2, Math.max(0.5, request.speed));
      const runtime = await (deps.load ? deps.load(ctx) : runtimeFor(ctx, dtype));
      const parts: Float32Array[] = [];
      let rate = OUTPUT_RATE;
      for (const piece of splitForSynthesis(request.text, MAX_CHUNK_CHARS)) {
        if (!/[\p{L}\p{N}]/u.test(piece)) continue;
        assertNotAborted(ctx.signal);
        const result = await runtime.generate(piece, voice, speed);
        rate = result.sampleRate;
        if (result.samples.length / rate < piece.length * MIN_SECONDS_PER_CHAR) {
          throw new MergeStoryError('TTS_FAILED', 'Kokoro returned less audio than the text needs.', {
            hint: 'Run again, or use another speech provider.',
          });
        }
        parts.push(result.samples);
      }
      const only = parts[0];
      const samples = parts.length === 1 && only ? only : joinWithGaps(parts, rate);
      return {
        audio: encodeWavFloat32(samples, rate),
        format: 'wav',
        sampleRate: rate,
        channels: 1,
        characters: request.text.length,
      };
    },
  };
}
