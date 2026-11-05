/**
 * Turning every narration line into a finished audio clip. Each line is cached by its spoken
 * text, voice, model, speed, language and provider, so a re-run costs nothing and sounds the same.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mapLimit } from '../core/concurrency.ts';
import type { RunContext } from '../core/context.ts';
import { abortedError, MergeStoryError } from '../core/errors.ts';
import { hashKey, sha256 } from '../core/ids.ts';
import type { TtsProvider, TtsResult } from '../core/providers.ts';
import { speechSeconds } from '../core/storyboard-facts.ts';
import type { Storyboard } from '../core/storyboard-schema.ts';
import type { NarrationClip, NarrationResult } from '../core/types.ts';
import { processSpeechClip } from './audio.ts';
import { captionText } from './captions.ts';
import { decodeTtsResult } from './convert.ts';
import { toSpokenTextFor } from './speakable.ts';
import { CANONICAL_RATE, encodeWavPcm16, readCanonicalWav, wavDurationSec } from './wav.ts';

/** Changes whenever clip processing changes, so old cached clips are not reused. */
const CACHE_VERSION = 1;

interface Line {
  sceneId: string;
  beatIndex: number;
  text: string;
  spokenText: string;
  /** false when nothing can be said (for example a line of punctuation). */
  speakable: boolean;
}

/** What decides the text of a narration line: masking and how identifiers are spoken. */
interface LineOptions {
  /** Narration language. */
  language: string;
  /** Whether e-mail addresses are masked, as they are in narration and captions. */
  maskEmails: boolean;
}

function lineOptions(ctx: RunContext): LineOptions {
  return { language: ctx.config.language, maskEmails: ctx.config.privacy.maskEmails };
}

function collectLines(storyboard: Storyboard, options: LineOptions): Line[] {
  const lines: Line[] = [];
  for (const scene of storyboard.scenes) {
    scene.narration.forEach((line, beatIndex) => {
      const text = captionText(line.text, { maskEmails: options.maskEmails });
      const spokenText = toSpokenTextFor(text, options.language);
      lines.push({
        sceneId: scene.id,
        beatIndex,
        text,
        spokenText,
        speakable: /[\p{L}\p{N}]/u.test(spokenText),
      });
    });
  }
  return lines;
}

function estimatedClip(line: Line): NarrationClip {
  return {
    sceneId: line.sceneId,
    beatIndex: line.beatIndex,
    text: line.text,
    spokenText: line.spokenText,
    audioPath: null,
    durationSec: Math.round(speechSeconds(line.spokenText) * 1000) / 1000,
    cached: false,
  };
}

/** Clips as the silent provider makes them: lengths from word counts, no audio. */
export function estimateNarration(storyboard: Storyboard, options: LineOptions): NarrationResult {
  return { provider: 'none', voice: null, clips: collectLines(storyboard, options).map(estimatedClip) };
}

function clipFileName(sceneId: string, beatIndex: number): string {
  const safe = sceneId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'scene';
  const suffix = safe === sceneId ? '' : `-${sha256(sceneId).slice(0, 6)}`;
  return `${safe}${suffix}-${beatIndex}.wav`;
}

function isUsableClip(wav: Buffer): boolean {
  try {
    return readCanonicalWav(wav).length > 0;
  } catch {
    return false;
  }
}

function asSpeechError(err: unknown, ctx: RunContext): MergeStoryError {
  if (err instanceof MergeStoryError) return err;
  if (ctx.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
    return abortedError(err);
  }
  const reason = err instanceof Error ? err.message : String(err);
  return new MergeStoryError('TTS_FAILED', `Speech synthesis failed: ${ctx.redactor.redact(reason)}`, {
    hint: 'Run again (finished lines are cached) or choose another speech provider with --tts.',
    cause: err,
  });
}

interface UniqueText {
  key: string;
  spokenText: string;
  wav: Buffer | null;
  fromCache: boolean;
}

/**
 * Synthesize every narration line (cached by text, voice and provider). Clips are mono 48 kHz
 * 16-bit WAV files in `<runDir>/narration`, trimmed and matched in loudness. The silent provider
 * (and a dry run with a paid provider) produces clips without audio and estimated lengths.
 */
