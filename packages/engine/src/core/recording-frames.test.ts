import { describe, expect, it } from 'vitest';
import {
  frameDirFor,
  frameFileName,
  frameIndexAt,
  frameIndexesFor,
  nearestFrame,
  scenePanelStarts,
} from './recording-frames.ts';

const set = { startSec: 1, speed: 1, fps: 12, count: 24 };

describe('frameIndexAt', () => {
  it('rests on the first frame before the start and plays from the start', () => {
    expect(frameIndexAt(set, -1)).toBe(0);
    expect(frameIndexAt(set, 1)).toBe(0);
    expect(frameIndexAt(set, 2)).toBe(12);
    expect(frameIndexAt(set, 1.5)).toBe(6);
  });

  it('rests on the last frame after the clip', () => {
    expect(frameIndexAt(set, 3)).toBe(23);
    expect(frameIndexAt(set, 99)).toBe(23);
  });

  it('plays faster or slower with the speed', () => {
    expect(frameIndexAt({ ...set, speed: 2 }, 2)).toBe(24 - 1);
    expect(frameIndexAt({ ...set, speed: 0.5 }, 3)).toBe(12);
  });

  it('does not fail on a time that is not a number', () => {
    expect(frameIndexAt(set, Number.NaN)).toBe(0);
  });
});

describe('frameIndexesFor', () => {
  it('lists every frame a window can show, ends included', () => {
    expect(frameIndexesFor(set, 1.5, 2)).toEqual([6, 7, 8, 9, 10, 11, 12]);
  });

  it('gives one frame for a window before or after the clip', () => {
    expect(frameIndexesFor(set, -3, 0.5)).toEqual([0]);
    expect(frameIndexesFor(set, 10, 14)).toEqual([23]);
  });

  it('covers every index that frameIndexAt gives inside the window', () => {
    const fast = { startSec: 0.3, speed: 4, fps: 12, count: 200 };
    const listed = new Set(frameIndexesFor(fast, 1, 2));
    for (let t = 1; t <= 2; t += 1 / 30) expect(listed.has(frameIndexAt(fast, t))).toBe(true);
  });
});

describe('nearestFrame', () => {
  it('prefers the wanted frame, then the closest, the lower one on a tie', () => {
    expect(nearestFrame([3, 4, 5], 4)).toBe(4);
    expect(nearestFrame([3, 7], 4)).toBe(3);
    expect(nearestFrame([3, 5], 4)).toBe(3);
    expect(nearestFrame([10], 0)).toBe(10);
    expect(nearestFrame([], 1)).toBeNull();
  });
});

describe('names', () => {
  it('numbers files from 1 and keeps folder names plain', () => {
    expect(frameFileName(0)).toBe('f-00001.jpg');
    expect(frameDirFor('s3', null)).toBe('recording-frames/s-s3');
    expect(frameDirFor('s3', 'after')).toBe('recording-frames/s-s3.after');
    expect(frameDirFor('../x/y', null)).toBe('recording-frames/s-_2e__2e__2f_x_2f_y');
    // Two ids, or an id and a side, never share a folder.
    const dirs = [
      frameDirFor('a b', null),
      frameDirFor('a_b', null),
      frameDirFor('a.b', null),
      frameDirFor('a', 'before'),
      frameDirFor('a-before', null),
      frameDirFor('a.before', null),
      frameDirFor('', null),
      frameDirFor('s', null),
    ];
    expect(new Set(dirs).size).toBe(dirs.length);
    for (const dir of dirs) expect(dir).toMatch(/^recording-frames\/s-[A-Za-z0-9_.-]*$/);
  });
});

describe('scenePanelStarts', () => {
  it('follows the first two beats, as the runtime does', () => {
    const scene = { startSec: 10, beats: [{ startSec: 10.6 }, { startSec: 12 }] } as never;
    const { before, after } = scenePanelStarts(scene);
    expect(before).toBeCloseTo(0.45, 6);
    expect(after).toBeCloseTo(1.85, 6);
  });
});
