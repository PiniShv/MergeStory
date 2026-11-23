import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import { testConfig } from '../testing/context.ts';
import { ffmpegTo, makeClip } from '../testing/media.ts';
import { makePng } from '../testing/png.ts';
import { resolveFfmpeg } from './binaries.ts';
import {
  type ClockFacts,
  clockProblem,
  clockProblemOf,
  DECODER_ARGS,
  INPUT_WHITELIST_ARGS,
  type MatroskaFacts,
  type MovieFacts,
  matroskaFactsOf,
  movieFacts,
  movieFactsOf,
  probeRecording,
  type TrackFacts,
} from './media-probe.ts';
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

describe('clockProblemOf', () => {
  /** Thirty pictures of 1/30 s each, in a time base of 1/30000, the way an MP4 stores them; the first is full. */
  const steady = (from = 0) =>
    Array.from({ length: 30 }, (_, i) => ({
      pts: (from + i) * 1000,
      dts: (from + i) * 1000,
      duration: 1000,
      flags: i === 0 ? 'K__' : '___',
    }));
  const facts = (
    packets: ClockFacts['packets'],
    format: Partial<NonNullable<ClockFacts['format']>> = {},
    codec = 'h264',
  ): ClockFacts => ({
    packets,
    streams: [{ index: 0, id: '0x1', codec_name: codec, time_base: '1/30000' }],
    format: { start_time: '0.000000', format_name: 'mov,mp4,m4a,3gp,3g2,mj2', ...format },
  });
  const webm = { start_time: '0.000000', format_name: 'matroska,webm' };
  const movie: MovieFacts = {
    pictureTracks: 1,
    otherTracks: false,
    fragmented: false,
    trackId: 1,
    enabled: true,
    edits: null,
    movieSeconds: 1,
    trackSeconds: 1,
  };
  const matroska: MatroskaFacts = {
    pictureTracks: 1,
    unnamed: false,
    timestampScale: 1,
    trackOffset: 0,
    codecDelay: 0,
  };
  /** One edit at normal speed from the first picture, as a file with B-frames has: the usual edit list of an MP4. */
  const plain: TrackFacts = {
    movie: { ...movie, edits: [{ mediaTime: 2000, rate: 1 }] },
    firstStoredPts: 2000,
  };
  const check = (f: ClockFacts, durationSec: number, track: TrackFacts = {}) =>
    clockProblemOf(f, durationSec, { movie, firstStoredPts: 0, matroska, ...track });
  const withMovie = (over: Partial<MovieFacts>, firstStoredPts = 0): TrackFacts => ({
    movie: { ...movie, ...over },
    firstStoredPts,
  });
  const unread = 'the times of its pictures could not be read';

  it('accepts a clip whose file and picture start at 0 with a full picture, last to its end and do not jump', () => {
    expect(check(facts(steady()), 1)).toBeNull();
    expect(check(facts(steady()), 1, plain)).toBeNull();
    // An MP4 without B-frames has one edit from 0.
    expect(check(facts(steady()), 1, withMovie({ edits: [{ mediaTime: 0, rate: 1 }] }))).toBeNull();
    expect(check(facts(steady(), webm, 'vp8'), 1)).toBeNull();
  });

  it('refuses a file that starts after 0, or before it', () => {
    expect(check(facts(steady(30), { start_time: '1.000000' }), 2)).toBe(
      'the file starts at 1.000 s, not at 0',
    );
    expect(check(facts(steady(), { start_time: '-0.021000' }), 1)).toBe(
      'the file starts at -0.021 s, not at 0',
    );
  });

  it('refuses a clip with more than one picture track, as a player may show another one', () => {
    const two = {
      ...facts(steady()),
      streams: [
        { index: 0, id: '0x1', time_base: '1/30000' },
        { index: 1, id: '0x2', time_base: '1/30000' },
      ],
    };
    expect(check(two, 1)).toBe('it has 2 picture tracks');
    expect(check({ ...facts(steady()), streams: [] }, 1)).toBe(unread);
  });

  it('refuses a clip that does not start with a full picture, which Safari leaves black', () => {
    const notFull = steady().map((p) => ({ ...p, flags: '___' }));
    expect(check(facts(notFull), 1)).toBe('it does not start with a full picture');
    // A full picture first in the file, but another one before it in time.
    const before = [{ ...steady()[0]!, pts: 1000 }, { ...steady()[1]!, pts: 0 }, ...steady().slice(2)];
    expect(check(facts(before), 1)).toBe('it does not start with a full picture');
  });

  it('refuses a picture that starts after the file, as when the sound starts first', () => {
    expect(check(facts(steady(15)), 1.5)).toBe('its picture starts at 0.500 s, not at 0');
  });

  it('refuses a picture that ends a frame or more before the clip ends, and only then', () => {
    expect(check(facts(steady()), 2)).toBe('its picture ends at 1.000 s, before the clip ends at 2.000 s');
    const nearly = 1 + 1 / 12 - 0.001;
    expect(
      check(facts(steady()), nearly, withMovie({ movieSeconds: nearly, trackSeconds: nearly })),
    ).toBeNull();
    expect(check(facts(steady()), 1 + 1 / 12 + 0.001)).toBe(
      'its picture ends at 1.000 s, before the clip ends at 1.084 s',
    );
  });

  it('refuses times that jump in an MP4, where a time is the sum of the lengths before it', () => {
    const jump = steady().map((p, i) => (i < 15 ? p : { ...p, dts: p.dts + 546, pts: p.pts + 546 }));
    expect(check(facts(jump), 1)).toBe('the times of its pictures jump');
    // An edit list that shows a part twice makes the decode times go back.
    expect(check(facts([...steady(), ...steady(10)]), 1)).toBe('the times of its pictures jump');
  });

  it('refuses an MP4 in parts, with other tracks, a picture track turned off, or a length it gives itself that is short', () => {
    expect(check(facts(steady()), 1, withMovie({ fragmented: true }))).toBe('it is an MP4 written in parts');
    expect(check(facts(steady()), 1, withMovie({ otherTracks: true }))).toBe(
      'it has tracks other than its picture and its sound',
    );
    expect(check(facts(steady()), 1, withMovie({ pictureTracks: 2 }))).toBe('it has 2 picture tracks');
    // The picture track that the file marks is not the one that FFmpeg reads.
    expect(check(facts(steady()), 1, withMovie({ trackId: 2 }))).toBe(unread);
    expect(check(facts(steady()), 1, withMovie({ enabled: false }))).toBe('its picture track is turned off');
    expect(check(facts(steady()), 1, withMovie({ movieSeconds: 0.5 }))).toBe(
      'the file says it ends at 0.500 s, before its last picture',
    );
    expect(check(facts(steady()), 1, withMovie({ trackSeconds: 0.5 }))).toBe(
      'the file says it ends at 0.500 s, before its last picture',
    );
    expect(check(facts(steady()), 1, withMovie({ trackSeconds: Number.NaN }))).toBe(unread);
  });

  it('refuses an MP4 edit list that leaves out a picture, is not one edit at normal speed, or starts elsewhere', () => {
    // A cut that starts inside a picture held for 3 s: FFmpeg leaves the picture out, QuickTime shows its rest.
    const held = { pts: -3000, dts: -3000, duration: 3000, flags: 'KD_' };
    expect(check(facts([held, ...steady()]), 1, plain)).toBe('its edit list leaves out pictures');
    const notPlain = 'its edit list is not one edit at normal speed';
    const edit = { mediaTime: 2000, rate: 1 };
    expect(check(facts(steady()), 1, withMovie({ edits: [edit, edit] }, 2000))).toBe(notPlain);
    expect(check(facts(steady()), 1, withMovie({ edits: [{ mediaTime: 2000, rate: 0.5 }] }, 2000))).toBe(
      notPlain,
    );
    expect(check(facts(steady()), 1, withMovie({ edits: [{ mediaTime: -1, rate: 1 }] }))).toBe(notPlain);
    expect(check(facts(steady()), 1, withMovie({ edits: [] }))).toBe(notPlain);
    // An edit from 0 when the first picture is stored at 2000: FFmpeg moves the pictures to 0, QuickTime does not.
    const elsewhere = 'its edit list does not start at its first picture';
    expect(check(facts(steady()), 1, withMovie({ edits: [{ mediaTime: 0, rate: 1 }] }, 2000))).toBe(
      elsewhere,
    );
    expect(check(facts(steady()), 1, withMovie({ edits: null }, 2000))).toBe(elsewhere);
    expect(check(facts(steady()), 1, { movie: undefined })).toBe(unread);
  });

  it('refuses a Matroska file with a track that has no codec, two picture tracks, timing settings, or times that go back', () => {
    const vp8 = (packets: ClockFacts['packets']) => facts(packets, webm, 'vp8');
    expect(check(vp8(steady()), 1, { matroska: { ...matroska, unnamed: true } })).toBe(
      'it has a track with no codec, which players treat in different ways',
    );
    expect(check(vp8(steady()), 1, { matroska: { ...matroska, pictureTracks: 2 } })).toBe(
      'it has 2 picture tracks',
    );
    const settings = 'its picture track has timing settings that players read in different ways';
    for (const timing of [{ timestampScale: 2 }, { trackOffset: -5 }, { codecDelay: 1_000_000_000 }]) {
      expect(check(vp8(steady()), 1, { matroska: { ...matroska, ...timing } })).toBe(settings);
    }
    expect(check(vp8(steady()), 1, { matroska: undefined })).toBe(unread);
    const back = steady().map((p, i) => (i === 10 ? { ...p, pts: 5000 } : p));
    expect(check(vp8(back), 1)).toBe('the times of its pictures go back or repeat');
    // H.264 in Matroska shows its pictures in another order than it stores them, but never two at one time.
    const reordered = steady().map((p, i) =>
      i === 1 ? { ...p, pts: 2000 } : i === 2 ? { ...p, pts: 1000 } : p,
    );
    expect(check(facts(reordered, webm, 'h264'), 1)).toBeNull();
    const twice = steady().map((p, i) => (i === 2 ? { ...p, pts: 1000 } : p));
    expect(check(facts(twice, webm, 'h264'), 1)).toBe('the times of its pictures go back or repeat');
  });

  it('needs a decode time for every picture of an MP4, but not of a Matroska file', () => {
    const missing = steady().map((p, i) => (i < 2 ? { ...p, dts: undefined } : p));
    expect(check(facts(missing, webm, 'h264'), 1)).toBeNull();
    expect(check(facts(missing), 1)).toBe(unread);
  });

  it('refuses what it cannot read', () => {
    expect(check(facts([]), 1)).toBe(unread);
    expect(check(facts([{ dts: 0, duration: 1000 }, ...steady()]), 1)).toBe(unread);
    expect(check(facts(steady(), { start_time: 'N/A' }), 1)).toBe(unread);
    expect(
      check(
        facts(
          steady().map((p) => ({ ...p, flags: 'K_D' })),
          webm,
        ),
        1,
      ),
    ).toBe(unread);
  });
});

