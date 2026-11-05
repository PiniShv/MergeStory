import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveFfmpeg } from '../core/binaries.ts';
import type { Config } from '../core/config.ts';
import type { MergeStoryError } from '../core/errors.ts';
import { type RunOptions, type RunResult, runCommand } from '../core/process.ts';
import type { NarrationClip, NarrationResult, Timeline } from '../core/types.ts';
import { FakeTts, makeStoryboard, makeTestContext, makeTimeline } from '../testing/narration.ts';
import {
  assembleNarrationTrack,
  normalizeLoudness,
  parseLoudnorm,
  TARGET_LUFS,
  TRUE_PEAK_DB,
} from './assemble.ts';
import type { RunFn } from './convert.ts';
import { synthesizeNarration } from './index.ts';
import { CANONICAL_RATE, encodeWavPcm16, parseWavHeader, readCanonicalWav } from './wav.ts';

const ffmpegAvailable = await resolveFfmpeg({ render: { ffmpegPath: null, ffprobePath: null } } as Pick<
  Config,
  'render'
>).then(
  () => true,
  () => false,
);

async function writeClip(
  dir: string,
  name: string,
  samples: Int16Array,
  rate = CANONICAL_RATE,
): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, encodeWavPcm16(samples, rate));
  return path;
}

function clip(sceneId: string, beatIndex: number, audioPath: string | null, durationSec = 1): NarrationClip {
  return { sceneId, beatIndex, text: 'x', spokenText: 'x', audioPath, durationSec, cached: false };
}

function narrationOf(clips: NarrationClip[]): NarrationResult {
  return { provider: 'fake', voice: null, clips };
}

/** Placement tests look at exact samples, so they skip the loudness stage. */
const assembleRaw = (
  narration: NarrationResult,
  timeline: Timeline,
  out: string,
  ctx: Parameters<typeof assembleNarrationTrack>[3],
  run?: RunFn,
) => assembleNarrationTrack(narration, timeline, out, ctx, { loudness: false }, run);

function simpleTimeline(
  beats: { sceneId: string; index: number; startSec: number; durationSec: number }[],
  total = 10,
): Timeline {
  const sceneIds = [...new Set(beats.map((b) => b.sceneId))];
  return {
    durationSec: total,
    scenes: sceneIds.map((sceneId) => ({
      sceneId,
      startSec: 0,
      durationSec: total,
      transitionSec: 0,
      beats: beats
        .filter((b) => b.sceneId === sceneId)
        .map(({ index, startSec, durationSec }) => ({ index, startSec, durationSec })),
    })),
    outro: { startSec: total - 3, durationSec: 3 },
  };
}

