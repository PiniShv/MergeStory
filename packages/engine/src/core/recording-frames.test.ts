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

  it('gives the frame itself for a time that lies exactly on the frame grid', () => {
    const half = { startSec: 0.5, speed: 1, fps: 12, count: 240 };
    // 0.5 + n / 12 is often a hair below the exact value, which plain Math.floor turns into n - 1.
    for (let n = 0; n < 240; n++) expect(frameIndexAt(half, 0.5 + n / 12)).toBe(n);
    expect(frameIndexAt(half, 0.6666666666666666)).toBe(2);
    expect(frameIndexAt(set, 1.04)).toBe(0);
    expect(frameIndexAt(set, 1 + 1 / 12)).toBe(1);
  });

  it('still rounds down between two frames', () => {
    // Math.round would give 1 here.
    expect(frameIndexAt(set, 1 + 0.9 / 12)).toBe(0);
    expect(frameIndexAt(set, 1 + 1.9 / 12)).toBe(1);
  });

  it('keeps frames on the grid at other speeds', () => {
    for (const speed of [0.5, 4]) {
      const fast = { startSec: 0.5, speed, fps: 12, count: 2000 };
      for (let n = 0; n < 240; n++) expect(frameIndexAt(fast, 0.5 + n / (12 * speed))).toBe(n);
    }
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
  it('numbers files from 1 and names a folder by the scene place and the side', () => {
    expect(frameFileName(0)).toBe('f-00001.jpg');
    expect(frameDirFor(3, null)).toBe('recording-frames/s-3');
    expect(frameDirFor(12, 'after')).toBe('recording-frames/s-12.after');
    expect(frameDirFor(1, 'before')).toBe('recording-frames/s-1.before');
  });

  it('never gives two uses the same folder', () => {
    const dirs = [1, 2, 10, 11].flatMap((n) => [
      frameDirFor(n, null),
      frameDirFor(n, 'before'),
      frameDirFor(n, 'after'),
    ]);
    expect(new Set(dirs).size).toBe(dirs.length);
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
