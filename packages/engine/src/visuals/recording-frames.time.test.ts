/**
 * Which picture of a recording each cut frame shows. Every picture of these test clips carries its own
 * number, and the judge uses only the times the clips were made with, so it relies on nothing from the
 * product's own rules for time.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import { resolveFfmpeg } from '../core/binaries.ts';
import { probeRecording } from '../core/media-probe.ts';
import { runCommand } from '../core/process.ts';
import { RECORDING_BOX, RECORDING_FPS } from '../core/recording-frames.ts';
import type { HiddenRegion } from '../core/types.ts';
import { testConfig } from '../testing/context.ts';
import {
  farthestFrom,
  fileTimes,
  makeTaggedClip,
  pictureTimes,
  readCut,
  readTag,
  shownBetween,
  type TaggedShape,
} from '../testing/frame-tags.ts';
import { COVER_EDGE, COVER_FILL } from './hide-regions.ts';
import { extractFrames, type FrameRequest } from './recording-frames.ts';

const tools = await resolveFfmpeg(testConfig()).catch(() => null);

/** Pictures kept from a 60 per second source: a gap of one picture, then 0.5 s, 1.5 s and 19 pictures. */
const GAPS: [number, number][] = [
  [0, 14],
  [16, 29],
  [60, 75],
  [165, 180],
  [200, 239],
];
/** Recordings in the shapes that recorders make: rates, gaps, sizes, containers and turned pictures. */
const SHAPES: TaggedShape[] = [
  { name: 'h264-30.mp4', codec: 'h264', width: 640, height: 360, rate: 30, seconds: 3 },
  { name: 'h264-25.mp4', codec: 'h264', width: 640, height: 360, rate: 25, seconds: 3 },
  { name: 'h264-60.mp4', codec: 'h264', width: 640, height: 360, rate: 60, seconds: 3 },
  { name: 'h264-29.97.mp4', codec: 'h264', width: 640, height: 360, rate: '30000/1001', seconds: 3 },
  { name: 'h264-gaps.mp4', codec: 'h264', width: 640, height: 360, rate: 60, seconds: 4, keep: GAPS },
  { name: 'h264-30.mov', codec: 'h264', width: 640, height: 360, rate: 30, seconds: 3 },
  { name: 'h264-30.mkv', codec: 'h264', width: 640, height: 360, rate: 30, seconds: 3 },
  { name: 'h264-turned-90.mp4', codec: 'h264', width: 360, height: 640, rate: 30, seconds: 3, rotate: 90 },
  { name: 'h264-turned-180.mp4', codec: 'h264', width: 640, height: 360, rate: 30, seconds: 3, rotate: 180 },
  { name: 'vp8-30.webm', codec: 'vp8', width: 640, height: 360, rate: 30, seconds: 3 },
  { name: 'vp8-gaps.webm', codec: 'vp8', width: 640, height: 360, rate: 60, seconds: 4, keep: GAPS },
  { name: 'vp9-24-odd.webm', codec: 'vp9', width: 641, height: 361, rate: 24, seconds: 3 },
];
const shape = (name: string): TaggedShape => SHAPES.find((s) => s.name === name)!;

/** The step of the clip's grid of frames: frame k of the whole clip stands for the moment k * STEP. */
const STEP = 1 / RECORDING_FPS;

