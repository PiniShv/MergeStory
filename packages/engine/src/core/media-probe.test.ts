import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import { testConfig } from '../testing/context.ts';
import { ffmpegTo, makeClip } from '../testing/media.ts';
import { makePng } from '../testing/png.ts';
import { resolveFfmpeg } from './binaries.ts';
import { DECODER_ARGS, INPUT_WHITELIST_ARGS, probeRecording } from './media-probe.ts';
import { runCommand } from './process.ts';

const tools = await resolveFfmpeg(testConfig()).catch(() => null);

describe('whitelists', () => {
  it('name the containers and codecs that a recording may use', () => {
    expect(INPUT_WHITELIST_ARGS).toEqual([
      '-protocol_whitelist',
      'file',
      '-format_whitelist',
      'mov,matroska',
    ]);
    expect(DECODER_ARGS).toEqual([
      '-codec_whitelist',
      'h264,vp8,vp9',
      '-max_pixels',
      '40000000',
      '-threads',
      '4',
    ]);
  });
});

describe.skipIf(tools === null)('probeRecording', () => {
  let dir: string;
  const at = (name: string): string => join(dir, name);
  const refused = (name: string) =>
    expect(probeRecording(tools!.ffprobe, at(name))).rejects.toMatchObject({
      code: 'USAGE',
      message: expect.stringContaining(name),
      hint: expect.stringContaining('Its only other track may be sound in AAC, MP3, Opus or Vorbis'),
    });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mergestory-probe-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('accepts an H.264 MP4 and reads its size and length', async () => {
    expect(await makeClip(tools!.ffmpeg, at('a.mp4'), { seconds: 2, size: '320x240' })).toBe(true);
    const probed = await probeRecording(tools!.ffprobe, at('a.mp4'));
    expect(probed).toMatchObject({ codec: 'h264', width: 320, height: 240 });
    expect(probed.durationSec).toBeGreaterThan(1.5);
    expect(probed.sizeBytes).toBeGreaterThan(0);
  });

  it('accepts a VP9 WebM', async (ctx) => {
    if (!(await makeClip(tools!.ffmpeg, at('a.webm'), { codec: 'vp9' }))) ctx.skip();
    expect(await probeRecording(tools!.ffprobe, at('a.webm'))).toMatchObject({ codec: 'vp9' });
  });

  it('refuses a playlist, a concat script and a PNG that are named .mp4', async () => {
    await writeFile(at('list.mp4'), '#EXTM3U\n#EXTINF:1,\nhttp://example.invalid/x.ts\n');
    await writeFile(at('concat.mp4'), "ffconcat version 1.0\nfile '/etc/hosts'\n");
    await writeFile(at('image.mp4'), makePng(8, 8, [1, 2, 3]));
    await refused('list.mp4');
    await refused('concat.mp4');
    await refused('image.mp4');
  });

  it('refuses a file that is not there', async () => {
    await refused('missing.mp4');
  });

  it('refuses a file with sound only', async () => {
    expect(await makeClip(tools!.ffmpeg, at('sound.mp4'), { audioOnly: true })).toBe(true);
    await expect(probeRecording(tools!.ffprobe, at('sound.mp4'))).rejects.toMatchObject({
      message: expect.stringContaining('no video'),
    });
  });

  it('refuses HEVC video, naming the track', async (ctx) => {
    if (!(await makeClip(tools!.ffmpeg, at('h265.mp4'), { codec: 'hevc' }))) ctx.skip();
    await expect(probeRecording(tools!.ffprobe, at('h265.mp4'))).rejects.toMatchObject({
      message: expect.stringContaining('one of its tracks is hevc, which is not supported'),
    });
  });

  it('refuses a concat script that names a file next to it: the container list is really passed', async () => {
    // Without -format_whitelist, FFmpeg reads the real.mp4 that this script names, and the file is accepted.
    expect(await makeClip(tools!.ffmpeg, at('real.mp4'), { seconds: 1 })).toBe(true);
    await writeFile(at('c.mp4'), 'ffconcat version 1.0\nfile real.mp4\n');
    await refused('c.mp4');
  });

  /** A clip with H.264 or VP8 video and one sound track. */
  async function withSound(ctx: TestContext, name: string, args: string[]): Promise<void> {
    const sound = ['-f', 'lavfi', '-i', 'sine=duration=1'];
    const picture = ['-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=12'];
    if (!(await ffmpegTo(tools!.ffmpeg, [...picture, ...sound, ...args, at(name)]))) ctx.skip();
  }

  it('masks an e-mail address in the name of a file that it refuses', async () => {
    await writeFile(at('jane.doe@example.com.mp4'), 'not a video');
    const error = await probeRecording(tools!.ffprobe, at('jane.doe@example.com.mp4')).catch(
      (err: unknown) => err,
    );
    expect(error).toMatchObject({ code: 'USAGE', message: expect.stringContaining('j•••@example.com.mp4') });
    expect(String((error as Error).message)).not.toContain('jane.doe');
  });

  it('refuses a track that is not allowed, naming it', async (ctx) => {
    await withSound(ctx, 'flac.mkv', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'flac']);
    await expect(probeRecording(tools!.ffprobe, at('flac.mkv'))).rejects.toMatchObject({
      code: 'USAGE',
      message: expect.stringContaining('one of its tracks is flac, which is not supported'),
    });
  });

  it.for([
    { name: 'aac.mp4', codec: 'h264', args: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'] },
    {
      name: 'mp3.mp4',
      codec: 'h264',
      args: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'libmp3lame'],
    },
    { name: 'opus.webm', codec: 'vp8', args: ['-c:v', 'libvpx', '-c:a', 'libopus'] },
  ])('accepts a recording with sound: $name', async ({ name, codec, args }, ctx) => {
    await withSound(ctx, name, args);
    expect(await probeRecording(tools!.ffprobe, at(name))).toMatchObject({ codec, width: 320, height: 240 });
  });

  it('refuses a clip shorter than 0.2 seconds, and accepts one of three frames', async () => {
    expect(await makeClip(tools!.ffmpeg, at('one.mp4'), { frames: 1 })).toBe(true);
    await expect(probeRecording(tools!.ffprobe, at('one.mp4'))).rejects.toMatchObject({
      code: 'USAGE',
      message: expect.stringContaining('it is shorter than 0.2 seconds'),
    });
    expect(await makeClip(tools!.ffmpeg, at('three.mp4'), { frames: 3 })).toBe(true);
    expect((await probeRecording(tools!.ffprobe, at('three.mp4'))).durationSec).toBeGreaterThanOrEqual(0.2);
  });

  it('measures a WebM that does not say how long it is, as a recording from a browser often does not', async (ctx) => {
    // Written to a pipe, FFmpeg cannot go back and put the length into the header.
    const piped = await runCommand(
      tools!.ffmpeg,
      [
        ...['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=12'],
        ...['-c:v', 'libvpx', '-f', 'webm', 'pipe:1'],
      ],
      { allowFailure: true, timeoutMs: 60_000 },
    );
    if (piped.code !== 0) ctx.skip();
    await writeFile(at('browser.webm'), piped.stdoutBuffer);
    const probed = await probeRecording(tools!.ffprobe, at('browser.webm'));
    expect(probed).toMatchObject({ codec: 'vp8', width: 320, height: 240 });
    expect(probed.durationSec).toBeGreaterThan(1.8);
    expect(probed.durationSec).toBeLessThan(2.2);
  });
});

