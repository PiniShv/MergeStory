import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveFfmpeg } from '../core/binaries.ts';
import type { RecordingInput } from '../core/types.ts';
import { testConfig } from '../testing/context.ts';
import { makeClip } from '../testing/media.ts';
import { extractFrames, frameGeometry } from './recording-frames.ts';

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
      extractFrames(tools!.ffmpeg, request(join(dir, 'late'), { trim: { start: 5, end: 6 } })),
    ).rejects.toMatchObject({ code: 'USAGE', message: expect.stringContaining('no picture') });
  });
});
