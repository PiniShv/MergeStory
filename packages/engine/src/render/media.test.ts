import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { frameFileName } from '../core/recording-frames.ts';
import type { FrameSet, PlannedScene, RenderPlan } from '../core/render-plan.ts';
import { planWithMedia } from './media.ts';

let dir: string;
const frames = (name: string, startSec: number): FrameSet => ({
  dir: `recording-frames/${name}`,
  count: 36,
  fps: 12,
  width: 4,
  height: 2,
  startSec,
  speed: 1,
});
const scene = (id: string, startSec: number, visual: PlannedScene['visual']): PlannedScene => ({
  id,
  role: 'under-the-hood',
  title: id,
  startSec,
  durationSec: 6,
  transitionIn: { type: 'none', durationSec: 0 },
  beats: [],
  visual,
  refs: [],
  badges: [],
});
const panel = (label: string, set: FrameSet) => ({ label, kind: 'recording' as const, frames: set });
const plan = (): RenderPlan =>
  ({
    scenes: [
      scene('a', 10, { type: 'recording', caption: null, frames: frames('s-1', 0) }),
      scene('b', 20, {
        type: 'before-after',
        caption: null,
        before: panel('Before', frames('s-2.before', 0)),
        after: panel('After', frames('s-2.after', 1)),
      }),
    ],
  }) as unknown as RenderPlan;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mergestory-media-'));
  await mkdir(join(dir, 'recording-frames', 's-3.step-2'), { recursive: true });
  await writeFile(join(dir, 'recording-frames', 's-3.step-2', frameFileName(0)), 'the last picture');
  for (const name of ['s-1', 's-2.before', 's-2.after']) {
    await mkdir(join(dir, 'recording-frames', name), { recursive: true });
    for (let i = 0; i < 36; i++)
      await writeFile(join(dir, 'recording-frames', name, frameFileName(i)), `frame ${i}`);
  }
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sizes = (media: RenderPlan['media']): Record<string, number> =>
  Object.fromEntries(Object.entries(media ?? {}).map(([key, value]) => [key, Object.keys(value).length]));

describe('planWithMedia', () => {
  it('gives a window the frames it can show, as data URLs, on a copy', async () => {
    const original = plan();
    // Video seconds 11 to 12 are 1 to 2 seconds into scene "a": frames 12 to 24 of its clip.
    const copy = await planWithMedia(original, dir, 11, 12);
    expect(Object.keys(copy.media!['recording-frames/s-1']!).map(Number)).toEqual(
      Array.from({ length: 13 }, (_, i) => 12 + i),
    );
    expect(copy.media!['recording-frames/s-1']![12]).toBe(
      `data:image/jpeg;base64,${Buffer.from('frame 12').toString('base64')}`,
    );
    expect(original.media).toBeUndefined();
  });

  it('gives a window before or after a scene one frame of it', async () => {
    expect(sizes((await planWithMedia(plan(), dir, 0, 3)).media)).toEqual({
      'recording-frames/s-1': 1,
      'recording-frames/s-2.before': 1,
      'recording-frames/s-2.after': 1,
    });
    expect(sizes((await planWithMedia(plan(), dir, 40, 44)).media)).toEqual({
      'recording-frames/s-1': 1,
      'recording-frames/s-2.before': 1,
      'recording-frames/s-2.after': 1,
    });
  });

  it('returns a plan without recordings as it is', async () => {
    const none = { scenes: [] } as unknown as RenderPlan;
    expect(await planWithMedia(none, dir, 0, 1)).toBe(none);
  });

  it('gives a page the one picture of a reproduction step that has a recording, and nothing for a screenshot', async () => {
    const image = { src: 'data:image/png;base64,AAAA', width: 4, height: 2 };
    const reproPlan = {
      scenes: [
        scene('r', 30, {
          type: 'repro',
          title: 'Bug',
          environment: null,
          steps: [
            { number: 1, text: 'Open', result: null, beat: 0, thumb: { kind: 'screenshot', image } },
            {
              number: 2,
              text: 'Type',
              result: 'bug',
              beat: 1,
              thumb: { kind: 'recording', frames: { ...frames('s-3.step-2', 0), count: 1 } },
            },
            { number: 3, text: 'Look', result: null, beat: 1, thumb: null },
          ],
        }),
      ],
    } as unknown as RenderPlan;
    const copy = await planWithMedia(reproPlan, dir, 0, 40);
    expect(sizes(copy.media)).toEqual({ 'recording-frames/s-3.step-2': 1 });
    expect(copy.media!['recording-frames/s-3.step-2']![0]).toBe(
      `data:image/jpeg;base64,${Buffer.from('the last picture').toString('base64')}`,
    );
  });

  it('names a missing frame file', async () => {
    await rm(join(dir, 'recording-frames', 's-1', frameFileName(0)));
    await expect(planWithMedia(plan(), dir, 0, 1)).rejects.toMatchObject({
      code: 'RENDER_FAILED',
      message: expect.stringContaining('recording-frames/s-1/f-00001.jpg'),
    });
  });

  it('refuses a folder outside the run folder', async () => {
    const bad = plan();
    const first = bad.scenes[0]!.visual;
    if (first.type === 'recording') first.frames.dir = '../elsewhere';
    await expect(planWithMedia(bad, dir, 0, 1)).rejects.toMatchObject({ code: 'RENDER_FAILED' });
  });
});