describe('assembleNarrationTrack: placement', () => {
  it('copies each clip to its beat start on a silent 48 kHz mono track that is 0.5 s longer than the timeline', async () => {
    const { ctx, dir, cleanup } = await makeTestContext();
    const a = await writeClip(dir, 'a.wav', new Int16Array(100).fill(1000));
    const b = await writeClip(dir, 'b.wav', new Int16Array(50).fill(-2000));
    const timeline = simpleTimeline([
      { sceneId: 's1', index: 0, startSec: 1, durationSec: 2 },
      { sceneId: 's2', index: 0, startSec: 3.5, durationSec: 2 },
    ]);
    const out = join(dir, 'out', 'audio.wav');
    const path = await assembleRaw(narrationOf([clip('s1', 0, a), clip('s2', 0, b)]), timeline, out, ctx);
    expect(path).toBe(out);
    const bytes = await readFile(out);
    const info = parseWavHeader(bytes);
    expect(info).toMatchObject({ encoding: 'pcm', bitsPerSample: 16, channels: 1, sampleRate: 48_000 });
    const track = readCanonicalWav(bytes);
    expect(track.length).toBe(Math.ceil(10.5 * CANONICAL_RATE));
    const first = Math.round(1 * CANONICAL_RATE);
    const second = Math.round(3.5 * CANONICAL_RATE);
    for (let i = 0; i < track.length; i++) {
      const expected = i >= first && i < first + 100 ? 1000 : i >= second && i < second + 50 ? -2000 : 0;
      if (track[i] !== expected) throw new Error(`sample ${i}: expected ${expected}, got ${track[i]}`);
    }
    await cleanup();
  });

  it('matches clips to beats by scene id and beat index, in any order', async () => {
    const { ctx, dir, cleanup } = await makeTestContext();
    const a = await writeClip(dir, 'a.wav', new Int16Array(10).fill(111));
    const b = await writeClip(dir, 'b.wav', new Int16Array(10).fill(222));
    const timeline = simpleTimeline([
      { sceneId: 's1', index: 0, startSec: 1, durationSec: 1 },
      { sceneId: 's1', index: 1, startSec: 2, durationSec: 1 },
    ]);
    const out = join(dir, 'audio.wav');
    await assembleRaw(narrationOf([clip('s1', 1, b), clip('s1', 0, a)]), timeline, out, ctx);
    const track = readCanonicalWav(await readFile(out));
    expect(track[CANONICAL_RATE]).toBe(111);
    expect(track[2 * CANONICAL_RATE]).toBe(222);
    await cleanup();
  });

  it('adds overlapping clips and clips instead of wrapping around', async () => {
    const { ctx, dir, cleanup } = await makeTestContext();
    const a = await writeClip(dir, 'a.wav', new Int16Array(100).fill(20_000));
    const b = await writeClip(dir, 'b.wav', new Int16Array(100).fill(20_000));
    const timeline = simpleTimeline([
      { sceneId: 's1', index: 0, startSec: 1, durationSec: 1 },
      { sceneId: 's1', index: 1, startSec: 1, durationSec: 1 },
    ]);
    const out = join(dir, 'audio.wav');
    await assembleRaw(narrationOf([clip('s1', 0, a), clip('s1', 1, b)]), timeline, out, ctx);
    expect(readCanonicalWav(await readFile(out))[CANONICAL_RATE]).toBe(32_767);
    await cleanup();
  });

  it('cuts a clip that runs past the end of the track and warns when a clip is longer than its slot', async () => {
    const { ctx, dir, events, cleanup } = await makeTestContext();
    const long = await writeClip(dir, 'long.wav', new Int16Array(2 * CANONICAL_RATE).fill(500));
    const timeline = simpleTimeline([{ sceneId: 's1', index: 0, startSec: 9.5, durationSec: 0.5 }]);
    const out = join(dir, 'audio.wav');
    await assembleRaw(narrationOf([clip('s1', 0, long, 2)]), timeline, out, ctx);
    const track = readCanonicalWav(await readFile(out));
    expect(track.length).toBe(Math.ceil(10.5 * CANONICAL_RATE));
    expect(track[track.length - 1]).toBe(500);
    expect(
      events.filter((e) => e.status === 'warn').some((e) => e.message.includes('longer than its slot')),
    ).toBe(true);
    await cleanup();
  });

  it('leaves out a clip that has no place on the timeline, and says so', async () => {
    const { ctx, dir, events, cleanup } = await makeTestContext();
    const a = await writeClip(dir, 'a.wav', new Int16Array(10).fill(700));
    const b = await writeClip(dir, 'b.wav', new Int16Array(10).fill(900));
    const timeline = simpleTimeline([{ sceneId: 's1', index: 0, startSec: 1, durationSec: 1 }]);
    const out = join(dir, 'audio.wav');
    await assembleRaw(narrationOf([clip('s1', 0, a), clip('s9', 0, b)]), timeline, out, ctx);
    const track = readCanonicalWav(await readFile(out));
    expect(track[CANONICAL_RATE]).toBe(700);
    expect(track.includes(900)).toBe(false);
    expect(events.some((e) => e.status === 'warn' && e.message.includes('s9'))).toBe(true);
    await cleanup();
  });

  it('converts a clip that is not in the track format', async () => {
    const { ctx, dir, cleanup } = await makeTestContext();
    const slow = await writeClip(dir, 'slow.wav', new Int16Array(2400).fill(3000), 24_000);
    const timeline = simpleTimeline([{ sceneId: 's1', index: 0, startSec: 1, durationSec: 1 }]);
    const out = join(dir, 'audio.wav');
    await assembleRaw(narrationOf([clip('s1', 0, slow)]), timeline, out, ctx);
    const track = readCanonicalWav(await readFile(out));
    expect(track[CANONICAL_RATE + 2000]).toBeGreaterThan(2900);
    expect(track[CANONICAL_RATE + 2000]).toBeLessThan(3100);
    expect(track[CANONICAL_RATE + 4700]).toBeGreaterThan(2900);
    expect(track[CANONICAL_RATE + 5200]).toBe(0);
    await cleanup();
  });

  it('writes the file with private permissions and creates the folder', async () => {
    const { ctx, dir, cleanup } = await makeTestContext();
    const a = await writeClip(dir, 'a.wav', new Int16Array(10).fill(1));
    const out = join(dir, 'new', 'folder', 'audio.wav');
    await assembleRaw(
      narrationOf([clip('s1', 0, a)]),
      simpleTimeline([{ sceneId: 's1', index: 0, startSec: 0, durationSec: 1 }]),
      out,
      ctx,
    );
    expect((await stat(out)).mode & 0o777).toBe(0o600);
    await cleanup();
  });

  it('works end to end with synthesized clips', async () => {
    const { ctx, dir, cleanup } = await makeTestContext();
    const storyboard = makeStoryboard({ s1: ['one two three four five'], s2: ['six seven eight'] });
    const narration = await synthesizeNarration(storyboard, new FakeTts(), ctx);
    const timeline = makeTimeline(storyboard, 3, 0.5);
    const out = join(dir, 'audio.wav');
    await assembleRaw(narration, timeline, out, ctx);
    const track = readCanonicalWav(await readFile(out));
    const windowRms = (fromSec: number, toSec: number): number => {
      let sum = 0;
      const from = Math.round(fromSec * CANONICAL_RATE);
      const to = Math.round(toSec * CANONICAL_RATE);
      for (let i = from; i < to; i++) sum += (track[i] as number) ** 2;
      return Math.sqrt(sum / (to - from)) / 32768;
    };
    const firstBeat = timeline.scenes[0]?.beats[0]?.startSec as number;
    expect(windowRms(0, firstBeat - 0.01)).toBe(0);
    expect(windowRms(firstBeat + 0.2, firstBeat + 1)).toBeGreaterThan(0.05);
    const secondBeat = timeline.scenes[1]?.beats[0]?.startSec as number;
    expect(windowRms(secondBeat + 0.2, secondBeat + 0.7)).toBeGreaterThan(0.05);
    await cleanup();
  });
});

