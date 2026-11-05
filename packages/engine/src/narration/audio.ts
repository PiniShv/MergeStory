/**
 * Sample-level audio processing for narration clips: resampling, silence trimming,
 * loudness matching and peak limiting. Everything works on mono floats in [-1, 1] and is
 * deterministic, so a cached clip is identical on every machine.
 */
import { CANONICAL_RATE, type MonoAudio } from './wav.ts';

/** Speech level every clip is matched to (RMS over the speaking parts, in dBFS). */
export const TARGET_SPEECH_RMS_DB = -18;
/** No sample of a finished clip is louder than this. */
export const PEAK_CEILING_DB = -1;
/** Audio below this level at the start and end of a clip counts as silence. */
export const SILENCE_THRESHOLD_DB = -45;
/** Silence kept before the first and after the last spoken sound. */
export const EDGE_PAD_SEC = 0.06;

export function dbToLinear(db: number): number {
  return 10 ** (db / 20);
}

// ---------------------------------------------------------------------------
// Resampling
// ---------------------------------------------------------------------------

const KAISER_BETA = 8;
/** Zero crossings of the interpolation filter on each side (at the lower of the two rates). */
const FILTER_HALF_WIDTH = 16;
/** Above this many phases the filter is evaluated per output sample instead of from a table. */
const MAX_PHASE_TABLE = 2048;

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 60; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

const KAISER_NORM = besselI0(KAISER_BETA);

function kaiser(t: number): number {
  if (t <= -1 || t >= 1) return 0;
  return besselI0(KAISER_BETA * Math.sqrt(1 - t * t)) / KAISER_NORM;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * Convert mono audio to another sample rate with a Kaiser-windowed sinc filter (polyphase).
 * The cutoff follows the lower of the two rates, so downsampling does not alias.
 */
export function resampleMono(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const scale = Math.min(1, toRate / fromRate);
  const half = Math.ceil(FILTER_HALF_WIDTH / scale);
  const taps = half * 2;
  const g = gcd(fromRate, toRate);
  const phases = toRate / g;
  const step = fromRate / g;
  const outLength = Math.round((input.length * toRate) / fromRate);
  const out = new Float32Array(outLength);

  const compute = (frac: number, into: Float64Array): void => {
    let sum = 0;
    for (let j = 0; j < taps; j++) {
      const d = frac + (half - 1 - j);
      const x = Math.PI * scale * d;
      const sinc = d === 0 ? 1 : Math.sin(x) / x;
      const w = scale * sinc * kaiser(d / half);
      into[j] = w;
      sum += w;
    }
    for (let j = 0; j < taps; j++) into[j] = (into[j] ?? 0) / sum;
  };

  let table: Float64Array[] | null = null;
  if (phases <= MAX_PHASE_TABLE) {
    table = [];
    for (let p = 0; p < phases; p++) {
      const w = new Float64Array(taps);
      compute(p / phases, w);
      table.push(w);
    }
  }
  const scratch = new Float64Array(taps);

  for (let n = 0; n < outLength; n++) {
    const numerator = n * step;
    const i0 = Math.floor(numerator / phases);
    const phase = numerator - i0 * phases;
    let weights: Float64Array;
    if (table) {
      weights = table[phase] as Float64Array;
    } else {
      compute(phase / phases, scratch);
      weights = scratch;
    }
    const first = i0 - half + 1;
    let acc = 0;
    for (let j = 0; j < taps; j++) {
      const idx = first + j;
      if (idx >= 0 && idx < input.length) acc += (input[idx] ?? 0) * (weights[j] ?? 0);
    }
    out[n] = acc;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Trimming
// ---------------------------------------------------------------------------

export interface TrimOptions {
  thresholdDb?: number;
  padSec?: number;
}

/**
 * Cut silence from both ends, leaving exactly `padSec` of quiet before the first and after the
 * last sound (zeros are added when the clip had less). Returns null when nothing is above the
 * threshold.
 */
export function trimSilence(
  samples: Float32Array,
  rate: number,
  options: TrimOptions = {},
): Float32Array | null {
  const threshold = dbToLinear(options.thresholdDb ?? SILENCE_THRESHOLD_DB);
  const pad = Math.round((options.padSec ?? EDGE_PAD_SEC) * rate);
  let first = -1;
  let last = -1;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i] ?? 0) >= threshold) {
      first = i;
      break;
    }
  }
  if (first < 0) return null;
  for (let i = samples.length - 1; i >= first; i--) {
    if (Math.abs(samples[i] ?? 0) >= threshold) {
      last = i;
      break;
    }
  }
  const start = first - pad;
  const end = last + 1 + pad;
  const out = new Float32Array(end - start);
  for (let i = 0; i < out.length; i++) {
    const src = start + i;
    if (src >= 0 && src < samples.length) out[i] = samples[src] ?? 0;
  }
  return out;
}

/**
 * Join several pieces of speech with short pauses. Each piece is trimmed first, because some
 * engines add a fraction of a second of silence to every call.
 */