describe('movieFactsOf', () => {
  const box = (type: string, ...body: Buffer[]): Buffer => {
    const content = Buffer.concat(body);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + content.length);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, content]);
  };
  const handler = (kind: string): Buffer => {
    const body = Buffer.alloc(24);
    body.write(kind, 8, 'latin1');
    return box('hdlr', body);
  };
  /** A movie header in version 0: time scale 1000 and a length in thousandths of a second. */
  const mvhd = (length: number): Buffer => {
    const body = Buffer.alloc(100);
    body.writeUInt32BE(1000, 12);
    body.writeUInt32BE(length, 16);
    return box('mvhd', body);
  };
  /** A track header in version 0: flags (1 = turned on), id and length in the movie's time. */
  const tkhd = (id: number, length: number, flags = 1): Buffer => {
    const body = Buffer.alloc(84);
    body.writeUIntBE(flags, 1, 3);
    body.writeUInt32BE(id, 12);
    body.writeUInt32BE(length, 20);
    return box('tkhd', body);
  };
  /** An edit list in either version of the box: [media time, whole part of the speed, its fraction of 65536]. */
  const elst = (version: 0 | 1, entries: [number, number, number][]): Buffer => {
    const step = version === 1 ? 20 : 12;
    const body = Buffer.alloc(8 + entries.length * step);
    body[0] = version;
    body.writeUInt32BE(entries.length, 4);
    for (const [i, [media, whole, fraction]] of entries.entries()) {
      const at = 8 + i * step;
      if (version === 1) body.writeBigInt64BE(BigInt(media), at + 8);
      else body.writeInt32BE(media, at + 4);
      body.writeInt16BE(whole, at + step - 4);
      body.writeUInt16BE(fraction, at + step - 2);
    }
    return box('elst', body);
  };
  /** A track: its handler kinds (the media's first, then those in minf), its header, and more boxes. */
  const track = (kinds: string[], header: Buffer, ...more: Buffer[]): Buffer =>
    box(
      'trak',
      header,
      box('mdia', handler(kinds[0]!), box('minf', ...kinds.slice(1).map((kind) => handler(kind)))),
      ...more,
    );
  const picture = (...more: Buffer[]) => track(['vide', 'alis'], tkhd(1, 3000), ...more);

  it('reads the picture track: its id, whether it is on, its edit list and the lengths the file gives', () => {
    const movie = Buffer.concat([
      mvhd(3000),
      track(['soun'], tkhd(2, 3000), box('edts', elst(0, [[5, 1, 0]]))),
      picture(
        box(
          'edts',
          elst(1, [
            [1024, 1, 0],
            [-1, 1, 0],
          ]),
        ),
      ),
    ]);
    expect(movieFactsOf(movie)).toEqual({
      pictureTracks: 1,
      otherTracks: false,
      fragmented: false,
      trackId: 1,
      enabled: true,
      edits: [
        { mediaTime: 1024, rate: 1 },
        { mediaTime: -1, rate: 1 },
      ],
      movieSeconds: 3,
      trackSeconds: 3,
    });
    expect(
      movieFactsOf(Buffer.concat([mvhd(3000), picture(box('edts', elst(0, [[300, 0, 32768]])))])).edits,
    ).toEqual([{ mediaTime: 300, rate: 0.5 }]);
    expect(movieFactsOf(Buffer.concat([mvhd(3000), picture()])).edits).toBeNull();
    expect(movieFactsOf(Buffer.concat([mvhd(3000), track(['vide'], tkhd(1, 3000, 0))])).enabled).toBe(false);
  });

  it('counts the tracks by what all of their handlers say, and sees a movie in parts', () => {
    const facts = (...tracks: Buffer[]) => movieFactsOf(Buffer.concat([mvhd(3000), ...tracks]));
    expect(facts(picture(), track(['meta'], tkhd(2, 3000)))).toMatchObject({
      pictureTracks: 1,
      otherTracks: true,
    });
    // A picture track whose second handler says sound: FFmpeg takes the last handler, QuickTime the first.
    expect(facts(track(['vide', 'soun'], tkhd(1, 3000)))).toMatchObject({
      pictureTracks: 0,
      otherTracks: true,
    });
    expect(facts(picture(), track(['vide'], tkhd(2, 3000)))).toMatchObject({ pictureTracks: 2 });
    expect(facts(picture(), box('mvex'))).toMatchObject({ fragmented: true });
  });

  it('throws on a second edit list, a movie with no header, and a box that does not fit', () => {
    expect(() =>
      movieFactsOf(
        Buffer.concat([mvhd(3000), picture(box('edts', elst(0, [[0, 1, 0]]), elst(0, [[9, 1, 0]])))]),
      ),
    ).toThrow('more than one edit list');
    expect(() =>
      movieFactsOf(
        Buffer.concat([
          mvhd(3000),
          picture(box('edts', elst(0, [[0, 1, 0]])), box('edts', elst(0, [[9, 1, 0]]))),
        ]),
      ),
    ).toThrow('more than one edit list');
    expect(() => movieFactsOf(picture())).toThrow('no header');
    expect(() => movieFactsOf(Buffer.concat([mvhd(3000), picture()]).subarray(0, 140))).toThrow();
  });
});

