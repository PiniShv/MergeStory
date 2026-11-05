/**
 * The narration track: every clip placed at its beat start on one silent mono 48 kHz timeline,
 * written as a single WAV. Optional background music is mixed in quietly and ducked while
 * someone is speaking. The finished track is brought to a standard loudness (-16 LUFS with a true
 * peak of at most -1.5 dBTP), which keeps the video as loud as other online video without
 * clipping. Audio never leaves the machine.
 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { resolveFfmpeg } from '../core/binaries.ts';
import type { RunContext } from '../core/context.ts';
import { MergeStoryError } from '../core/errors.ts';
import { runCommand } from '../core/process.ts';
import type { NarrationClip, NarrationResult, Timeline } from '../core/types.ts';
import { floatToInt16, resampleMono } from './audio.ts';
import type { RunFn } from './convert.ts';
import { CANONICAL_RATE, decodeWavToMono, encodeWavPcm16, readCanonicalWav } from './wav.ts';

/** Extra silence after the end of the timeline, so the track is never shorter than the video. */
const TAIL_SEC = 0.5;
/** Music level relative to the music file itself. */
const MUSIC_GAIN_DB = -26;
const MUSIC_FADE_OUT_SEC = 2;

/** Integrated loudness the finished track is brought to, in LUFS. */
export const TARGET_LUFS = -16;
/** The true peak of the finished track stays at or below this, in dBTP. */
export const TRUE_PEAK_DB = -1.5;
/** Loudness range target for the normalizer; speech is far below it, so it never squeezes the track. */
const LOUDNESS_RANGE = 11;
/** A track already this close to the target (in LU) with a safe peak is left as it is. */
const LOUDNESS_TOLERANCE = 0.5;
/** Tracks shorter than this are too short for a loudness measurement and are left alone. */
const MIN_NORMALIZE_SEC = 1;
/** A track that needs more gain than this (in dB) is nearly silent, so it is left alone. */
const MAX_NORMALIZE_GAIN_DB = 30;

export interface AssembleOptions {
  /** Bring the finished track to the standard loudness. Default true. */
  loudness?: boolean;
}

async function loadClipSamples(clip: NarrationClip, ctx: RunContext): Promise<Int16Array> {
  const bytes = await readFile(clip.audioPath as string);
  try {
    return readCanonicalWav(bytes);
  } catch {
    // Not one of our own clips: convert it to the track format without changing its level.
    ctx.logger.debug('Narration clip is not mono 48 kHz 16-bit; converting', {
      scene: clip.sceneId,
      beat: clip.beatIndex,
    });
    const mono = decodeWavToMono(bytes);
    return floatToInt16(resampleMono(mono.samples, mono.sampleRate, CANONICAL_RATE));
  }
}

/** Add a clip into the mix, clipping instead of wrapping if two clips ever overlap. */
function addClip(mix: Int16Array, clip: Int16Array, start: number): void {
  for (let i = 0; i < clip.length; i++) {
    const at = start + i;
    if (at < 0 || at >= mix.length) continue;
    const sum = (mix[at] ?? 0) + (clip[i] ?? 0);
    mix[at] = Math.max(-32768, Math.min(32767, sum));
  }
}

/**
 * Render the music bed with FFmpeg: looped to the track length, quiet, faded out at the end and
 * ducked by the narration. The result is mixed with the narration here, in plain arithmetic,
 * so levels do not depend on how a particular FFmpeg version scales its mixer.
 */