export function joinWithGaps(
  parts: Float32Array[],
  rate: number,
  gapSec = 0.16,
  padSec = 0.04,
): Float32Array {
  const trimmed: Float32Array[] = [];
  for (const part of parts) {
    const t = trimSilence(part, rate, { padSec });
    if (t) trimmed.push(t);
  }
  if (trimmed.length === 0) return new Float32Array(0);
  const gap = Math.round(gapSec * rate);
  const total = trimmed.reduce((sum, p) => sum + p.length, 0) + gap * (trimmed.length - 1);
  const out = new Float32Array(total);
  let at = 0;
  for (const piece of trimmed) {
    out.set(piece, at);
    at += piece.length + gap;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Loudness
// ---------------------------------------------------------------------------

const GATE_FRAME_SEC = 0.05;
const ABSOLUTE_GATE_DB = -60;
const RELATIVE_GATE_DB = -10;

/**
 * RMS level of the speaking parts of a clip in dBFS, or null for silence. Frames of 50 ms are
 * ignored when they are very quiet or more than 10 dB below the average, so pauses between
 * words do not make a clip look quiet.
 */
export function measureSpeechRmsDb(samples: Float32Array, rate: number): number | null {
  const frame = Math.max(1, Math.round(rate * GATE_FRAME_SEC));
  const energies: number[] = [];
  for (let start = 0; start < samples.length; start += frame) {
    const end = Math.min(samples.length, start + frame);
    let sum = 0;
    for (let i = start; i < end; i++) {
      const v = samples[i] ?? 0;
      sum += v * v;
    }
    energies.push(sum / (end - start));
  }
  const absolute = dbToLinear(ABSOLUTE_GATE_DB) ** 2;
  const loud = energies.filter((e) => e > absolute);
  if (loud.length === 0) return null;
  const mean = loud.reduce((a, b) => a + b, 0) / loud.length;
  const relative = mean * 10 ** (RELATIVE_GATE_DB / 10);
  const kept = loud.filter((e) => e >= relative);
  const level = kept.reduce((a, b) => a + b, 0) / kept.length;
  return 10 * Math.log10(level);
}

function slidingMin(values: Float32Array, radius: number): Float32Array {
  const n = values.length;
  const out = new Float32Array(n);
  const deque = new Int32Array(n);
  let head = 0;
  let tail = 0;
  let next = 0;
  for (let i = 0; i < n; i++) {
    const hi = Math.min(n - 1, i + radius);
    while (next <= hi) {
      while (tail > head && (values[deque[tail - 1] as number] ?? 0) >= (values[next] ?? 0)) tail--;
      deque[tail++] = next++;
    }
    const lo = i - radius;
    while ((deque[head] as number) < lo) head++;
    out[i] = values[deque[head] as number] ?? 1;
  }
  return out;
}

/**
 * Brick-wall peak limiter (in place). The gain dips smoothly around a loud peak instead of
 * clipping it, and no sample ends up above `ceiling` (linear, 0..1).
 */
export function limitPeaks(samples: Float32Array, ceiling: number, rate: number): void {
  const n = samples.length;
  let needed = false;
  for (let i = 0; i < n; i++) {
    if (Math.abs(samples[i] ?? 0) > ceiling) {
      needed = true;
      break;
    }
  }
  if (!needed) return;
  const radius = Math.max(1, Math.round(rate * 0.0025));
  const required = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.abs(samples[i] ?? 0);
    required[i] = a > ceiling ? ceiling / a : 1;
  }
  // Taking the minimum over the window first, then averaging over the same window, keeps the
  // smoothed gain at or below the gain every nearby peak needs.
  const floorGain = slidingMin(required, radius);
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = (prefix[i] ?? 0) + (floorGain[i] ?? 1);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - radius);
    const hi = Math.min(n - 1, i + radius);
    const gain = ((prefix[hi + 1] ?? 0) - (prefix[lo] ?? 0)) / (hi - lo + 1);
    samples[i] = (samples[i] ?? 0) * gain;
  }
}

/** Short fades at both ends so a clip never starts or stops with a click. */
export function fadeEdges(samples: Float32Array, rate: number, inSec = 0.005, outSec = 0.02): void {
  const n = samples.length;
  const fadeIn = Math.min(Math.round(inSec * rate), n);
  const fadeOut = Math.min(Math.round(outSec * rate), n);
  for (let i = 0; i < fadeIn; i++) samples[i] = (samples[i] ?? 0) * (i / fadeIn);
  for (let i = 0; i < fadeOut; i++) {
    const idx = n - 1 - i;
    samples[idx] = (samples[idx] ?? 0) * (i / fadeOut);
  }
}

export function floatToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.round((samples[i] ?? 0) * 32767);
    out[i] = Math.max(-32768, Math.min(32767, v));
  }
  return out;
}

export interface ProcessedClip {
  /** Mono 48 kHz 16-bit samples ready to store. */
  pcm: Int16Array;
  /** Gain that was applied to match the target level. */
  gainDb: number;
}

const MAX_GAIN_DB = 30;

/**
 * Turn raw engine output into a finished clip: 48 kHz, silence trimmed (60 ms kept), level
 * matched to the speech target, peaks limited, edges faded. Returns null when the audio holds no
 * sound at all.
 */
export function processSpeechClip(audio: MonoAudio): ProcessedClip | null {
  const clean = new Float32Array(audio.samples.length);
  for (let i = 0; i < clean.length; i++) {
    const v = audio.samples[i] ?? 0;
    clean[i] = Number.isFinite(v) ? v : 0;
  }
  const resampled = resampleMono(clean, audio.sampleRate, CANONICAL_RATE);
  const trimmed = trimSilence(resampled, CANONICAL_RATE);
  if (!trimmed) return null;
  const level = measureSpeechRmsDb(trimmed, CANONICAL_RATE);
  let gainDb = 0;
  if (level !== null) {
    gainDb = Math.max(-MAX_GAIN_DB, Math.min(MAX_GAIN_DB, TARGET_SPEECH_RMS_DB - level));
    const gain = dbToLinear(gainDb);
    for (let i = 0; i < trimmed.length; i++) trimmed[i] = (trimmed[i] ?? 0) * gain;
  }
  limitPeaks(trimmed, dbToLinear(PEAK_CEILING_DB), CANONICAL_RATE);
  fadeEdges(trimmed, CANONICAL_RATE);
  return { pcm: floatToInt16(trimmed), gainDb };
}
