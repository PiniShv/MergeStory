import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import { resolveFfmpeg } from '../core/binaries.ts';
import { probeRecording } from '../core/media-probe.ts';
import { runCommand } from '../core/process.ts';
import type { Storyboard } from '../core/storyboard-schema.ts';
import type { ContextInputs, RecordingInput } from '../core/types.ts';
import { testConfig } from '../testing/context.ts';
import { averageColor, ffmpegTo, makeClip } from '../testing/media.ts';
import { extractFrames, extractStoryboardFrames, frameGeometry } from './recording-frames.ts';

describe('frameGeometry', () => {
  const box = { width: 780, height: 584 };
  it('scales down to the box with even sides, and never up', () => {
    expect(frameGeometry({ width: 1280, height: 720 }, null, box)).toMatchObject({ width: 780, height: 438 });
    expect(frameGeometry({ width: 320, height: 240 }, null, box)).toMatchObject({ width: 320, height: 240 });
    expect(frameGeometry({ width: 321, height: 241 }, null, box)).toMatchObject({ width: 320, height: 240 });
  });

  it('crops to the zoom box first and keeps it inside the frame', () => {
    const g = frameGeometry({ width: 1000, height: 500 }, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, box);
    expect(g.crop).toEqual({ x: 500, y: 250, w: 500, h: 250 });
    expect(g).toMatchObject({ width: 500, height: 250 });
    const edge = frameGeometry({ width: 1000, height: 500 }, { x: 0.99, y: 0.99, w: 0.2, h: 0.2 }, box);
    expect(edge.crop.x + edge.crop.w).toBeLessThanOrEqual(1000);
    expect(edge.crop.y + edge.crop.h).toBeLessThanOrEqual(500);
  });
});

const tools = await resolveFfmpeg(testConfig()).catch(() => null);