export async function synthesizeNarration(
  storyboard: Storyboard,
  provider: TtsProvider,
  ctx: RunContext,
): Promise<NarrationResult> {
  const lines = collectLines(storyboard, lineOptions(ctx));
  const voice = await provider.voice(ctx);
  const model = provider.model(ctx);

  if (!provider.speaks || (ctx.dryRun && !provider.local)) {
    ctx.progress({
      stage: 'narrate',
      status: 'skip',
      message: !provider.speaks
        ? 'No speech provider: captions only, with estimated timing'
        : 'Dry run: speech is not synthesized, timing is estimated',
    });
    return { provider: provider.id, voice, clips: lines.map(estimatedClip) };
  }

  const dir = join(ctx.runDir, 'narration');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const speed = ctx.config.tts.speed;
  const language = ctx.config.language;
  const keyFor = (spokenText: string): string =>
    hashKey({ pipeline: CACHE_VERSION, provider: provider.id, model, voice, speed, language, spokenText });

  const unique = new Map<string, UniqueText>();
  for (const line of lines) {
    if (!line.speakable) continue;
    const key = keyFor(line.spokenText);
    if (!unique.has(key)) unique.set(key, { key, spokenText: line.spokenText, wav: null, fromCache: false });
  }

  for (const entry of unique.values()) {
    const hit = await ctx.cache.get('tts', entry.key);
    if (hit && isUsableClip(hit)) {
      entry.wav = hit;
      entry.fromCache = true;
    }
  }
  const misses = [...unique.values()].filter((entry) => !entry.wav);
  ctx.progress({
    stage: 'narrate',
    status: 'progress',
    message: `${unique.size} distinct lines: ${unique.size - misses.length} from cache, ${misses.length} to synthesize`,
  });

  // Stop before spending anything when the whole batch would go over budget.
  const missChars = misses.reduce((sum, entry) => sum + entry.spokenText.length, 0);
  const estimate = provider.estimateCostUsd(missChars, ctx);
  if (estimate > 0) ctx.cost.assertWithinBudget(estimate, `Speech synthesis with ${provider.id}`);

  const synthesizeOne = async (entry: UniqueText): Promise<void> => {
    let result: TtsResult;
    try {
      result = await provider.synthesize({ text: entry.spokenText, voice, language, speed }, ctx);
      const mono = await decodeTtsResult(result, ctx);
      const clip = processSpeechClip(mono);
      if (!clip) {
        throw new MergeStoryError(
          'TTS_FAILED',
          'The speech provider returned silence for a narration line.',
          {
            hint: 'Run again, or try another voice or speech provider.',
          },
        );
      }
      entry.wav = encodeWavPcm16(clip.pcm, CANONICAL_RATE);
    } catch (err) {
      throw asSpeechError(err, ctx);
    }
    try {
      await ctx.cache.put('tts', entry.key, entry.wav);
    } catch (err) {
      // A cache that cannot be written (for example a full disk) only costs a repeat next time.
      ctx.logger.warn('Could not store a narration clip in the cache', { reason: (err as Error).message });
    }
  };

  let finished = unique.size - misses.length;
  await mapLimit(
    misses,
    provider.local ? 1 : 4,
    async (entry) => {
      await synthesizeOne(entry);
      finished++;
      ctx.progress({
        stage: 'narrate',
        status: 'progress',
        progress: finished / unique.size,
        message: `Line ${finished} of ${unique.size} ready`,
      });
    },
    ctx.signal,
  );

  const clips: NarrationClip[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (!line.speakable) {
      clips.push(estimatedClip(line));
      continue;
    }
    const key = keyFor(line.spokenText);
    const entry = unique.get(key) as UniqueText;
    const wav = entry.wav as Buffer;
    const audioPath = join(dir, clipFileName(line.sceneId, line.beatIndex));
    await writeFile(audioPath, wav, { mode: 0o600 });
    clips.push({
      sceneId: line.sceneId,
      beatIndex: line.beatIndex,
      text: line.text,
      spokenText: line.spokenText,
      audioPath,
      durationSec: Math.round(wavDurationSec(wav) * 1000) / 1000,
      cached: entry.fromCache || seen.has(key),
    });
    seen.add(key);
  }

  // Paid providers record each call themselves. Add the free parts so the cost report is complete.
  const cachedChars = [...unique.values()]
    .filter((e) => e.fromCache)
    .reduce((n, e) => n + e.spokenText.length, 0);
  if (cachedChars > 0 && !provider.local) {
    ctx.cost.record({
      provider: provider.id,
      kind: 'tts',
      model,
      characters: cachedChars,
      costUsd: 0,
      estimated: false,
      cached: true,
    });
  }
  if (provider.local && missChars > 0) {
    ctx.cost.record({
      provider: provider.id,
      kind: 'tts',
      model,
      characters: missChars,
      costUsd: 0,
      estimated: false,
    });
  }
  return { provider: provider.id, voice, clips };
}

/** Characters of spoken text times the provider's price. An upper bound: cached lines are free. */
export function estimateNarrationCost(
  storyboard: Storyboard,
  provider: TtsProvider,
  ctx: RunContext,
): { characters: number; costUsd: number } {
  const characters = collectLines(storyboard, lineOptions(ctx))
    .filter((line) => line.speakable)
    .reduce((sum, line) => sum + line.spokenText.length, 0);
  return { characters, costUsd: provider.estimateCostUsd(characters, ctx) };
}