async function renderMusicBed(
  voice: Int16Array,
  musicPath: string,
  ctx: RunContext,
  run: RunFn,
): Promise<Int16Array> {
  const { ffmpeg } = await resolveFfmpeg(ctx.config);
  const durationSec = voice.length / CANONICAL_RATE;
  const fadeStart = Math.max(0, durationSec - MUSIC_FADE_OUT_SEC);
  const graph = [
    '[0:a]aformat=sample_fmts=fltp:channel_layouts=mono[sidechain]',
    `[1:a]aresample=${CANONICAL_RATE},aformat=sample_fmts=fltp:channel_layouts=mono,volume=${MUSIC_GAIN_DB}dB,` +
      `afade=t=out:st=${fadeStart.toFixed(3)}:d=${MUSIC_FADE_OUT_SEC}[music]`,
    '[music][sidechain]sidechaincompress=threshold=0.03:ratio=5:attack=20:release=300[bed]',
  ].join(';');
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    'pipe:0',
    '-stream_loop',
    '-1',
    '-i',
    musicPath,
    '-filter_complex',
    graph,
    '-map',
    '[bed]',
    '-t',
    durationSec.toFixed(3),
    '-f',
    's16le',
    '-ac',
    '1',
    '-ar',
    String(CANONICAL_RATE),
    'pipe:1',
  ];
  let output: Buffer;
  try {
    output = (
      await run(ffmpeg, args, {
        input: encodeWavPcm16(voice, CANONICAL_RATE),
        signal: ctx.signal,
        timeoutMs: 300_000,
      })
    ).stdoutBuffer;
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    throw new MergeStoryError(
      'CONFIG_INVALID',
      'FFmpeg could not mix the background music into the narration.',
      {
        hint: 'Check that render.musicPath points to a playable audio file (MP3, WAV, M4A, FLAC or OGG).',
        cause: err,
      },
    );
  }
  const count = Math.floor(output.length / 2);
  const bed = new Int16Array(count);
  for (let i = 0; i < count; i++) bed[i] = output.readInt16LE(i * 2);
  return bed;
}

interface LoudnessStats {
  integrated: number;
  truePeak: number;
  range: number;
  threshold: number;
  offset: number;
}

/** The numbers FFmpeg's loudnorm filter prints after its first pass, or null when there are none. */
export function parseLoudnorm(stderr: string): LoudnessStats | null {
  const block = /\{[^{}]*"input_i"[^{}]*\}/.exec(stderr)?.[0];
  if (!block) return null;
  try {
    const data = JSON.parse(block) as Record<string, string>;
    const stats = {
      integrated: Number(data.input_i),
      truePeak: Number(data.input_tp),
      range: Number(data.input_lra),
      threshold: Number(data.input_thresh),
      offset: Number(data.target_offset),
    };
    return Object.values(stats).every(Number.isFinite) ? stats : null;
  } catch {
    return null;
  }
}

/**
 * Bring a track to TARGET_LUFS with a true peak of at most TRUE_PEAK_DB, in two passes of FFmpeg's
 * loudnorm filter: the first measures, the second applies one steady gain (or, when that gain
 * would push a peak over the ceiling, loudnorm's gentle dynamic mode). The track keeps its length
 * and every sample stays where it was in time. Returns the track unchanged when it is too short or
 * silent, is already on target, or FFmpeg is unavailable.
 */
