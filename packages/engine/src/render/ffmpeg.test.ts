import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveFfmpeg } from '../core/binaries.ts';
import { runCommand } from '../core/process.ts';
import { testConfig } from '../testing/context.ts';
import { probeMedia } from '../testing/media.ts';
import {
  COLOR_FILTER,
  concatAndMux,
  concatListText,
  muxArgs,
  probeDuration,
  SegmentEncoder,
  segmentEncodeArgs,
} from './ffmpeg.ts';

const tools = await resolveFfmpeg(testConfig()).catch(() => null);

describe('segmentEncodeArgs', () => {
  const args = segmentEncodeArgs({
    fps: 30,
    crf: 23,
    x264Preset: 'medium',
    gop: 60,
    threads: 2,
    outPath: '/tmp/out/segment-0000.mp4',
  });
  const flagValue = (flag: string): string | undefined => args[args.indexOf(flag) + 1];

  it('reads JPEG frames from stdin at the plan frame rate', () => {
    expect(args.slice(args.indexOf('-f'), args.indexOf('-f') + 8)).toEqual([
      '-f',
      'image2pipe',
      '-framerate',
      '30',
      '-c:v',
      'mjpeg',
      '-i',
      '-',
    ]);
  });

  it('converts the colour range and matrix and tags the result as limited-range BT.709', () => {
    expect(flagValue('-vf')).toBe(COLOR_FILTER);
    expect(COLOR_FILTER).toContain('in_range=full:in_color_matrix=bt601');
    expect(COLOR_FILTER).toContain('out_range=limited:out_color_matrix=bt709');
    expect(COLOR_FILTER).toContain('format=yuv420p');
    expect(COLOR_FILTER).toContain(
      'setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709',
    );
    expect(flagValue('-pix_fmt')).toBe('yuv420p');
    expect(flagValue('-color_range')).toBe('tv');
    expect(flagValue('-colorspace')).toBe('bt709');
  });

  it('uses the preset, a fixed keyframe interval and a fixed thread count', () => {
    expect(flagValue('-preset')).toBe('medium');
    expect(flagValue('-crf')).toBe('23');
    expect(flagValue('-g')).toBe('60');
    expect(flagValue('-keyint_min')).toBe('60');
    expect(flagValue('-sc_threshold')).toBe('0');
    expect(flagValue('-threads')).toBe('2');
  });

  it('drops audio and metadata, and ends with the output path', () => {
    expect(args).toContain('-an');
    expect(flagValue('-map_metadata')).toBe('-1');
    expect(args).toContain('+bitexact');
    expect(args.at(-1)).toBe('/tmp/out/segment-0000.mp4');
  });
});

describe('muxArgs', () => {
  it('joins segments without re-encoding, strips the encoder text and moves the index to the front', () => {
    const args = muxArgs({
      listPath: '/tmp/l.txt',
      audioPath: null,
      outPath: '/tmp/video.mp4',
      durationSec: 10,
    });
    expect(args).toEqual(
      expect.arrayContaining([
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        '/tmp/l.txt',
        '-c:v',
        'copy',
        '-bsf:v',
        'filter_units=remove_types=6',
      ]),
    );
    expect(args).toEqual(expect.arrayContaining(['-movflags', '+faststart', '-map_metadata', '-1']));
    expect(args).not.toContain('-c:a');
    expect(args.at(-1)).toBe('/tmp/video.mp4');
  });

  it('adds the narration as 48 kHz AAC, padded or cut to the video length', () => {
    const args = muxArgs({
      listPath: '/tmp/l.txt',
      audioPath: '/tmp/a.wav',
      outPath: '/tmp/video.mp4',
      durationSec: 12.5,
    });
    expect(args).toEqual(
      expect.arrayContaining([
        '-i',
        '/tmp/a.wav',
        '-map',
        '1:a:0',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-ar',
        '48000',
        '-af',
        'apad',
        '-t',
        '12.500000',
      ]),
    );
  });
});

describe('concatListText', () => {
  it('writes one quoted line per file', () => {
    expect(concatListText(['/tmp/a.mp4', '/tmp/b.mp4'])).toBe("file '/tmp/a.mp4'\nfile '/tmp/b.mp4'\n");
  });

  it('escapes single quotes', () => {
    expect(concatListText(["/tmp/it's here/seg.mp4"], 'linux')).toBe("file '/tmp/it'\\''s here/seg.mp4'\n");
  });

  it('uses forward slashes on Windows and refuses line breaks', () => {
    expect(concatListText(['C:\\out\\seg.mp4'], 'win32')).toBe("file 'C:/out/seg.mp4'\n");
    expect(() => concatListText(['/tmp/a\nb.mp4'])).toThrow(/line break/);
  });
});