describe('matroskaFactsOf', () => {
  /** An EBML element with an 8-byte size, or a size left open. */
  const element = (id: number, ...body: (Buffer | 'open')[]): Buffer => {
    const open = body.includes('open');
    const content = Buffer.concat(body.filter((b): b is Buffer => b !== 'open'));
    const hex = id.toString(16);
    const size = Buffer.alloc(8);
    size[0] = 0x01;
    if (open) size.fill(0xff, 1);
    else size.writeUIntBE(content.length, 2, 6);
    return Buffer.concat([
      Buffer.from(hex.padStart(hex.length + (hex.length % 2), '0'), 'hex'),
      size,
      content,
    ]);
  };
  const uint = (value: number, bytes = 4): Buffer => {
    const b = Buffer.alloc(bytes);
    b.writeUIntBE(value, 0, bytes);
    return b;
  };
  const float = (value: number): Buffer => {
    const b = Buffer.alloc(8);
    b.writeDoubleBE(value);
    return b;
  };
  const head = (...tracks: Buffer[]): Buffer =>
    Buffer.concat([
      element(0x1a45dfa3, element(0x4286, uint(1, 1))),
      element(
        0x18538067,
        'open',
        element(0x1549a966, element(0x2ad7b1, uint(1_000_000))),
        element(0x1654ae6b, ...tracks),
        element(0x1f43b675, 'open'),
      ),
    ]);
  const codec = (name: string) => element(0x86, Buffer.from(name));
  const entry = (type: number, ...more: Buffer[]) => element(0xae, element(0x83, uint(type, 1)), ...more);

  it('reads the picture tracks, the timing settings of the picture track, and tracks with no codec', () => {
    const sound = entry(2, codec('A_OPUS'), element(0x56aa, uint(6_500_000)));
    expect(matroskaFactsOf(head(sound, entry(1, codec('V_VP8'))))).toEqual({
      pictureTracks: 1,
      unnamed: false,
      timestampScale: 1,
      trackOffset: 0,
      codecDelay: 0,
    });
    const odd = entry(
      1,
      codec('V_VP8'),
      element(0x23314f, float(2)),
      element(0x537f, Buffer.from([0xff, 0xfb])),
      element(0x56aa, uint(1e9, 6)),
    );
    expect(matroskaFactsOf(head(odd))).toMatchObject({ timestampScale: 2, trackOffset: -5, codecDelay: 1e9 });
    // A picture track with no codec in front of the real one: FFmpeg leaves it out, the reader counts both.
    expect(matroskaFactsOf(head(entry(1), entry(1, codec('V_VP8'))))).toMatchObject({
      pictureTracks: 2,
      unnamed: true,
    });
  });

  it('throws on a file that is not Matroska and on a track list after the pictures', () => {
    expect(() => matroskaFactsOf(Buffer.from('not a matroska file at all'))).toThrow();
    const late = Buffer.concat([
      element(0x1a45dfa3, element(0x4286, uint(1, 1))),
      element(0x18538067, 'open', element(0x1f43b675, 'open'), element(0x1654ae6b, entry(1, codec('V_VP8')))),
    ]);
    expect(() => matroskaFactsOf(late)).toThrow('not near the start');
  });
});