describe.skipIf(tools === null)('which picture each cut frame of a recording shows', () => {
  let dir: string;
  const clips = new Map<string, Promise<string | null>>();
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mergestory-frame-times-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Cut a part of a shape's clip as a scene would, and read the number of the picture in every frame. */
  async function cut(
    ctx: TestContext,
    of: TaggedShape,
    over: Partial<Omit<FrameRequest, 'recording' | 'outDir'>> & { hidden?: HiddenRegion[] } = {},
  ) {
    if (!clips.has(of.name)) clips.set(of.name, makeTaggedClip(tools!.ffmpeg, dir, of));
    const clip = await clips.get(of.name)!;
    if (!clip) return ctx.skip(`this FFmpeg cannot make ${of.name}`);
    // The clip must have the times it was made with, as a player reads them, or the judge below would be wrong.
    const times = await fileTimes(tools!.ffprobe, clip);
    const meant = pictureTimes(of);
    expect(times, `${of.name}: pictures in the file`).toHaveLength(meant.length);
    for (const [i, { t }] of meant.entries())
      expect(Math.abs(times[i]! - t), `${of.name}: time of picture ${i}`).toBeLessThan(0.0015);
    const { codec, width, height, durationSec } = await probeRecording(tools!.ffprobe, clip);
    const { hidden, ...rest } = over;
    const outDir = join(dir, `${of.name}-${ctx.task.id}`);
    const request: FrameRequest = {
      recording: {
        id: 'RC1',
        path: clip,
        caption: '',
        moment: 'other',
        codec,
        width,
        height,
        durationSec,
        hidden,
      },
      trim: { start: 0, end: durationSec },
      zoom: null,
      box: RECORDING_BOX.scene,
      outDir,
      ...rest,
    };
    const made = await extractFrames(tools!.ffmpeg, request);
    const frames = await readCut(tools!.ffmpeg, outDir, made);
    // The part starts at the first moment of the grid at or after its start, and ends before the moment of
    // the grid nearest to its end: no frame is missing or added at either end.
    const first = Math.ceil(request.trim.start * RECORDING_FPS - 1e-9);
    expect(frames).toHaveLength(made.count);
    expect(made.count, `${of.name}: frames of the part`).toBe(
      Math.round(request.trim.end * RECORDING_FPS) - first,
    );
    return { made, frames, numbers: frames.map((grey) => readTag(grey, made.width)), first };
  }

  /**
   * Every frame shows the picture that a player shows at the frame's moment, or one that follows within half
   * a frame: the cut takes the nearest picture. A frame one step early or late fails here whenever the
   * pictures change faster than twice a frame.
   */
  function expectRightPictures(of: TaggedShape, numbers: (number | null)[], first: number): void {
    for (const [i, n] of numbers.entries()) {
      const t = (first + i) * STEP;
      const label = `${of.name}, frame ${i} at ${t.toFixed(3)} s`;
      expect(n, `${label}: the tag reads`).not.toBeNull();
      expect(shownBetween(of, t, t + STEP / 2), label).toContain(n);
    }
  }

  for (const each of SHAPES) {
    it(`${each.name}: every frame shows the picture of its moment`, async (ctx) => {
      const { numbers, first } = await cut(ctx, each);
      expect(numbers).toHaveLength(each.seconds * RECORDING_FPS);
      expectRightPictures(each, numbers, first);
    });
  }

  it('a part of a clip with a zoom keeps the moments of the whole clip', async (ctx) => {
    const of = shape('h264-30.mp4');
    const { numbers, first } = await cut(ctx, of, {
      trim: { start: 1.25, end: 2.5 },
      zoom: { x: 0, y: 0, w: 1, h: 0.5 },
    });
    expect(first).toBe(15);
    expect(numbers).toHaveLength(15);
    expectRightPictures(of, numbers, first);
  });

  it('a part that starts between two frames of the grid starts at the next one', async (ctx) => {
    const of = shape('h264-25.mp4');
    const { numbers, first } = await cut(ctx, of, { trim: { start: 1.3, end: 2.2 } });
    expect(first).toBe(16);
    expect(numbers).toHaveLength(10);
    expectRightPictures(of, numbers, first);
  });

  it('frames cut small for a thumbnail still read', async (ctx) => {
    const of = shape('h264-gaps.mp4');
    const { made, numbers, first } = await cut(ctx, of, { box: RECORDING_BOX.thumb });
    expect(made.width).toBeLessThanOrEqual(RECORDING_BOX.thumb.width);
    expectRightPictures(of, numbers, first);
  });

  for (const name of ['h264-gaps.mp4', 'h264-turned-90.mp4', 'vp9-24-odd.webm']) {
    it(`${name}: a region hidden for the whole clip is covered in every frame, and the pictures stay right`, async (ctx) => {
      const of = shape(name);
      const region = { x: 0.25, y: 0.5, w: 0.5, h: 0.3 };
      const { made, frames, numbers, first } = await cut(ctx, of, { hidden: [region] });
      // The inside of the region in the frame, a few pixels in from its border where JPEG mixes the colours.
      const box = {
        x: Math.ceil(region.x * made.width) + 3,
        y: Math.ceil(region.y * made.height) + 3,
        w: Math.floor(region.w * made.width) - 6,
        h: Math.floor(region.h * made.height) - 6,
      };
      for (const [i, grey] of frames.entries())
        expect(farthestFrom(grey, made.width, box, [COVER_FILL, COVER_EDGE]), `frame ${i}`).toBeLessThan(30);
      expectRightPictures(of, numbers, first);
    });
  }
});

describe('the tag reader', () => {
  it('reads nothing from a picture with no tag', () => {
    expect(readTag(new Uint8Array(160 * 90).fill(128), 160)).toBeNull();
    expect(readTag(new Uint8Array(160 * 90), 160)).toBeNull();
  });

  it.skipIf(tools === null)('reads the number of every picture, and nothing from a smudged tag', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mergestory-tags-'));
    try {
      const of: TaggedShape = {
        name: 'count.mp4',
        codec: 'h264',
        width: 320,
        height: 180,
        rate: 50,
        seconds: 2,
      };
      const clip = await makeTaggedClip(tools!.ffmpeg, dir, of);
      expect(clip).not.toBeNull();
      const numbers = async (name: string, filter: string[]) => {
        await mkdir(join(dir, name));
        await runCommand(tools!.ffmpeg, [
          ...['-v', 'error', '-i', clip!, ...filter, '-fps_mode', 'passthrough', '-q:v', '3'],
          join(dir, name, 'f-%05d.jpg'),
        ]);
        return (await readCut(tools!.ffmpeg, join(dir, name), of)).map((grey) => readTag(grey, of.width));
      };
      expect(await numbers('plain', [])).toEqual(Array.from({ length: 100 }, (_, n) => n));
      // Grey over half of the cells: neither black nor white.
      const smudged = await numbers('smudged', ['-vf', 'drawbox=x=0:y=0:w=160:h=20:color=0x808080:t=fill']);
      expect(new Set(smudged)).toEqual(new Set([null]));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