describe.skipIf(!tools)('with FFmpeg', () => {
  let dir: string;
  let jpeg: (colour: string) => Promise<Buffer>;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mergestory-ffmpeg-'));
    jpeg = async (colour) =>
      (
        await runCommand(tools!.ffmpeg, [
          ...['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${colour}:s=128x72`],
          ...['-frames:v', '1', '-pix_fmt', 'yuvj420p', '-q:v', '1', '-f', 'mjpeg', 'pipe:1'],
        ])
      ).stdoutBuffer;
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function encode(frame: Buffer, count: number, name: string, fps = 24): Promise<string> {
    const out = join(dir, name);
    const encoder = SegmentEncoder.start(
      tools!.ffmpeg,
      segmentEncodeArgs({ fps, crf: 18, x264Preset: 'ultrafast', gop: fps * 2, threads: 2, outPath: out }),
    );
    for (let i = 0; i < count; i++) await encoder.write(frame);
    await encoder.finish();
    return out;
  }

  it('encodes frames into limited-range BT.709 H.264 with the right length', async () => {
    const out = await encode(await jpeg('0x3ddc97'), 48, 'a.mp4');
    const media = await probeMedia(tools!.ffprobe, out);
    const video = media.streams.find((s) => s.type === 'video')!;
    expect(video).toMatchObject({
      codec: 'h264',
      width: 128,
      height: 72,
      pixFmt: 'yuv420p',
      colorRange: 'tv',
      colorSpace: 'bt709',
      colorTransfer: 'bt709',
      colorPrimaries: 'bt709',
      frameRate: '24/1',
    });
    expect(media.durationSec).toBeCloseTo(2, 1);
    expect(await probeDuration(tools!.ffprobe, out)).toBeCloseTo(2, 1);
    expect(media.tags).toEqual(
      expect.not.objectContaining({ encoder: expect.anything(), creation_time: expect.anything() }),
    );
  });

  it('keeps colours: a player that decodes limited-range BT.709 sees the colours the page drew', async () => {
    const samples = ['0x3ddc97', '0x8c7bff', '0xff6b81', '0x0d1117', '0xe6edf3'];
    for (const colour of samples) {
      const out = await encode(await jpeg(colour), 6, `c-${colour}.mp4`);
      const decoded = await runCommand(tools!.ffmpeg, [
        ...['-hide_banner', '-loglevel', 'error', '-i', out],
        ...['-vf', 'scale=in_range=tv:in_color_matrix=bt709:flags=accurate_rnd+full_chroma_int,format=rgb24'],
        ...['-frames:v', '1', '-f', 'rawvideo', 'pipe:1'],
      ]);
      const centre = (36 * 128 + 64) * 3;
      const got = [...decoded.stdoutBuffer.subarray(centre, centre + 3)];
      const want = [1, 3, 5].map((i) => Number.parseInt(colour.slice(i + 1, i + 3), 16));
      for (const [channel, value] of got.entries()) {
        expect(Math.abs(value - want[channel]!), `${colour} channel ${channel}`).toBeLessThanOrEqual(4);
      }
    }
  });

  it('joins segments without losing or doubling frames, adds audio and strips metadata', async () => {
    const a = await encode(await jpeg('red'), 24, 'seg-a.mp4');
    const b = await encode(await jpeg('blue'), 36, 'seg-b.mp4');
    const list = join(dir, 'list.txt');
    await writeFile(list, concatListText([a, b]));
    const wav = join(dir, 'tone.wav');
    await runCommand(tools!.ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=1',
      '-ac',
      '1',
      wav,
    ]);
    const out = join(dir, 'joined.mp4');
    await concatAndMux(tools!.ffmpeg, { listPath: list, audioPath: wav, outPath: out, durationSec: 60 / 24 });
    const media = await probeMedia(tools!.ffprobe, out);
    expect(media.durationSec).toBeCloseTo(2.5, 1);
    const audio = media.streams.find((s) => s.type === 'audio')!;
    expect(audio).toMatchObject({ codec: 'aac', sampleRate: 48000, channels: 1 });
    const counted = await runCommand(tools!.ffprobe, [
      '-v',
      'error',
      '-count_frames',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=nb_read_frames',
      '-of',
      'csv=p=0',
      out,
    ]);
    expect(Number(counted.stdout.trim())).toBe(60);
    const bytes = (await readFile(out)).toString('latin1');
    expect(bytes).not.toContain('x264 - core');
    expect(media.tags).not.toHaveProperty('encoder');
    expect(media.tags).not.toHaveProperty('creation_time');
    expect((await stat(out)).size).toBeGreaterThan(0);
  });

  it('reports ffmpeg failures with the reason', async () => {
    const encoder = SegmentEncoder.start(tools!.ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'image2pipe',
      '-c:v',
      'mjpeg',
      '-i',
      '-',
      '-c:v',
      'no_such_encoder',
      join(dir, 'bad.mp4'),
    ]);
    const frame = await jpeg('red');
    const outcome = await (async () => {
      try {
        for (let i = 0; i < 50; i++) await encoder.write(frame);
        await encoder.finish();
        return null;
      } catch (err) {
        return err;
      }
    })();
    expect(outcome).toMatchObject({ code: 'RENDER_FAILED' });
  });

  it('can be stopped', async () => {
    const encoder = SegmentEncoder.start(
      tools!.ffmpeg,
      segmentEncodeArgs({
        fps: 24,
        crf: 30,
        x264Preset: 'ultrafast',
        gop: 48,
        threads: 1,
        outPath: join(dir, 'killed.mp4'),
      }),
    );
    await encoder.write(await jpeg('red'));
    encoder.kill();
    await expect(encoder.finish()).rejects.toMatchObject({ code: 'RENDER_FAILED' });
  });

  it('reports a missing ffmpeg', async () => {
    const encoder = SegmentEncoder.start(join(dir, 'no-such-ffmpeg'), ['-version']);
    await expect(encoder.finish()).rejects.toMatchObject({ code: 'FFMPEG_NOT_FOUND' });
  });
});