describe.skipIf(tools === null)('clockProblem', () => {
  let dir: string;
  const at = (name: string): string => join(dir, name);
  const picture = [
    ...['-f', 'lavfi', '-i', 'testsrc=duration=2:size=160x120:rate=30'],
    ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p'],
  ];
  const sound = (seconds: number) => ['-f', 'lavfi', '-t', String(seconds), '-i', 'sine=frequency=440'];
  const problem = async (name: string) =>
    clockProblem(tools!.ffprobe, at(name), (await probeRecording(tools!.ffprobe, at(name))).durationSec);
  /** Change a file's bytes after the first `marker`: write `value` there in `bytes` bytes, `offset` bytes on. */
  const patch = async (from: string, to: string, marker: string, changes: [number, number, number][]) => {
    const data = await readFile(at(from));
    const i = data.indexOf(marker);
    expect(i).toBeGreaterThan(0);
    for (const [offset, bytes, value] of changes) data.writeIntBE(value, i + offset, bytes);
    await writeFile(at(to), data);
    return data;
  };
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mergestory-clock-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('accepts MP4 with and without B-frames, with the movie box first or last, WebM and Matroska', async (ctx) => {
    expect(await ffmpegTo(tools!.ffmpeg, [...picture, at('plain.mp4')])).toBe(true);
    expect(await problem('plain.mp4')).toBeNull();
    expect(
      await ffmpegTo(tools!.ffmpeg, [...picture, '-bf', '0', '-movflags', '+faststart', at('fast.mp4')]),
    ).toBe(true);
    expect(await problem('fast.mp4')).toBeNull();
    expect(
      await ffmpegTo(tools!.ffmpeg, [...sound(2), ...picture, '-map', '1:v', '-map', '0:a', at('sound.mov')]),
    ).toBe(true);
    expect(await problem('sound.mov')).toBeNull();
    expect(await ffmpegTo(tools!.ffmpeg, [...picture, at('b.mkv')])).toBe(true);
    expect(await problem('b.mkv')).toBeNull();
    if (!(await makeClip(tools!.ffmpeg, at('plain.webm'), { codec: 'vp8' }))) return ctx.skip();
    expect(await problem('plain.webm')).toBeNull();
  });

  it('refuses a clip that starts late, a picture that starts after its sound, and sound that outlasts it', async () => {
    expect(await ffmpegTo(tools!.ffmpeg, [...picture, '-output_ts_offset', '1', at('late.mp4')])).toBe(true);
    expect(await problem('late.mp4')).toBe('the file starts at 1.000 s, not at 0');
    const afterSound = [...sound(3), '-itsoffset', '1', ...picture, '-map', '1:v', '-map', '0:a'];
    expect(await ffmpegTo(tools!.ffmpeg, [...afterSound, '-c:a', 'aac', at('after-sound.mp4')])).toBe(true);
    expect(await problem('after-sound.mp4')).toBe('its picture starts at 1.000 s, not at 0');
    const longSound = [...sound(3), ...picture, '-map', '1:v', '-map', '0:a'];
    expect(await ffmpegTo(tools!.ffmpeg, [...longSound, '-c:a', 'aac', at('long-sound.mp4')])).toBe(true);
    expect(await problem('long-sound.mp4')).toMatch(
      /^its picture ends at 2\.000 s, before the clip ends at 3\.0\d\d s$/,
    );
  });

  it('refuses a B-frame delay that the file does not undo with an edit list', async () => {
    expect(await ffmpegTo(tools!.ffmpeg, [...picture, '-use_editlist', '0', at('no-edit.mp4')])).toBe(true);
    expect(await problem('no-edit.mp4')).toMatch(/^the file starts at 0\.0\d\d s, not at 0$/);
  });

  it('refuses an MP4 cut without re-encoding inside a picture that is held for seconds', async () => {
    // The first picture shows for 3 s. A cut from 1 s keeps it, with an edit list that starts inside it:
    // FFmpeg and Chrome leave it out and move the rest 2 s earlier, while QuickTime and Safari show its rest.
    const held = [
      ...['-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=6'],
      ...[
        '-vf',
        "select='eq(n,0)+gte(n,90)'",
        '-fps_mode',
        'passthrough',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
      ],
    ];
    expect(await ffmpegTo(tools!.ffmpeg, [...held, at('held.mp4')])).toBe(true);
    expect((await movieFacts(at('held.mp4'))).edits).toEqual([{ mediaTime: expect.any(Number), rate: 1 }]);
    expect(
      await ffmpegTo(tools!.ffmpeg, ['-ss', '1', '-i', at('held.mp4'), '-c', 'copy', at('cut.mp4')]),
    ).toBe(true);
    expect(await problem('cut.mp4')).toBe('its edit list leaves out pictures');
  });

  it('refuses an MP4 whose edit list is changed to start before its first picture, or to play at half speed', async () => {
    expect(await ffmpegTo(tools!.ffmpeg, [...picture, at('edit.mp4')])).toBe(true);
    const data = await readFile(at('edit.mp4'));
    const i = data.indexOf('elst');
    expect(data[i + 4]).toBe(0);
    // Version 0: [length 4][media time 4][speed 2+2] after the box's own 8 bytes. A longer edit keeps every picture in.
    await patch('edit.mp4', 'from0.mp4', 'elst', [
      [16, 4, 0],
      [12, 4, data.readUInt32BE(i + 12) + 1000],
    ]);
    expect(await problem('from0.mp4')).toBe('its edit list does not start at its first picture');
    await patch('edit.mp4', 'half.mp4', 'elst', [
      [20, 2, 0],
      [22, 2, 0x4000],
    ]);
    expect((await movieFacts(at('half.mp4'))).edits).toEqual([{ mediaTime: expect.any(Number), rate: 0.25 }]);
    expect(await problem('half.mp4')).toBe('its edit list is not one edit at normal speed');
  });

  it('refuses an MP4 that says it is shorter than its pictures, and one written in parts', async () => {
    expect(await ffmpegTo(tools!.ffmpeg, [...picture, '-bf', '0', at('full.mp4')])).toBe(true);
    // The movie header in version 0: its length (in its own time scale) comes 16 bytes into the box.
    const data = await readFile(at('full.mp4'));
    const i = data.indexOf('mvhd');
    await patch('full.mp4', 'short.mp4', 'mvhd', [[20, 4, Math.floor(data.readUInt32BE(i + 20) / 2)]]);
    expect(await problem('short.mp4')).toMatch(
      /^the file says it ends at 1\.0\d\d s, before its last picture$/,
    );
    expect(
      await ffmpegTo(tools!.ffmpeg, [
        ...picture,
        '-bf',
        '0',
        '-movflags',
        'frag_keyframe+empty_moov',
        at('parts.mp4'),
      ]),
    ).toBe(true);
    expect(await problem('parts.mp4')).toBe('it is an MP4 written in parts');
  });

  it('refuses two picture tracks, and a cut that keeps pictures before its first full one', async () => {
    expect(await ffmpegTo(tools!.ffmpeg, [...picture, '-g', '30', '-bf', '0', at('one.mp4')])).toBe(true);
    const two = [
      '-i',
      at('one.mp4'),
      '-itsoffset',
      '1',
      '-i',
      at('one.mp4'),
      '-map',
      '0:v',
      '-map',
      '1:v',
      '-c',
      'copy',
    ];
    expect(
      await ffmpegTo(tools!.ffmpeg, [
        ...two,
        '-disposition:v:0',
        '0',
        '-disposition:v:1',
        'default',
        at('two.mp4'),
      ]),
    ).toBe(true);
    expect(await problem('two.mp4')).toBe('it has 2 picture tracks');
    // The picture at 0.5 s is not a full one: the next full one is at 1 s.
    expect(
      await ffmpegTo(tools!.ffmpeg, [
        '-i',
        at('one.mp4'),
        '-ss',
        '0.5',
        '-c',
        'copy',
        '-copyinkf',
        at('part.mp4'),
      ]),
    ).toBe(true);
    expect(await problem('part.mp4')).toBe('it does not start with a full picture');
  });
});