/** An ffprobe that answers what a test tells it to, to reach answers that a real file rarely gives. */
describe.skipIf(process.platform === 'win32')('probeRecording, with answers that are hard to make', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mergestory-probe-fake-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A program that prints `header` when it is asked for the streams and `packets` when asked for the packets. It logs its arguments, one call per line, in `<path>.log`. */
  async function fakeProbe(name: string, header: object, packets: string): Promise<string> {
    const path = join(dir, name);
    await writeFile(join(dir, `${name}.json`), JSON.stringify(header));
    await writeFile(join(dir, `${name}.csv`), packets);
    await writeFile(
      path,
      `#!/bin/sh\necho "$*" >> '${path}.log'\ncase "$*" in *packet=*) cat '${path}.csv' ;; *) cat '${path}.json' ;; esac\n`,
      { mode: 0o755 },
    );
    return path;
  }
  const video = (width: number, height: number) => ({
    streams: [{ codec_name: 'h264', width, height }],
    format: {},
  });

  it('takes the end of the last packet as the length, whatever the order of the packets', async () => {
    const probe = await fakeProbe(
      'unordered',
      video(640, 360),
      '0.000000,0.040000\n1.960000,0.040000\n0.040000,N/A\n\n',
    );
    expect((await probeRecording(probe, '/clips/a.mp4')).durationSec).toBeCloseTo(2, 5);
  });

  it('refuses a clip with no packets, and a picture of more than 40 megapixels', async () => {
    await expect(
      probeRecording(await fakeProbe('empty', video(640, 360), ''), '/clips/a.mp4'),
    ).rejects.toMatchObject({
      code: 'USAGE',
      message: expect.stringContaining('no length'),
    });
    const huge = await fakeProbe(
      'huge',
      { streams: [{ codec_name: 'vp9', width: 8000, height: 6000 }], format: { duration: '3' } },
      '',
    );
    await expect(probeRecording(huge, '/clips/a.webm')).rejects.toMatchObject({
      code: 'USAGE',
      message: expect.stringContaining('40 megapixels'),
    });
  });

  it('passes the container, codec and picture limits to both ffprobe calls, before the file', async () => {
    const probe = await fakeProbe('args', video(640, 360), '0.000000,0.040000\n1.960000,0.040000\n');
    await probeRecording(probe, '/clips/a.mp4');
    const calls = (await readFile(`${probe}.log`, 'utf8')).trim().split('\n');
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call).toMatch(
        /^-v error -protocol_whitelist file -format_whitelist mov,matroska -codec_whitelist h264,vp8,vp9,aac,mp3,mp3float,opus,vorbis -max_pixels 40000000 -select_streams v:0 .* -i \/clips\/a\.mp4$/,
      );
    }
  });

  it.each([
    [90, true],
    [-90, true],
    [270, true],
    [180, false],
    [null, false],
  ])('reports the size of the upright picture for a rotation of %s degrees', async (rotation, swapped) => {
    const header = {
      streams: [
        {
          codec_name: 'h264',
          width: 640,
          height: 360,
          ...(rotation === null ? {} : { side_data_list: [{ rotation }] }),
        },
      ],
      format: { duration: '3' },
    };
    const probe = await fakeProbe(`rotation${rotation}`, header, '');
    expect(await probeRecording(probe, '/clips/a.mp4')).toMatchObject(
      swapped ? { width: 360, height: 640 } : { width: 640, height: 360 },
    );
  });

  it('says "too long" when the list of packets does not fit, not that the file is damaged', async () => {
    // More than 16 MB of packet lines, for a file that gives no length.
    const probe = await fakeProbe('endless', video(640, 360), '0.000000,0.040000\n'.repeat(1_000_000));
    await expect(probeRecording(probe, '/clips/a.mp4')).rejects.toMatchObject({
      code: 'USAGE',
      message: expect.stringContaining('it is too long'),
    });
  });
});
