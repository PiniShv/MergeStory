import type { Browser } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../core/logger.ts';
import type { RenderPlan } from '../core/render-plan.ts';
import {
  BROWSER_ARGS,
  browserSandbox,
  chooseWorkers,
  frameCountFor,
  launchWithSandbox,
  planSegments,
  posterTimeFor,
} from './chromium-renderer.ts';

function planWith(
  scenes: Array<{ type: 'title' | 'code'; startSec: number; durationSec: number }>,
  fps = 30,
): RenderPlan {
  return {
    version: 1,
    width: 1920,
    height: 1080,
    fps,
    durationSec: 30,
    theme: 'dark',
    meta: {
      title: 't',
      repoLabel: 'a/b',
      changeLabel: 'PR #1',
      headShort: 'abc1234',
      stats: { files: 1, additions: 1, deletions: 0 },
      engineVersion: '0',
    },
    captions: { enabled: true, cues: [] },
    chapters: [],
    scenes: scenes.map((s, i) => ({
      id: `s${i}`,
      role: 'mission',
      title: `Scene ${i}`,
      startSec: s.startSec,
      durationSec: s.durationSec,
      transitionIn: { type: 'none', durationSec: 0 },
      beats: [],
      visual: { type: s.type } as RenderPlan['scenes'][number]['visual'],
      refs: [],
      badges: [],
    })),
    outro: { startSec: 27, durationSec: 3.5, tagline: '', lines: [] },
  };
}

describe('frameCountFor', () => {
  it('rounds the duration at the frame rate, with at least one frame', () => {
    expect(frameCountFor(2, 30)).toBe(60);
    expect(frameCountFor(31.234, 30)).toBe(937);
    expect(frameCountFor(0.001, 30)).toBe(1);
  });
});

describe('planSegments', () => {
  it('cuts frames into segments of four seconds that do not depend on the machine', () => {
    const segments = planSegments(900, 30);
    expect(segments).toHaveLength(8);
    expect(segments[0]).toEqual({ index: 0, start: 0, end: 120 });
    expect(segments[7]).toEqual({ index: 7, start: 840, end: 900 });
    expect(planSegments(900, 30)).toEqual(segments);
  });

  it('covers every frame exactly once', () => {
    for (const [frames, fps] of [
      [1, 30],
      [60, 30],
      [961, 24],
      [4500, 60],
    ] as const) {
      const segments = planSegments(frames, fps);
      const covered = segments.reduce((n, s) => n + (s.end - s.start), 0);
      expect(covered).toBe(frames);
      segments.forEach((s, i) => {
        expect(s.start).toBe(i === 0 ? 0 : segments[i - 1]!.end);
        expect(s.index).toBe(i);
      });
    }
  });

  it('starts every segment on a keyframe: lengths are a whole number of two-second intervals', () => {
    for (const fps of [24, 30, 60]) {
      const [first] = planSegments(fps * 20, fps);
      expect((first!.end - first!.start) % (fps * 2)).toBe(0);
    }
  });
});

describe('chooseWorkers', () => {
  const gib = 1024 ** 3;

  it('uses half the processors, at most six', () => {
    expect(chooseWorkers(null, 100, 12, 64 * gib)).toBe(6);
    expect(chooseWorkers(null, 100, 32, 64 * gib)).toBe(6);
    expect(chooseWorkers(null, 100, 8, 64 * gib)).toBe(4);
    expect(chooseWorkers(null, 100, 4, 64 * gib)).toBe(2);
    expect(chooseWorkers(null, 100, 1, 64 * gib)).toBe(1);
  });

  it('is limited by memory and by the number of segments', () => {
    expect(chooseWorkers(null, 100, 12, 4 * gib)).toBe(2);
    expect(chooseWorkers(null, 100, 12, 1 * gib)).toBe(1);
    expect(chooseWorkers(null, 2, 12, 64 * gib)).toBe(2);
    expect(chooseWorkers(null, 0, 12, 64 * gib)).toBe(1);
  });

  it('honours the configured number, within the segment count', () => {
    expect(chooseWorkers(3, 100, 2, 2 * gib)).toBe(3);
    expect(chooseWorkers(12, 100, 12, 64 * gib)).toBe(12);
    expect(chooseWorkers(12, 5, 12, 64 * gib)).toBe(5);
  });
});

