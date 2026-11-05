import { describe, expect, it } from 'vitest';
import {
  dbToLinear,
  fadeEdges,
  floatToInt16,
  joinWithGaps,
  limitPeaks,
  measureSpeechRmsDb,
  processSpeechClip,
  resampleMono,
  trimSilence,
} from './audio.ts';
import { CANONICAL_RATE } from './wav.ts';

const linearToDb = (value: number): number => 20 * Math.log10(value);

function sine(freq: number, rate: number, seconds: number, amplitude = 1): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

function rms(samples: Float32Array, from = 0, to = samples.length): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += (samples[i] ?? 0) ** 2;
  return Math.sqrt(sum / (to - from));
}

/** Amplitude of one frequency in a signal (Goertzel). */
function toneAmplitude(samples: Float32Array, freq: number, rate: number): number {
  const w = (2 * Math.PI * freq) / rate;
  let re = 0;
  let im = 0;
  for (let i = 0; i < samples.length; i++) {
    re += (samples[i] ?? 0) * Math.cos(w * i);
    im -= (samples[i] ?? 0) * Math.sin(w * i);
  }
  return (2 * Math.sqrt(re * re + im * im)) / samples.length;
}

/** Silence, then a tone, then silence. */
function burst(
  leadSec: number,
  toneSec: number,
  tailSec: number,
  amplitude: number,
  rate = CANONICAL_RATE,
): Float32Array {
  const lead = Math.round(leadSec * rate);
  const tone = sine(440, rate, toneSec, amplitude);
  const out = new Float32Array(lead + tone.length + Math.round(tailSec * rate));
  out.set(tone, lead);
  return out;
}

describe('resampleMono', () => {
  it('doubles the length and keeps the tone and level when going from 24 kHz to 48 kHz', () => {
    const input = sine(1000, 24_000, 1, 0.5);
    const out = resampleMono(input, 24_000, 48_000);
    expect(out.length).toBe(48_000);
    const mid = out.subarray(4800, out.length - 4800);
    expect(toneAmplitude(mid, 1000, 48_000)).toBeCloseTo(0.5, 2);
    // The mirror image of the tone must be filtered out.
    expect(toneAmplitude(mid, 23_000, 48_000)).toBeLessThan(0.001);
    expect(toneAmplitude(mid, 25_000, 48_000)).toBeLessThan(0.001);
  });

  it('handles awkward ratios such as 44.1 kHz to 48 kHz', () => {
    const input = sine(2000, 44_100, 0.5, 0.4);
    const out = resampleMono(input, 44_100, 48_000);
    expect(out.length).toBe(24_000);
    const mid = out.subarray(2400, out.length - 2400);
    expect(toneAmplitude(mid, 2000, 48_000)).toBeCloseTo(0.4, 2);
  });

  it('removes content above the new Nyquist frequency when downsampling', () => {
    const input = sine(20_000, 48_000, 0.5, 0.8);
    const out = resampleMono(input, 48_000, 24_000);
    expect(rms(out.subarray(1200, out.length - 1200))).toBeLessThan(0.001);
  });

  it('returns the input when the rates match', () => {
    const input = sine(300, 48_000, 0.1);
    expect(resampleMono(input, 48_000, 48_000)).toBe(input);
  });

  it('keeps a constant signal constant (unity gain at DC)', () => {
    const out = resampleMono(new Float32Array(2000).fill(0.25), 24_000, 48_000);
    expect(out[1000]).toBeCloseTo(0.25, 4);
  });
});

describe('trimSilence', () => {
  it('keeps 60 ms of silence on both sides', () => {
    const input = burst(0.5, 0.3, 0.8, 0.3);
    const out = trimSilence(input, CANONICAL_RATE) as Float32Array;
    const expected = Math.round(0.06 * CANONICAL_RATE) * 2 + Math.round(0.3 * CANONICAL_RATE);
    expect(Math.abs(out.length - expected)).toBeLessThanOrEqual(2);
    // The first 60 ms are quiet, the sound starts right after.
    expect(rms(out, 0, Math.round(0.05 * CANONICAL_RATE))).toBe(0);
    expect(rms(out, Math.round(0.07 * CANONICAL_RATE), Math.round(0.1 * CANONICAL_RATE))).toBeGreaterThan(
      0.1,
    );
  });

  it('adds silence when the clip had less than 60 ms', () => {
    const input = sine(440, CANONICAL_RATE, 0.2, 0.3);
    const out = trimSilence(input, CANONICAL_RATE) as Float32Array;
    expect(out.length).toBe(input.length + 2 * Math.round(0.06 * CANONICAL_RATE) - countLeadingQuiet(input));
    expect(out[0]).toBe(0);
  });

  it('treats quiet noise below -45 dBFS as silence', () => {
    const noise = new Float32Array(CANONICAL_RATE).fill(dbToLinear(-50));
    expect(trimSilence(noise, CANONICAL_RATE)).toBeNull();
  });

  it('returns null for pure silence and for empty input', () => {
    expect(trimSilence(new Float32Array(1000), CANONICAL_RATE)).toBeNull();
    expect(trimSilence(new Float32Array(0), CANONICAL_RATE)).toBeNull();
  });
});

function countLeadingQuiet(samples: Float32Array): number {
  let i = 0;
  while (i < samples.length && Math.abs(samples[i] ?? 0) < dbToLinear(-45)) i++;
  return i;
}