describe('assembleNarrationTrack: no audio', () => {
  it('returns null and writes nothing when no clip has audio and there is no music', async () => {
    const { ctx, dir, cleanup } = await makeTestContext();
    const out = join(dir, 'audio.wav');
    const result = await assembleRaw(
      narrationOf([clip('s1', 0, null), clip('s1', 1, null)]),
      simpleTimeline([]),
      out,
      ctx,
    );
    expect(result).toBeNull();
    await expect(stat(out)).rejects.toThrow();
    expect(await assembleRaw(narrationOf([]), simpleTimeline([]), out, ctx)).toBeNull();
    await cleanup();
  });
});

describe('assembleNarrationTrack: background music', () => {
  const timeline = simpleTimeline([{ sceneId: 's1', index: 0, startSec: 1, durationSec: 1 }], 6);

  it('rejects a music file that does not exist', async () => {
    const { ctx, dir, cleanup } = await makeTestContext({
      config: { render: { musicPath: '/nonexistent/music.mp3' } },
    });
    const a = await writeClip(dir, 'a.wav', new Int16Array(100).fill(1000));
    const error = (await assembleRaw(
      narrationOf([clip('s1', 0, a)]),
      timeline,
      join(dir, 'audio.wav'),
      ctx,
    ).catch((e: unknown) => e)) as MergeStoryError;
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.hint).toContain('render.musicPath');
    await cleanup();
  });

  it('asks FFmpeg for a quiet, looped, faded and ducked bed and adds it to the narration in Node', async () => {
    const { dir, cleanup } = await makeTestContext();
    const musicFile = await writeClip(dir, 'music.wav', new Int16Array(1000));
    const configured = await makeTestContext({
      config: {
        render: { musicPath: musicFile, ffmpegPath: process.execPath, ffprobePath: process.execPath },
      },
    });
    const a = await writeClip(dir, 'a.wav', new Int16Array(100).fill(1000));
    const bed = Buffer.alloc(Math.ceil(6.5 * CANONICAL_RATE) * 2);
    bed.writeInt16LE(250, 2 * CANONICAL_RATE * 1); // music sample under the first voice sample
    const calls: { command: string; args: string[]; options?: RunOptions }[] = [];
    const run = async (command: string, args: string[], options?: RunOptions): Promise<RunResult> => {
      calls.push({ command, args, options });
      return { code: 0, stdout: '', stderr: '', stdoutBuffer: bed };
    };
    const out = join(dir, 'audio.wav');
    await assembleRaw(narrationOf([clip('s1', 0, a)]), timeline, out, configured.ctx, run);
    const call = calls[0];
    expect(call?.command).toBe(process.execPath);
    const args = call?.args ?? [];
    expect(args.slice(args.indexOf('-stream_loop'), args.indexOf('-stream_loop') + 4)).toEqual([
      '-stream_loop',
      '-1',
      '-i',
      musicFile,
    ]);
    const graph = args[args.indexOf('-filter_complex') + 1] ?? '';
    expect(graph).toContain('volume=-26dB');
    expect(graph).toContain('sidechaincompress');
    expect(graph).toContain('afade=t=out:st=4.500:d=2');
    expect(args[args.indexOf('-t') + 1]).toBe('6.500');
    expect(args).toContain('s16le');
    // The narration goes in on stdin as a WAV; nothing is written next to the output file.
    expect(parseWavHeader(call?.options?.input as Buffer).sampleRate).toBe(48_000);
    const track = readCanonicalWav(await readFile(out));
    expect(track[CANONICAL_RATE]).toBe(1250);
    expect(track[CANONICAL_RATE + 50]).toBe(1000);
    await Promise.all([cleanup(), configured.cleanup()]);
  });

  it('explains an FFmpeg failure', async () => {
    const { dir, cleanup } = await makeTestContext();
    const musicFile = await writeClip(dir, 'music.wav', new Int16Array(1000));
    const configured = await makeTestContext({
      config: {
        render: { musicPath: musicFile, ffmpegPath: process.execPath, ffprobePath: process.execPath },
      },
    });
    const a = await writeClip(dir, 'a.wav', new Int16Array(100).fill(1000));
    const run = async (): Promise<RunResult> => {
      throw new Error('Invalid data found when processing input');
    };
    const error = (await assembleRaw(
      narrationOf([clip('s1', 0, a)]),
      timeline,
      join(dir, 'audio.wav'),
      configured.ctx,
      run,
    ).catch((e: unknown) => e)) as MergeStoryError;
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.hint).toContain('playable audio file');
    await Promise.all([cleanup(), configured.cleanup()]);
  });

  describe.skipIf(!ffmpegAvailable)('with FFmpeg', () => {
    /** A loud stereo 330 Hz "song" that is shorter than the video, to prove it loops. */
    function songSamples(seconds: number): Int16Array {
      const samples = new Int16Array(Math.round(seconds * CANONICAL_RATE));
      for (let i = 0; i < samples.length; i++)
        samples[i] = Math.round(0.5 * 32767 * Math.sin((2 * Math.PI * 330 * i) / CANONICAL_RATE));
      return samples;
    }

    function rms(track: Int16Array, fromSec: number, toSec: number): number {
      const from = Math.round(fromSec * CANONICAL_RATE);
      const to = Math.round(toSec * CANONICAL_RATE);
      let sum = 0;
      for (let i = from; i < to; i++) sum += ((track[i] ?? 0) / 32768) ** 2;
      return Math.sqrt(sum / (to - from));
    }

    it('mixes quiet music under the narration, ducks it during speech and fades it out', async () => {
      const base = await makeTestContext();
      const music = await writeClip(base.dir, 'song.wav', songSamples(2));
      const withMusic = await makeTestContext({ config: { render: { musicPath: music } } });
      const voiceTone = new Int16Array(2 * CANONICAL_RATE);
      for (let i = 0; i < voiceTone.length; i++)
        voiceTone[i] = Math.round(0.12 * 32767 * Math.sin((2 * Math.PI * 220 * i) / CANONICAL_RATE));
      const voice = await writeClip(base.dir, 'voice.wav', voiceTone);
      const long = simpleTimeline([{ sceneId: 's1', index: 0, startSec: 3, durationSec: 2 }], 10);
      const narration = narrationOf([clip('s1', 0, voice, 2)]);

      const plainOut = join(base.dir, 'plain.wav');
      const mixedOut = join(base.dir, 'mixed.wav');
      await assembleRaw(narration, long, plainOut, base.ctx);
      await assembleRaw(narration, long, mixedOut, withMusic.ctx);
      const plain = readCanonicalWav(await readFile(plainOut));
      const mixed = readCanonicalWav(await readFile(mixedOut));
      expect(mixed.length).toBe(plain.length);

      const bed = new Int16Array(mixed.length);
      for (let i = 0; i < bed.length; i++) bed[i] = (mixed[i] as number) - (plain[i] as number);
      // The song is 2 s long, so music at 7 s proves it was looped. -26 dB of a 0.5 sine = 0.0177 RMS.
      const quietPart = rms(bed, 6, 7.5);
      expect(quietPart).toBeGreaterThan(0.013);
      expect(quietPart).toBeLessThan(0.022);
      // While the voice speaks (3 s to 5 s) the music is lower.
      expect(rms(bed, 3.5, 4.5)).toBeLessThan(quietPart * 0.7);
      // The last second fades out.
      expect(rms(bed, 9.2, 10)).toBeLessThan(quietPart * 0.5);
      // The narration itself is unchanged.
      expect(rms(plain, 3.2, 4.8)).toBeGreaterThan(0.08);
      await Promise.all([base.cleanup(), withMusic.cleanup()]);
    });

    it('makes a music-only track when there is no speech', async () => {
      const base = await makeTestContext();
      const music = await writeClip(base.dir, 'song.wav', songSamples(1));
      const { ctx, cleanup } = await makeTestContext({ config: { render: { musicPath: music } } });
      const out = join(base.dir, 'audio.wav');
      const path = await assembleRaw(narrationOf([clip('s1', 0, null)]), simpleTimeline([], 4), out, ctx);
      expect(path).toBe(out);
      const track = readCanonicalWav(await readFile(out));
      expect(track.length).toBe(Math.ceil(4.5 * CANONICAL_RATE));
      expect(rms(track, 0.5, 1.5)).toBeGreaterThan(0.01);
      await Promise.all([base.cleanup(), cleanup()]);
    });
  });
});