describe('posterTimeFor', () => {
  it('takes the frame 1.5 s into the title scene', () => {
    expect(posterTimeFor(planWith([{ type: 'title', startSec: 0, durationSec: 4 }]), 900)).toBe(1.5);
    expect(
      posterTimeFor(
        planWith([
          { type: 'code', startSec: 0, durationSec: 6 },
          { type: 'title', startSec: 5.5, durationSec: 4 },
        ]),
        900,
      ),
    ).toBe(7);
  });

  it('stays inside a short scene and inside the video', () => {
    expect(posterTimeFor(planWith([{ type: 'title', startSec: 0, durationSec: 1 }]), 900)).toBeCloseTo(
      0.8,
      5,
    );
    expect(posterTimeFor(planWith([{ type: 'title', startSec: 0, durationSec: 4 }]), 30)).toBeCloseTo(
      29 / 30,
      5,
    );
  });

  it('uses the first scene when there is no title, and handles an empty plan', () => {
    expect(posterTimeFor(planWith([{ type: 'code', startSec: 2, durationSec: 6 }]), 900)).toBe(3.5);
    expect(posterTimeFor(planWith([]), 900)).toBe(1.5);
    expect(posterTimeFor(planWith([]), 12)).toBeCloseTo(11 / 30, 5);
  });
});

describe('BROWSER_ARGS', () => {
  it('turns partial raster off so frames do not depend on the order of seeks', () => {
    expect(BROWSER_ARGS).toContain('--disable-partial-raster');
  });

  it('refuses every name lookup', () => {
    expect(BROWSER_ARGS).toContain('--host-resolver-rules=MAP * ~NOTFOUND');
  });
});

describe('browserSandbox', () => {
  it('keeps the sandbox on, except for root, where the browser cannot start with it', () => {
    expect(browserSandbox(1000)).toBe(true);
    expect(browserSandbox(undefined)).toBe(true);
    expect(browserSandbox(0)).toBe(false);
  });
});

describe('launchWithSandbox', () => {
  const browser = {} as Browser;
  function setup(...results: (Browser | Error)[]) {
    const calls: boolean[] = [];
    const lines: string[] = [];
    const launch = async (sandbox: boolean): Promise<Browser> => {
      calls.push(sandbox);
      const next = results.shift();
      if (next instanceof Error) throw next;
      return next ?? browser;
    };
    const logger = createLogger({ level: 'debug', color: false, write: (line) => lines.push(line) });
    return { calls, lines, launch, logger };
  }

  it('starts with the sandbox for a normal user', async () => {
    const { calls, lines, launch, logger } = setup(browser);
    await expect(launchWithSandbox(launch, logger, 1000)).resolves.toBe(browser);
    expect(calls).toEqual([true]);
    expect(lines).toEqual([]);
  });

  it('starts without the sandbox as root', async () => {
    const { calls, launch, logger } = setup(browser);
    await launchWithSandbox(launch, logger, 0);
    expect(calls).toEqual([false]);
  });

  it('starts without the sandbox, with a warning, when the machine refuses one', async () => {
    const refused = new Error(
      '[FATAL:zygote_host_impl_linux.cc(128)] No usable sandbox! If you are running on Ubuntu 23.10+ ...',
    );
    const { calls, lines, launch, logger } = setup(refused, browser);
    await expect(launchWithSandbox(launch, logger, 1000)).resolves.toBe(browser);
    expect(calls).toEqual([true, false]);
    expect(lines.join('\n')).toContain('does not allow the browser sandbox');
  });

  it('passes any other start failure on, without a second try', async () => {
    const missing = new Error('Failed to launch: error while loading shared libraries: libnss3.so');
    const { calls, launch, logger } = setup(missing);
    await expect(launchWithSandbox(launch, logger, 1000)).rejects.toBe(missing);
    expect(calls).toEqual([true]);
  });
});