export async function normalizeLoudness(track: Int16Array, ctx: RunContext, run: RunFn): Promise<Int16Array> {
  if (track.length < MIN_NORMALIZE_SEC * CANONICAL_RATE || !track.some((v) => v !== 0)) return track;
  let ffmpeg: string;
  try {
    ffmpeg = (await resolveFfmpeg(ctx.config)).ffmpeg;
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    ctx.logger.debug('FFmpeg is not available; the narration level is left as it is');
    return track;
  }
  const target = `I=${TARGET_LUFS}:TP=${TRUE_PEAK_DB}:LRA=${LOUDNESS_RANGE}`;
  const input = encodeWavPcm16(track, CANONICAL_RATE);
  try {
    const first = await run(
      ffmpeg,
      [
        '-hide_banner',
        '-nostats',
        '-i',
        'pipe:0',
        '-af',
        `loudnorm=${target}:print_format=json`,
        '-f',
        'null',
        '-',
      ],
      { input, signal: ctx.signal, timeoutMs: 300_000 },
    );
    const stats = parseLoudnorm(first.stderr);
    if (!stats) {
      ctx.logger.debug('The narration is too quiet to measure; its level is left as it is');
      return track;
    }
    const gain = TARGET_LUFS - stats.integrated;
    ctx.logger.debug('Narration loudness measured', { lufs: stats.integrated, truePeakDb: stats.truePeak });
    if (Math.abs(gain) <= LOUDNESS_TOLERANCE && stats.truePeak <= TRUE_PEAK_DB) return track;
    if (gain > MAX_NORMALIZE_GAIN_DB) return track;
    const measured =
      `measured_I=${stats.integrated}:measured_LRA=${stats.range}:measured_TP=${stats.truePeak}` +
      `:measured_thresh=${stats.threshold}:offset=${stats.offset}`;
    const second = await run(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        'pipe:0',
        '-af',
        `loudnorm=${target}:${measured}:linear=true,aresample=${CANONICAL_RATE},aformat=sample_fmts=s16:channel_layouts=mono`,
        '-f',
        's16le',
        '-ac',
        '1',
        '-ar',
        String(CANONICAL_RATE),
        'pipe:1',
      ],
      { input, signal: ctx.signal, timeoutMs: 300_000 },
    );
    const count = Math.floor(second.stdoutBuffer.length / 2);
    if (count === 0) return track;
    // Same length as before: anything past the end is cut and a short result is padded with silence.
    const out = new Int16Array(track.length);
    for (let i = 0; i < Math.min(count, out.length); i++) out[i] = second.stdoutBuffer.readInt16LE(i * 2);
    return out;
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    ctx.progress({
      stage: 'narrate',
      status: 'warn',
      message: 'The narration could not be brought to the standard loudness and keeps its own level',
    });
    ctx.logger.debug('Loudness normalization failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return track;
  }
}

/**
 * Place every clip at its beat start time and write one mono 48 kHz WAV for the whole video, at
 * the standard loudness (see normalizeLoudness). Beat start times are absolute (seconds from the
 * start of the video). Returns null when there is no audio (silent provider and no music). Tests
 * pass their own command runner as `run`.
 */
export async function assembleNarrationTrack(
  narration: NarrationResult,
  timeline: Timeline,
  outPath: string,
  ctx: RunContext,
  options: AssembleOptions = {},
  run: RunFn = runCommand,
): Promise<string | null> {
  const spoken = narration.clips.filter((clip) => clip.audioPath);
  const musicPath = ctx.config.render.musicPath ? resolve(ctx.config.render.musicPath) : null;
  if (spoken.length === 0 && !musicPath) return null;
  if (musicPath) {
    try {
      await access(musicPath);
    } catch {
      throw new MergeStoryError('CONFIG_INVALID', 'The background music file was not found.', {
        hint: 'Check render.musicPath in the config, or remove it to render without music.',
      });
    }
  }

  const total = Math.ceil((timeline.durationSec + TAIL_SEC) * CANONICAL_RATE);
  const voice = new Int16Array(total);
  for (const clip of spoken) {
    const beat = timeline.scenes
      .find((s) => s.sceneId === clip.sceneId)
      ?.beats.find((b) => b.index === clip.beatIndex);
    if (!beat) {
      ctx.progress({
        stage: 'narrate',
        status: 'warn',
        message: `Narration line ${clip.beatIndex + 1} of scene ${clip.sceneId} has no place on the timeline and was left out`,
      });
      continue;
    }
    const samples = await loadClipSamples(clip, ctx);
    if (samples.length / CANONICAL_RATE > beat.durationSec + 0.05) {
      ctx.progress({
        stage: 'narrate',
        status: 'warn',
        message: `Narration line ${clip.beatIndex + 1} of scene ${clip.sceneId} is longer than its slot and may overlap the next line`,
      });
    }
    addClip(voice, samples, Math.round(beat.startSec * CANONICAL_RATE));
  }

  let track: Int16Array = voice;
  if (musicPath) {
    const bed = await renderMusicBed(voice, musicPath, ctx, run);
    track = new Int16Array(voice.length);
    addClip(track, voice, 0);
    addClip(track, bed, 0);
  }
  if (options.loudness !== false) track = await normalizeLoudness(track, ctx, run);
  await mkdir(dirname(outPath), { recursive: true, mode: 0o700 });
  await writeFile(outPath, encodeWavPcm16(track, CANONICAL_RATE), { mode: 0o600 });
  return outPath;
}