describe('parseLoudnorm', () => {
  const printed = `[Parsed_loudnorm_0 @ 0x1234]
{
	"input_i" : "-19.69",
	"input_tp" : "-4.12",
	"input_lra" : "2.30",
	"input_thresh" : "-29.87",
	"output_i" : "-16.03",
	"output_tp" : "-1.50",
	"output_lra" : "2.30",
	"output_thresh" : "-26.21",
	"normalization_type" : "dynamic",
	"target_offset" : "0.03"
}
`;

  it('reads the measurement that the first pass prints', () => {
    expect(parseLoudnorm(`frame=1 size=N/A\n${printed}`)).toEqual({
      integrated: -19.69,
      truePeak: -4.12,
      range: 2.3,
      threshold: -29.87,
      offset: 0.03,
    });
  });

  it('gives up on silence and on output it does not know', () => {
    expect(parseLoudnorm(printed.replace('"-19.69"', '"-inf"'))).toBeNull();
    expect(parseLoudnorm('nothing to see here')).toBeNull();
    expect(parseLoudnorm('{ "input_i" : "oops" }')).toBeNull();
  });
});

describe('normalizeLoudness with a replaceable runner', () => {
  const pass1 = (integrated: string, peak = '-4.12') => `{
	"input_i" : "${integrated}",
	"input_tp" : "${peak}",
	"input_lra" : "2.30",
	"input_thresh" : "-29.87",
	"output_i" : "-16.00",
	"output_tp" : "-1.50",
	"output_lra" : "2.30",
	"output_thresh" : "-26.21",
	"normalization_type" : "dynamic",
	"target_offset" : "0.03"
}`;
  const speech = () => new Int16Array(3 * CANONICAL_RATE).fill(800);
  const configured = () =>
    makeTestContext({ config: { render: { ffmpegPath: process.execPath, ffprobePath: process.execPath } } });

  it('measures first, then applies the target with the measured values in one more pass', async () => {
    const { ctx, cleanup } = await configured();
    const calls: { args: string[]; options?: RunOptions }[] = [];
    const louder = Buffer.alloc(3 * CANONICAL_RATE * 2);
    for (let i = 0; i < 3 * CANONICAL_RATE; i++) louder.writeInt16LE(1500, i * 2);
    const run = async (_command: string, args: string[], options?: RunOptions): Promise<RunResult> => {
      calls.push({ args, options });
      return calls.length === 1
        ? { code: 0, stdout: '', stderr: pass1('-19.69'), stdoutBuffer: Buffer.alloc(0) }
        : { code: 0, stdout: '', stderr: '', stdoutBuffer: louder };
    };
    const out = await normalizeLoudness(speech(), ctx, run);
    expect(calls).toHaveLength(2);
    const filter = (i: number) => calls[i]?.args[(calls[i]?.args.indexOf('-af') ?? -1) + 1] ?? '';
    expect(filter(0)).toBe(`loudnorm=I=${TARGET_LUFS}:TP=${TRUE_PEAK_DB}:LRA=11:print_format=json`);
    expect(filter(1)).toContain('measured_I=-19.69');
    expect(filter(1)).toContain('measured_TP=-4.12');
    expect(filter(1)).toContain('offset=0.03');
    expect(filter(1)).toContain('linear=true');
    expect(filter(1)).toContain('aresample=48000');
    expect(calls[1]?.args).toContain('s16le');
    // Both passes read the same WAV from standard input; nothing is written to disk.
    expect(parseWavHeader(calls[0]?.options?.input as Buffer).sampleRate).toBe(48_000);
    expect(calls[1]?.options?.input).toBe(calls[0]?.options?.input);
    expect(out.length).toBe(3 * CANONICAL_RATE);
    expect(out[0]).toBe(1500);
    expect(out[out.length - 1]).toBe(1500);
    await cleanup();
  });

  it('keeps the length of the track when the result is longer or shorter', async () => {
    const { ctx, cleanup } = await configured();
    const make = (samples: number) => {
      const buffer = Buffer.alloc(samples * 2);
      for (let i = 0; i < samples; i++) buffer.writeInt16LE(900, i * 2);
      return buffer;
    };
    for (const samples of [3 * CANONICAL_RATE + 500, 3 * CANONICAL_RATE - 500]) {
      let n = 0;
      const run = async (): Promise<RunResult> => {
        n += 1;
        return n === 1
          ? { code: 0, stdout: '', stderr: pass1('-25'), stdoutBuffer: Buffer.alloc(0) }
          : { code: 0, stdout: '', stderr: '', stdoutBuffer: make(samples) };
      };
      const out = await normalizeLoudness(speech(), ctx, run);
      expect(out.length).toBe(3 * CANONICAL_RATE);
      expect(out[0]).toBe(900);
      expect(out[out.length - 1]).toBe(samples > 3 * CANONICAL_RATE ? 900 : 0);
    }
    await cleanup();
  });

  it('does nothing to a track that is already on target', async () => {
    const { ctx, cleanup } = await configured();
    let calls = 0;
    const run = async (): Promise<RunResult> => {
      calls += 1;
      return { code: 0, stdout: '', stderr: pass1('-16.2', '-3.0'), stdoutBuffer: Buffer.alloc(0) };
    };
    const input = speech();
    const out = await normalizeLoudness(input, ctx, run);
    expect(calls).toBe(1);
    expect(out).toBe(input);
    await cleanup();
  });

  it('still corrects a track at the right loudness whose peak is too high', async () => {
    const { ctx, cleanup } = await configured();
    let calls = 0;
    const run = async (): Promise<RunResult> => {
      calls += 1;
      return { code: 0, stdout: '', stderr: pass1('-16.1', '-0.2'), stdoutBuffer: Buffer.alloc(8) };
    };
    await normalizeLoudness(speech(), ctx, run);
    expect(calls).toBe(2);
    await cleanup();
  });

  it('leaves short, silent and unmeasurable tracks alone without asking FFmpeg', async () => {
    const { ctx, cleanup } = await configured();
    let calls = 0;
    const run = async (): Promise<RunResult> => {
      calls += 1;
      return { code: 0, stdout: '', stderr: 'no measurement', stdoutBuffer: Buffer.alloc(0) };
    };
    const short = new Int16Array(1000).fill(500);
    expect(await normalizeLoudness(short, ctx, run)).toBe(short);
    const silent = new Int16Array(3 * CANONICAL_RATE);
    expect(await normalizeLoudness(silent, ctx, run)).toBe(silent);
    expect(calls).toBe(0);
    // Long enough, but FFmpeg prints no measurement: the track stays as it is.
    const quiet = speech();
    expect(await normalizeLoudness(quiet, ctx, run)).toBe(quiet);
    expect(calls).toBe(1);
    await cleanup();
  });

  it('keeps the track and warns when FFmpeg fails', async () => {
    const { ctx, events, cleanup } = await configured();
    const run = async (): Promise<RunResult> => {
      throw new Error('Invalid data found when processing input');
    };
    const input = speech();
    expect(await normalizeLoudness(input, ctx, run)).toBe(input);
    expect(events.some((e) => e.status === 'warn' && e.message.includes('standard loudness'))).toBe(true);
    await cleanup();
  });

  it('keeps the track when FFmpeg is not installed', async () => {
    const { ctx, cleanup } = await makeTestContext({
      config: { render: { ffmpegPath: '/nonexistent/ffmpeg', ffprobePath: '/nonexistent/ffprobe' } },
    });
    const run = async (): Promise<RunResult> => {
      throw new Error('must not run');
    };
    const input = speech();
    expect(await normalizeLoudness(input, ctx, run)).toBe(input);
    await cleanup();
  });
});