const PICTURE = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'];
/** Four coloured quarters: red top left, green top right, blue bottom left, yellow bottom right. */
const QUARTERS = [
  ...['-f', 'lavfi', '-i'],
  'color=c=red:size=320x240:rate=12:duration=2,drawbox=x=160:y=0:w=160:h=120:color=green:t=fill,drawbox=x=0:y=120:w=160:h=120:color=blue:t=fill,drawbox=x=160:y=120:w=160:h=120:color=yellow:t=fill',
  ...PICTURE,
];
/** One solid sea green, stored the way a screen recorder stores it: BT.709 colours, limited range. */
const SEA_GREEN_709 = [
  ...['-f', 'lavfi', '-i'],
  'color=c=0x2E8B57:size=320x240:rate=12:duration=1,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
  ...['-c:v', 'libx264', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'],
  ...['-color_range', 'tv'],
];

/** Make a fixture once (the file is named in `args`' last place) and skip visibly when FFmpeg cannot. */
const built = new Map<string, Promise<boolean>>();
async function need(ctx: TestContext, file: string, args: string[]): Promise<string> {
  if (!built.has(file)) built.set(file, ffmpegTo(tools!.ffmpeg, [...args, file]));
  if (!(await built.get(file))) ctx.skip();
  return file;
}

/** A recording as the engine would have it: what the probe reads from the file. */
async function probed(path: string, id = 'RC1'): Promise<RecordingInput> {
  const { codec, width, height, durationSec } = await probeRecording(tools!.ffprobe, path);
  return { id, path, caption: '', moment: 'other', codec, width, height, durationSec };
}

/** The colour of the first frame in a folder, and the same for the last one. */
const firstColor = (dir: string) => averageColor(tools!.ffmpeg, join(dir, 'f-00001.jpg'));

describe.skipIf(tools === null)('extractFrames', () => {
  let dir: string;
  let clip: string;
  const recording = (path: string): RecordingInput => ({
    id: 'RC1',
    path,
    caption: '',
    moment: 'other',
    durationSec: 2,
    width: 320,
    height: 240,
    codec: 'h264',
  });
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mergestory-frames-'));
    clip = join(dir, 'clip.mp4');
    expect(await makeClip(tools!.ffmpeg, clip, { seconds: 2 })).toBe(true);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const request = (outDir: string, over: Partial<Parameters<typeof extractFrames>[1]> = {}) => ({
    recording: recording(clip),
    trim: { start: 0, end: 2 },
    zoom: null,
    box: { width: 160, height: 160 },
    outDir,
    ...over,
  });

  it('cuts 12 frames per second of the window, scaled to the box', async () => {
    const out = join(dir, 'whole');
    const made = await extractFrames(tools!.ffmpeg, request(out));
    expect(made).toEqual({ count: 24, width: 160, height: 120 });
    expect((await readdir(out)).slice(0, 2)).toEqual(['f-00001.jpg', 'f-00002.jpg']);
    const part = await extractFrames(
      tools!.ffmpeg,
      request(join(dir, 'part'), { trim: { start: 0.5, end: 1.5 } }),
    );
    expect(part.count).toBe(12);
  });

  it('crops to the zoom box', async () => {
    const made = await extractFrames(
      tools!.ffmpeg,
      request(join(dir, 'zoom'), { zoom: { x: 0, y: 0, w: 0.5, h: 0.5 }, box: { width: 640, height: 480 } }),
    );
    expect(made).toMatchObject({ width: 160, height: 120 });
  });

  it('empties the folder first, so frames of an earlier run do not count', async () => {
    const out = join(dir, 'again');
    await extractFrames(tools!.ffmpeg, request(out));
    const made = await extractFrames(tools!.ffmpeg, request(out, { trim: { start: 0, end: 1 } }));
    expect(made.count).toBe(12);
    expect(await readdir(out)).toHaveLength(12);
  });

  it('refuses a file that cannot be decoded, naming the recording', async () => {
    const bad = join(dir, 'bad.mp4');
    await writeFile(bad, 'not a video');
    await expect(
      extractFrames(tools!.ffmpeg, request(join(dir, 'bad'), { recording: recording(bad) })),
    ).rejects.toMatchObject({
      code: 'USAGE',
      message: expect.stringContaining('Recording RC1 (bad.mp4) could not be decoded'),
    });
  });

  it('gives an error for a window that has no picture', async () => {
    await expect(
      extractFrames(tools!.ffmpeg, request(join(dir, 'empty'), { trim: { start: 1, end: 1 } })),
    ).rejects.toMatchObject({ code: 'USAGE', message: expect.stringContaining('no picture') });
  });

  it('holds the last picture to the end of the part, so a part that ends late still has frames', async () => {
    const out = join(dir, 'past-end');
    const made = await extractFrames(tools!.ffmpeg, request(out, { trim: { start: 1.5, end: 2.5 } }));
    expect(made.count).toBe(12);
    // The clip ends at 2 s: from the 6th frame on, the last picture stays.
    expect(await readFile(join(out, 'f-00012.jpg'))).toEqual(await readFile(join(out, 'f-00006.jpg')));
  });

  it('refuses a concat script that names a file next to it: the container list is really passed', async () => {
    // Without -format_whitelist, FFmpeg reads the clip.mp4 that this script names and writes its frames.
    await writeFile(join(dir, 'c.mp4'), 'ffconcat version 1.0\nfile clip.mp4\n');
    await expect(
      extractFrames(
        tools!.ffmpeg,
        request(join(dir, 'concat'), { recording: recording(join(dir, 'c.mp4')) }),
      ),
    ).rejects.toMatchObject({
      code: 'USAGE',
      message: expect.stringContaining('Recording RC1 (c.mp4) could not be decoded'),
    });
  });

  it('cuts a clip that has AAC sound, which the decoder list does not allow and the cut does not need', async (ctx) => {
    const file = await need(ctx, join(dir, 'aac.mp4'), [
      ...['-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=12'],
      ...['-f', 'lavfi', '-i', 'sine=duration=1'],
      ...[...PICTURE, '-c:a', 'aac'],
    ]);
    const made = await extractFrames(
      tools!.ffmpeg,
      request(join(dir, 'aac'), { recording: await probed(file), trim: { start: 0, end: 1 } }),
    );
    expect(made.count).toBe(12);
  });

  it('cuts the video track that the probe checked, also when the file marks another one as its default', async (ctx) => {
    // The probe reads the first video track. Without "-map 0:v:0" FFmpeg takes the default one, here the blue one.
    const file = await need(ctx, join(dir, 'two.mkv'), [
      ...['-f', 'lavfi', '-i', 'color=c=red:size=320x240:rate=12:duration=1'],
      ...['-f', 'lavfi', '-i', 'color=c=blue:size=640x640:rate=12:duration=1'],
      ...['-map', '0:v', '-map', '1:v', ...PICTURE],
      ...['-disposition:v:0', '0', '-disposition:v:1', 'default'],
    ]);
    const recording = await probed(file);
    expect([recording.width, recording.height]).toEqual([320, 240]);
    const out = join(dir, 'two');
    await extractFrames(tools!.ffmpeg, request(out, { recording, trim: { start: 0, end: 1 } }));
    const [red, , blue] = await firstColor(out);
    expect(red).toBeGreaterThan(200);
    expect(blue).toBeLessThan(60);
  });

  it('masks an e-mail address in the name of a file that it cannot decode', async () => {
    const file = join(dir, 'jane.doe@example.com.mp4');
    await writeFile(file, 'not a video');
    const error = await extractFrames(
      tools!.ffmpeg,
      request(join(dir, 'named'), { recording: recording(file) }),
    ).catch((err: unknown) => err);
    expect(error).toMatchObject({ code: 'USAGE', message: expect.stringContaining('j•••@example.com.mp4') });
    expect(String((error as Error).message)).not.toContain('jane.doe');
  });

  it('shows the clip at the start of the part, from the clip time and not from the first frame', async () => {
    const whole = join(dir, 'moment-whole');
    const late = join(dir, 'moment-late');
    await extractFrames(tools!.ffmpeg, request(whole));
    await extractFrames(tools!.ffmpeg, request(late, { trim: { start: 1, end: 2 } }));
    const first = await readFile(join(whole, 'f-00001.jpg'));
    const second = await readFile(join(late, 'f-00001.jpg'));
    expect(second).not.toEqual(first);
    // One second into the clip is the 13th frame of the whole clip.
    expect(second).toEqual(await readFile(join(whole, 'f-00013.jpg')));
  });

  it.for([
    { name: 'red', at: { x: 0, y: 0 }, color: [255, 0, 0] },
    { name: 'green', at: { x: 0.5, y: 0 }, color: [0, 128, 0] },
    { name: 'blue', at: { x: 0, y: 0.5 }, color: [0, 0, 255] },
    { name: 'yellow', at: { x: 0.5, y: 0.5 }, color: [255, 255, 0] },
  ])('a zoom to the $name quarter shows that quarter of the picture', async ({ name, at, color }, ctx) => {
    const file = await need(ctx, join(dir, 'quarters.mp4'), QUARTERS);
    const out = join(dir, `quarter-${name}`);
    await extractFrames(
      tools!.ffmpeg,
      request(out, { recording: await probed(file), zoom: { ...at, w: 0.5, h: 0.5 } }),
    );
    const shown = await firstColor(out);
    for (const [index, wanted] of color.entries()) {
      expect(Math.abs((shown[index] ?? 0) - wanted)).toBeLessThan(40);
    }
  });

  it('accepts a start time that is written as 1e-7 in code', async () => {
    const made = await extractFrames(
      tools!.ffmpeg,
      request(join(dir, 'tiny'), { trim: { start: 1e-7, end: 2 } }),
    );
    expect(made.count).toBe(24);
  });

  it('writes into a run folder whose path has a percent sign', async () => {
    const out = join(dir, '100%d-done');
    const made = await extractFrames(tools!.ffmpeg, request(out));
    expect(made.count).toBe(24);
    expect(await readdir(out)).toHaveLength(24);
  });

  it('shows the colours of a BT.709 recording as they are', async (ctx) => {
    const file = await need(ctx, join(dir, 'c709.mp4'), SEA_GREEN_709);
    const out = join(dir, 'c709');
    await extractFrames(
      tools!.ffmpeg,
      request(out, { recording: await probed(file), trim: { start: 0, end: 1 } }),
    );
    const [red, green, blue] = await firstColor(out);
    // Without the colour matrix on the scale step, the green comes out about 12 too high.
    expect(Math.abs(red - 0x2e)).toBeLessThan(8);
    expect(Math.abs(green - 0x8b)).toBeLessThan(8);
    expect(Math.abs(blue - 0x57)).toBeLessThan(8);
  });

  it('shows the picture that was on screen, not later footage, where a clip has no frames', async (ctx) => {
    // Frames only from 0 to 1 s and from 6 to 7 s: a screen recording where nothing moved in between.
    const file = await need(ctx, join(dir, 'gap.mp4'), [
      ...['-f', 'lavfi', '-i', 'testsrc2=duration=8:size=320x240:rate=12'],
      ...['-vf', "select='lt(t,1)+gte(t,6)'", '-fps_mode', 'passthrough', ...PICTURE],
    ]);
    const packets = await runCommand(
      tools!.ffprobe,
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file],
      { timeoutMs: 20_000 },
    );
    const times = packets.stdout.split('\n').filter(Boolean).map(Number);
    expect(times.some((time) => time > 1.2 && time < 5.8)).toBe(false);
    expect(times.some((time) => time >= 6)).toBe(true);

    const recording = await probed(file);
    const before = join(dir, 'gap-before');
    const inside = join(dir, 'gap-inside');
    const after = join(dir, 'gap-after');
    await extractFrames(tools!.ffmpeg, request(before, { recording, trim: { start: 0, end: 2 } }));
    const held = await extractFrames(
      tools!.ffmpeg,
      request(inside, { recording, trim: { start: 2, end: 4 } }),
    );
    await extractFrames(tools!.ffmpeg, request(after, { recording, trim: { start: 6, end: 7 } }));
    expect(held.count).toBe(24);
    const lastBefore = await readFile(join(before, 'f-00024.jpg'));
    for (let index = 1; index <= 24; index++) {
      expect(await readFile(join(inside, `f-${String(index).padStart(5, '0')}.jpg`))).toEqual(lastBefore);
    }
    expect(await readFile(join(after, 'f-00001.jpg'))).not.toEqual(lastBefore);
  });

  it('gives at least one frame for a clip of 0.2 seconds or a little more', async () => {
    const file = join(dir, 'three-frames.mp4');
    expect(await makeClip(tools!.ffmpeg, file, { frames: 3 })).toBe(true);
    const recording = await probed(file);
    expect(recording.durationSec).toBeGreaterThanOrEqual(0.2);
    const made = await extractFrames(
      tools!.ffmpeg,
      request(join(dir, 'three-frames'), { recording, trim: { start: 0, end: recording.durationSec } }),
    );
    expect(made.count).toBeGreaterThanOrEqual(1);
  });

  it('draws a recording that a phone stored turned on its side upright, with the size that the probe gives', async (ctx) => {
    const file = await need(ctx, join(dir, 'turned.mp4'), [
      '-display_rotation',
      '90',
      '-i',
      clip,
      '-c',
      'copy',
    ]);
    const recording = await probed(file);
    expect(recording).toMatchObject({ width: 240, height: 320 });
    const made = await extractFrames(
      tools!.ffmpeg,
      request(join(dir, 'turned'), { recording, box: { width: 640, height: 640 } }),
    );
    expect(made).toMatchObject({ width: recording.width, height: recording.height });
  });

  it('does not decode a picture of more than 40 megapixels that a clip switches to after its header', async (ctx) => {
    // 1 s of 320x240, then three frames of 8000x6000, joined as one H.264 stream: the header says 320x240.
    const small = join(dir, 'small.h264');
    const huge = join(dir, 'huge.h264');
    const picture = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-f', 'h264'];
    const made =
      (await ffmpegTo(tools!.ffmpeg, [
        ...['-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=12'],
        ...picture,
        small,
      ])) &&
      (await ffmpegTo(tools!.ffmpeg, [
        ...['-f', 'lavfi', '-i', 'color=c=red:size=8000x6000:rate=12', '-frames:v', '3'],
        ...picture,
        huge,
      ]));
    if (!made) ctx.skip();
    await writeFile(join(dir, 'mixed.h264'), Buffer.concat([await readFile(small), await readFile(huge)]));
    const file = await need(ctx, join(dir, 'mixed.mp4'), [
      '-framerate',
      '12',
      '-f',
      'h264',
      '-i',
      join(dir, 'mixed.h264'),
      '-c',
      'copy',
    ]);
    const recording = await probed(file);
    expect(recording).toMatchObject({ width: 320, height: 240 });
    const out = join(dir, 'mixed');
    await extractFrames(tools!.ffmpeg, request(out, { recording, trim: { start: 0, end: 1.25 } }));
    // The large pictures are red. With the picture limit they are refused, and the last small one stays.
    const files = (await readdir(out)).sort();
    const [, green] = await averageColor(tools!.ffmpeg, join(out, files.at(-1)!));
    expect(green).toBeGreaterThan(60);
  });
});

