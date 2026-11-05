import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveFfmpeg } from '../core/binaries.ts';
import type { Config } from '../core/config.ts';
import type { MergeStoryError } from '../core/errors.ts';
import { type RunOptions, type RunResult, runCommand } from '../core/process.ts';
import { makeTestContext, pcmTone } from '../testing/narration.ts';
import { decodeTtsResult, joinPcmS16le } from './convert.ts';
import { encodeWavFloat32, encodeWavPcm16 } from './wav.ts';

const ffmpegAvailable = await resolveFfmpeg({ render: { ffmpegPath: null, ffprobePath: null } } as Pick<
  Config,
  'render'
>).then(
  () => true,
  () => false,
);

describe('decodeTtsResult', () => {
  it('decodes raw 16-bit PCM using the stated sample rate', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const audio = pcmTone(1, 24_000, 0.5);
    const mono = await decodeTtsResult(
      { audio, format: 'pcm_s16le', sampleRate: 24_000, channels: 1, characters: 5 },
      ctx,
    );
    expect(mono.sampleRate).toBe(24_000);
    expect(mono.samples.length).toBe(24_000);
    expect(Math.max(...mono.samples)).toBeCloseTo(0.5, 2);
    await cleanup();
  });

  it('averages the channels of raw PCM and needs a sample rate', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const samples = Int16Array.from([16384, -16384, 8192, 8192]);
    const bytes = Buffer.alloc(8);
    for (const [i, v] of samples.entries()) bytes.writeInt16LE(v, i * 2);
    const mono = await decodeTtsResult(
      { audio: bytes, format: 'pcm_s16le', sampleRate: 24_000, channels: 2, characters: 1 },
      ctx,
    );
    expect(Array.from(mono.samples)).toEqual([0, 0.25]);
    await expect(
      decodeTtsResult(
        { audio: bytes, format: 'pcm_s16le', sampleRate: null, channels: 1, characters: 1 },
        ctx,
      ),
    ).rejects.toThrow(/sample rate/);
    await cleanup();
  });

  it('decodes 16-bit and float WAV files in Node, without FFmpeg', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const run = vi.fn();
    const pcm = await decodeTtsResult(
      {
        audio: encodeWavPcm16(Int16Array.from([8192, -8192]), 24_000),
        format: 'wav',
        sampleRate: 24_000,
        channels: 1,
        characters: 1,
      },
      ctx,
      run,
    );
    expect(Array.from(pcm.samples)).toEqual([0.25, -0.25]);
    const float = await decodeTtsResult(
      {
        audio: encodeWavFloat32(Float32Array.from([0.5, -0.125]), 24_000),
        format: 'wav',
        sampleRate: 24_000,
        channels: 1,
        characters: 1,
      },
      ctx,
      run,
    );
    expect(Array.from(float.samples)).toEqual([0.5, -0.125]);
    expect(run).not.toHaveBeenCalled();
    await cleanup();
  });

  it('rejects empty audio with a next step', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const error = (await decodeTtsResult(
      { audio: Buffer.alloc(0), format: 'wav', sampleRate: null, channels: null, characters: 1 },
      ctx,
    ).catch((e: unknown) => e)) as MergeStoryError;
    expect(error.code).toBe('TTS_FAILED');
    expect(error.hint).toBeTruthy();
    await cleanup();
  });

  it('hands other formats to FFmpeg through pipes, with no file names involved', async () => {
    const { ctx, cleanup } = await makeTestContext({
      config: { render: { ffmpegPath: process.execPath, ffprobePath: process.execPath } },
    });
    const output = Buffer.alloc(8);
    output.writeFloatLE(0.5, 0);
    output.writeFloatLE(-0.5, 4);
    const calls: { command: string; args: string[]; options?: RunOptions }[] = [];
    const run = async (command: string, args: string[], options?: RunOptions): Promise<RunResult> => {
      calls.push({ command, args, options });
      return { code: 0, stdout: '', stderr: '', stdoutBuffer: output };
    };
    const mp3 = Buffer.from('fake mp3 bytes');
    const mono = await decodeTtsResult(
      { audio: mp3, format: 'mp3', sampleRate: null, channels: null, characters: 1 },
      ctx,
      run,
    );
    expect(Array.from(mono.samples)).toEqual([0.5, -0.5]);
    expect(mono.sampleRate).toBe(48_000);
    expect(calls[0]?.command).toBe(process.execPath);
    expect(calls[0]?.args).toEqual([
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
      '48000',
      'pipe:1',
    ]);
    expect(calls[0]?.options?.input).toBe(mp3);
    await cleanup();
  });

  it('falls back to FFmpeg for a WAV that Node cannot read, and explains a decoding failure', async () => {
    const { ctx, cleanup } = await makeTestContext({
      config: { render: { ffmpegPath: process.execPath, ffprobePath: process.execPath } },
    });
    const run = vi.fn(async (): Promise<RunResult> => {
      throw new Error('Invalid data found when processing input');
    });
    const error = (await decodeTtsResult(
      {
        audio: Buffer.from('RIFF....WAVEjunk'),
        format: 'wav',
        sampleRate: null,
        channels: null,
        characters: 1,
      },
      ctx,
      run,
    ).catch((e: unknown) => e)) as MergeStoryError;
    expect(run).toHaveBeenCalledOnce();
    expect(error.code).toBe('TTS_FAILED');
    expect(error.hint).toContain('another speech provider');
    await cleanup();
  });

  it.skipIf(!ffmpegAvailable)('decodes a real MP3 with FFmpeg', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const { ffmpeg } = await resolveFfmpeg(ctx.config);
    const dir = await mkdtemp(join(tmpdir(), 'mergestory-mp3-'));
    try {
      const file = join(dir, 'tone.mp3');
      await runCommand(ffmpeg, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=1',
        '-ar',
        '24000',
        '-ac',
        '1',
        file,
      ]);
      const mono = await decodeTtsResult(
        { audio: await readFile(file), format: 'mp3', sampleRate: null, channels: null, characters: 1 },
        ctx,
      );
      expect(mono.sampleRate).toBe(48_000);
      expect(mono.samples.length).toBeGreaterThan(40_000);
      expect(mono.samples.length).toBeLessThan(54_000);
      expect(Math.max(...mono.samples.subarray(10_000, 20_000))).toBeGreaterThan(0.1);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await cleanup();
    }
  });
});

describe('joinPcmS16le', () => {
  it('returns a single piece unchanged and joins several with pauses', () => {
    const one = pcmTone(1);
    expect(joinPcmS16le([one], 24_000)).toBe(one);
    const joined = joinPcmS16le([pcmTone(1), pcmTone(1)], 24_000);
    // Two tones of one second, each with 40 ms of edge silence, plus a pause of 160 ms.
    expect(joined.length / 2 / 24_000).toBeCloseTo(2 * 1.08 + 0.16, 2);
  });
});