describe.skipIf(!ffmpegAvailable)('normalizeLoudness with FFmpeg', () => {
  /** Integrated loudness (LUFS) and true peak (dBTP) of a track, measured by FFmpeg. */
  async function measure(track: Int16Array): Promise<{ lufs: number; peak: number }> {
    const { ctx, cleanup } = await makeTestContext();
    const { ffmpeg } = await resolveFfmpeg(ctx.config);
    const result = await runCommand(
      ffmpeg,
      ['-hide_banner', '-nostats', '-i', 'pipe:0', '-af', 'ebur128=peak=true', '-f', 'null', '-'],
      { input: encodeWavPcm16(track, CANONICAL_RATE) },
    );
    await cleanup();
    const summary = result.stderr.slice(result.stderr.lastIndexOf('Summary:'));
    const lufs = Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1]);
    const peak = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(summary)?.[1]);
    return { lufs, peak };
  }

  /** Two bursts of a voice-like tone with a little vibrato, at the given amplitude. */
  function speechLike(amplitude: number, seconds = 8): Int16Array {
    const track = new Int16Array(seconds * CANONICAL_RATE);
    for (const [from, to] of [
      [1, 3.5],
      [4.5, 7],
    ] as const) {
      for (let i = Math.round(from * CANONICAL_RATE); i < Math.round(to * CANONICAL_RATE); i++) {
        const t = i / CANONICAL_RATE;
        const tone =
          Math.sin(2 * Math.PI * 180 * t) +
          0.5 * Math.sin(2 * Math.PI * 360 * t + Math.sin(2 * Math.PI * 5 * t));
        track[i] = Math.round(amplitude * 32767 * 0.66 * tone);
      }
    }
    return track;
  }

  /** First sample that is clearly above silence. */
  const onset = (track: Int16Array) => track.findIndex((v) => Math.abs(v) > 300);

  it('brings a quiet narration to -16 LUFS without passing the peak ceiling', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const input = speechLike(0.05);
    const before = await measure(input);
    expect(before.lufs).toBeLessThan(-26);
    const out = await normalizeLoudness(input, ctx, runCommand);
    const after = await measure(out);
    expect(after.lufs).toBeGreaterThan(TARGET_LUFS - 0.6);
    expect(after.lufs).toBeLessThan(TARGET_LUFS + 0.6);
    expect(after.peak).toBeLessThanOrEqual(TRUE_PEAK_DB + 0.1);
    await cleanup();
  });

  it('turns a loud narration down and respects the peak ceiling', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const input = speechLike(0.95);
    const before = await measure(input);
    expect(before.lufs).toBeGreaterThan(TARGET_LUFS + 2);
    const after = await measure(await normalizeLoudness(input, ctx, runCommand));
    expect(Math.abs(after.lufs - TARGET_LUFS)).toBeLessThan(0.7);
    expect(after.peak).toBeLessThanOrEqual(TRUE_PEAK_DB + 0.1);
    await cleanup();
  });

  it('keeps the length and the timing of every sound', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const input = speechLike(0.05);
    const out = await normalizeLoudness(input, ctx, runCommand);
    expect(out.length).toBe(input.length);
    // The first burst starts at 1 s and the second at 4.5 s, to within a millisecond.
    const first = onset(out);
    expect(Math.abs(first - onset(input))).toBeLessThanOrEqual(48);
    const secondIn = input.findIndex((v, i) => i > 3.6 * CANONICAL_RATE && Math.abs(v) > 300);
    const secondOut = out.findIndex((v, i) => i > 3.6 * CANONICAL_RATE && Math.abs(v) > 300);
    expect(Math.abs(secondOut - secondIn)).toBeLessThanOrEqual(48);
    // The silence between the bursts stays silent.
    let quiet = 0;
    for (let i = Math.round(3.8 * CANONICAL_RATE); i < Math.round(4.3 * CANONICAL_RATE); i++)
      quiet = Math.max(quiet, Math.abs(out[i] ?? 0));
    expect(quiet).toBeLessThan(40);
    await cleanup();
  });

  it('is what assembleNarrationTrack does by default', async () => {
    const { ctx, dir, cleanup } = await makeTestContext();
    const speech = speechLike(0.05, 6);
    const path = await writeClip(dir, 'speech.wav', speech);
    const timeline = simpleTimeline([{ sceneId: 's1', index: 0, startSec: 0, durationSec: 6 }], 6);
    const out = join(dir, 'audio.wav');
    await assembleNarrationTrack(narrationOf([clip('s1', 0, path, 6)]), timeline, out, ctx);
    const track = readCanonicalWav(await readFile(out));
    expect(track.length).toBe(Math.ceil(6.5 * CANONICAL_RATE));
    const result = await measure(track);
    expect(Math.abs(result.lufs - TARGET_LUFS)).toBeLessThan(0.8);
    expect(result.peak).toBeLessThanOrEqual(TRUE_PEAK_DB + 0.1);
    await cleanup();
  });
});