describe('measureSpeechRmsDb', () => {
  it('measures a steady tone', () => {
    const level = measureSpeechRmsDb(sine(440, CANONICAL_RATE, 1, 0.1), CANONICAL_RATE) as number;
    expect(level).toBeCloseTo(linearToDb(0.1 / Math.sqrt(2)), 1);
  });

  it('ignores pauses', () => {
    const tone = sine(440, CANONICAL_RATE, 0.5, 0.1);
    const withPause = new Float32Array(tone.length * 3);
    withPause.set(tone, 0);
    withPause.set(tone, tone.length * 2);
    const level = measureSpeechRmsDb(withPause, CANONICAL_RATE) as number;
    expect(level).toBeCloseTo(linearToDb(0.1 / Math.sqrt(2)), 1);
  });

  it('returns null for silence', () => {
    expect(measureSpeechRmsDb(new Float32Array(48_000), CANONICAL_RATE)).toBeNull();
  });
});

describe('limitPeaks', () => {
  it('keeps every sample at or below the ceiling and leaves quiet audio alone', () => {
    const samples = sine(200, CANONICAL_RATE, 0.5, 0.5);
    samples[12_000] = 3;
    samples[12_001] = -2.5;
    const quietBefore = samples[100] as number;
    limitPeaks(samples, 0.9, CANONICAL_RATE);
    let peak = 0;
    for (const s of samples) peak = Math.max(peak, Math.abs(s));
    expect(peak).toBeLessThanOrEqual(0.9 + 1e-6);
    expect(samples[100]).toBeCloseTo(quietBefore, 6);
  });

  it('does nothing when no sample is above the ceiling', () => {
    const samples = sine(200, CANONICAL_RATE, 0.1, 0.5);
    const copy = Float32Array.from(samples);
    limitPeaks(samples, 0.9, CANONICAL_RATE);
    expect(Array.from(samples)).toEqual(Array.from(copy));
  });
});

describe('fadeEdges', () => {
  it('starts and ends at zero', () => {
    const samples = new Float32Array(48_000).fill(0.5);
    fadeEdges(samples, CANONICAL_RATE);
    expect(samples[0]).toBe(0);
    expect(samples[samples.length - 1]).toBe(0);
    expect(samples[24_000]).toBe(0.5);
  });
});

describe('floatToInt16', () => {
  it('rounds and clips', () => {
    expect(Array.from(floatToInt16(Float32Array.from([0, 0.5, -0.5, 2, -2])))).toEqual([
      0, 16384, -16383, 32767, -32768,
    ]);
  });
});

describe('processSpeechClip', () => {
  it('brings quiet and loud voices to the same level and respects the peak ceiling', () => {
    const quiet = processSpeechClip({ samples: burst(0.3, 0.6, 0.5, 0.02, 24_000), sampleRate: 24_000 });
    const loud = processSpeechClip({ samples: burst(0.3, 0.6, 0.5, 0.9, 24_000), sampleRate: 24_000 });
    expect(quiet).not.toBeNull();
    expect(loud).not.toBeNull();
    const levels = [quiet, loud].map((clip) => {
      const floats = Float32Array.from(clip?.pcm as Int16Array, (v) => v / 32768);
      // Measure the middle of the tone only.
      const mid = floats.subarray(
        Math.round(0.2 * CANONICAL_RATE),
        floats.length - Math.round(0.2 * CANONICAL_RATE),
      );
      return linearToDb(rms(mid));
    });
    expect(levels[0]).toBeCloseTo(-18, 0);
    expect(levels[1]).toBeCloseTo(-18, 0);
    for (const clip of [quiet, loud]) {
      let peak = 0;
      for (const s of clip?.pcm ?? []) peak = Math.max(peak, Math.abs(s));
      expect(peak).toBeLessThanOrEqual(Math.ceil(dbToLinear(-1) * 32767));
    }
  });

  it('outputs 48 kHz audio with 60 ms of quiet around the sound', () => {
    const clip = processSpeechClip({ samples: burst(0.5, 0.4, 0.9, 0.3, 24_000), sampleRate: 24_000 });
    const seconds = (clip?.pcm.length as number) / CANONICAL_RATE;
    expect(seconds).toBeGreaterThan(0.4 + 0.11);
    expect(seconds).toBeLessThan(0.4 + 0.13);
  });

  it('applies a gain of at most 30 dB', () => {
    const clip = processSpeechClip({ samples: burst(0.1, 0.5, 0.1, 0.01), sampleRate: CANONICAL_RATE });
    expect(clip?.gainDb).toBeLessThanOrEqual(30);
  });

  it('returns null for silence and replaces invalid samples with silence', () => {
    expect(processSpeechClip({ samples: new Float32Array(48_000), sampleRate: CANONICAL_RATE })).toBeNull();
    const broken = new Float32Array(48_000).fill(Number.NaN);
    expect(processSpeechClip({ samples: broken, sampleRate: CANONICAL_RATE })).toBeNull();
  });
});

describe('joinWithGaps', () => {
  it('trims each piece and puts a pause between them', () => {
    const a = burst(0.4, 0.2, 0.4, 0.3);
    const b = burst(0.4, 0.2, 0.4, 0.3);
    const joined = joinWithGaps([a, b], CANONICAL_RATE, 0.16, 0.04);
    const piece = Math.round(0.2 * CANONICAL_RATE) + 2 * Math.round(0.04 * CANONICAL_RATE);
    expect(Math.abs(joined.length - (2 * piece + Math.round(0.16 * CANONICAL_RATE)))).toBeLessThanOrEqual(4);
  });

  it('skips silent pieces and returns empty for all-silent input', () => {
    const a = burst(0.1, 0.2, 0.1, 0.3);
    expect(joinWithGaps([new Float32Array(1000), a], CANONICAL_RATE).length).toBeGreaterThan(0);
    expect(joinWithGaps([new Float32Array(1000)], CANONICAL_RATE).length).toBe(0);
  });
});
