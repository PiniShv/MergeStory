/**
 * Turning a provider's audio into mono floats. WAV and raw PCM are decoded here; any other
 * container (or a WAV in an unusual encoding) is decoded by FFmpeg.
 */
import { resolveFfmpeg } from '../core/binaries.ts';
import type { RunContext } from '../core/context.ts';
import { MergeStoryError } from '../core/errors.ts';
import { runCommand } from '../core/process.ts';
import type { TtsResult } from '../core/providers.ts';
import { floatToInt16, joinWithGaps } from './audio.ts';
import { CANONICAL_RATE, decodeWavToMono, int16ToPcmS16le, type MonoAudio, pcmS16leToFloat } from './wav.ts';

export type RunFn = typeof runCommand;

async function decodeWithFfmpeg(
  result: TtsResult,
  ctx: Pick<RunContext, 'config' | 'signal'>,
  run: RunFn,
): Promise<MonoAudio> {
  const { ffmpeg } = await resolveFfmpeg(ctx.config);
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    'pipe:0',
    '-f',
    'f32le',
    '-ac',
    '1',
    '-ar',
    String(CANONICAL_RATE),
    'pipe:1',
  ];
  let output: Buffer;
  try {
    output = (await run(ffmpeg, args, { input: result.audio, signal: ctx.signal, timeoutMs: 120_000 }))
      .stdoutBuffer;
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    throw new MergeStoryError(
      'TTS_FAILED',
      `FFmpeg could not read the ${result.format} audio from the speech provider.`,
      {
        hint: 'Try another speech provider or voice.',
        cause: err,
      },
    );
  }
  const usable = output.byteLength - (output.byteLength % 4);
  const bytes = output.buffer.slice(output.byteOffset, output.byteOffset + usable);
  return { samples: new Float32Array(bytes), sampleRate: CANONICAL_RATE };
}

function toMono(samples: Float32Array, channels: number): Float32Array {
  if (channels <= 1) return samples;
  const frames = Math.floor(samples.length / channels);
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += samples[f * channels + c] ?? 0;
    out[f] = sum / channels;
  }
  return out;
}

/** Decode the audio of a speech result to mono floats at the result's own sample rate. */
export async function decodeTtsResult(
  result: TtsResult,
  ctx: Pick<RunContext, 'config' | 'signal'>,
  run: RunFn = runCommand,
): Promise<MonoAudio> {
  if (result.audio.length === 0) {
    throw new MergeStoryError('TTS_FAILED', 'The speech provider returned no audio.', {
      hint: 'Retry, or try another speech provider.',
    });
  }
  if (result.format === 'pcm_s16le') {
    if (!result.sampleRate) {
      throw new MergeStoryError('INTERNAL', 'Raw PCM audio needs a sample rate.');
    }
    return {
      samples: toMono(pcmS16leToFloat(result.audio), result.channels ?? 1),
      sampleRate: result.sampleRate,
    };
  }
  if (result.format === 'wav') {
    try {
      return decodeWavToMono(result.audio);
    } catch {
      return decodeWithFfmpeg(result, ctx, run);
    }
  }
  return decodeWithFfmpeg(result, ctx, run);
}

/** Join raw 16-bit PCM pieces from several requests into one buffer, with short pauses between them. */
export function joinPcmS16le(pieces: Buffer[], sampleRate: number): Buffer {
  const [only] = pieces;
  if (pieces.length === 1 && only) return only;
  const joined = joinWithGaps(pieces.map(pcmS16leToFloat), sampleRate);
  return int16ToPcmS16le(floatToInt16(joined));
}