describe.skipIf(tools === null)('extractStoryboardFrames', () => {
  let dir: string;
  let counter: string;
  let quarters: string;
  let wide: string;
  let small: string;
  const sceneVisual = (visual: object, id = 's'): Storyboard['scenes'][number] =>
    ({ id, visual }) as unknown as Storyboard['scenes'][number];
  const recordingScene = (recordingId: string, id: string, over: object = {}) =>
    sceneVisual({ type: 'recording', recordingId, trim: null, speed: null, zoom: null, ...over }, id);
  const panel = (recordingId: string) => ({ kind: 'recording', recordingId });
  const beforeAfter = (before: string, after: string, id = 'ba') =>
    sceneVisual({ type: 'before-after', before: panel(before), after: panel(after) }, id);

  /** Run the extraction for these scenes, over a counter clip (RC1, 3 s) and a clip of quarters (RC2, 2 s). */
  async function extract(scenes: Storyboard['scenes'], maxClipSeconds = 20) {
    const inputs: ContextInputs = {
      task: null,
      notes: null,
      tests: [],
      screenshots: [],
      recordings: [
        await probed(counter, 'RC1'),
        await probed(quarters, 'RC2'),
        await probed(wide, 'RC3'),
        await probed(small, 'RC4'),
      ],
    };
    const runDir = await mkdtemp(join(dir, 'run-'));
    const frames = await extractStoryboardFrames(
      { scenes } as Storyboard,
      inputs,
      testConfig({ inputs: { maxClipSeconds } }),
      runDir,
      new AbortController().signal,
    );
    return { frames, runDir };
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mergestory-storyboard-frames-'));
    counter = join(dir, 'counter.mp4');
    expect(await makeClip(tools!.ffmpeg, counter, { seconds: 3 })).toBe(true);
    quarters = join(dir, 'quarters.mp4');
    expect(await ffmpegTo(tools!.ffmpeg, [...QUARTERS, quarters])).toBe(true);
    wide = join(dir, 'wide.mp4');
    expect(await makeClip(tools!.ffmpeg, wide, { seconds: 1, size: '4000x1500' })).toBe(true);
    small = join(dir, 'small.mp4');
    expect(await makeClip(tools!.ffmpeg, small, { seconds: 1, size: '640x240' })).toBe(true);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('cuts the frames of a scene with a focus for a larger box, and never larger than the recording', async () => {
    const focus = { x: 0.2, y: 0.2, w: 0.3, h: 0.3 };
    const { frames } = await extract([
      recordingScene('RC3', 'plain'),
      recordingScene('RC3', 'focused', { focus }),
      recordingScene('RC4', 'small', { focus }),
    ]);
    // The box of a scene is 1680x624; with a focus it is 1.5 times as large, 2520x936. The source is larger than both.
    expect(frames.get('recording-frames/s-1')).toMatchObject({ width: 1664, height: 624 });
    expect(frames.get('recording-frames/s-2')).toMatchObject({ width: 2496, height: 936 });
    // A recording that is smaller than the box is never scaled up, with a focus or not.
    expect(frames.get('recording-frames/s-3')).toMatchObject({ width: 640, height: 240 });
  });

  it('names the folders by the place of the scene, and honours the trim and zoom of a scene', async () => {
    const { frames, runDir } = await extract([
      sceneVisual({ type: 'title' }, 'intro'),
      recordingScene('RC1', 'clip', { trim: { start: 1, end: 2 }, zoom: { x: 0, y: 0, w: 0.5, h: 0.5 } }),
      beforeAfter('RC1', 'RC2'),
    ]);
    expect([...frames.keys()].sort()).toEqual([
      'recording-frames/s-2',
      'recording-frames/s-3.after',
      'recording-frames/s-3.before',
    ]);
    expect(frames.get('recording-frames/s-2')).toEqual({
      dir: 'recording-frames/s-2',
      count: 12,
      width: 160,
      height: 120,
    });
    expect(frames.get('recording-frames/s-3.before')).toMatchObject({ count: 36, width: 320, height: 240 });
    expect(await readdir(join(runDir, 'recording-frames'))).toHaveLength(3);
  });

  it('gives two scenes whose ids differ only by case two folders with their own clips', async () => {
    const { frames, runDir } = await extract([recordingScene('RC1', 'rec'), recordingScene('RC2', 'REC')]);
    expect([...frames.keys()].sort()).toEqual(['recording-frames/s-1', 'recording-frames/s-2']);
    const first = await averageColor(tools!.ffmpeg, join(runDir, 'recording-frames/s-1/f-00001.jpg'));
    const second = await averageColor(tools!.ffmpeg, join(runDir, 'recording-frames/s-2/f-00001.jpg'));
    expect(first.map((value, index) => Math.abs(value - second[index]!)).some((gap) => gap > 30)).toBe(true);
  });

  it('shows a panel for at most inputs.maxClipSeconds of its clip', async () => {
    const { frames } = await extract([beforeAfter('RC1', 'RC1')], 1);
    expect(frames.get('recording-frames/s-1.before')?.count).toBe(12);
    expect(frames.get('recording-frames/s-1.after')?.count).toBe(12);
  });

  it('works for a scene id of 70 slashes', async () => {
    const { frames, runDir } = await extract([recordingScene('RC1', '/'.repeat(70))]);
    expect(frames.get('recording-frames/s-1')?.count).toBe(36);
    expect((await readdir(join(runDir, 'recording-frames/s-1'))).length).toBe(36);
  });
});
