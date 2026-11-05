import { describe, expect, it } from 'vitest';
import { clipToRect, fitLayout, layoutBounds, planNodeText, roundedPath, trimEnd } from './architecture.ts';

describe('roundedPath', () => {
  it('measures a straight line exactly', () => {
    const p = roundedPath([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]);
    expect(p.length).toBe(100);
    expect(p.d).toBe('M0 0L100 0');
    expect(p.at(50)).toEqual({ x: 50, y: 0, angle: 0 });
  });

  it('cuts a corner with a curve, shortening the path', () => {
    const p = roundedPath(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ],
      20,
    );
    expect(p.length).toBeGreaterThan(175);
    expect(p.length).toBeLessThan(200);
    expect(p.d).toContain('Q100 0 100 20');
    const end = p.at(p.length);
    expect(end.x).toBeCloseTo(100, 5);
    expect(end.y).toBeCloseTo(100, 5);
    expect(end.angle).toBeCloseTo(Math.PI / 2, 5);
    const start = p.at(0);
    expect(start).toEqual({ x: 0, y: 0, angle: 0 });
  });

  it('stays on the path while passing through a curve', () => {
    const p = roundedPath(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ],
      20,
    );
    // The curve spans from (80, 0) to (100, 20); every sample must lie in that corner box.
    const before = p.at(80);
    expect(before.x).toBeCloseTo(80, 3);
    for (let d = 80.5; d < 80 + 28; d += 0.5) {
      const pt = p.at(d);
      expect(pt.x).toBeGreaterThanOrEqual(79.9);
      expect(pt.y).toBeLessThanOrEqual(20.1);
    }
  });

  it('copes with duplicate points and a single point', () => {
    expect(
      roundedPath([
        { x: 5, y: 5 },
        { x: 5, y: 5 },
      ]).length,
    ).toBe(0);
    expect(roundedPath([]).length).toBe(0);
    const straight = roundedPath([
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 100, y: 0 },
    ]);
    expect(straight.length).toBe(100);
    expect(straight.d).not.toContain('Q');
  });
});

describe('clipToRect', () => {
  const rect = { x: 0, y: 0, w: 100, h: 60 };

  it('moves a point from inside a node out to its border', () => {
    expect(clipToRect({ x: 50, y: 30 }, { x: 300, y: 30 }, rect)).toEqual({ x: 100, y: 30 });
    expect(clipToRect({ x: 50, y: 30 }, { x: 50, y: -100 }, rect)).toEqual({ x: 50, y: 0 });
  });

  it('leaves points that are already outside alone', () => {
    expect(clipToRect({ x: 120, y: 30 }, { x: 300, y: 30 }, rect)).toEqual({ x: 120, y: 30 });
  });
});

describe('trimEnd', () => {
  it('pulls the last point back along its segment', () => {
    const out = trimEnd(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      12,
    );
    expect(out[1]).toEqual({ x: 88, y: 0 });
  });

  it('keeps very short last segments', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ];
    expect(trimEnd(points, 12)).toEqual(points);
  });
});

describe('layout fitting', () => {
  const visual = {
    width: 800,
    height: 300,
    nodes: [
      { x: 100, y: 100, w: 200, h: 100 },
      { x: 700, y: 200, w: 200, h: 100 },
    ],
    edges: [
      {
        points: [
          { x: 200, y: 100 },
          { x: 900, y: 450 },
        ],
      },
    ],
  };

  it('grows the declared box to include nodes and edge points', () => {
    const b = layoutBounds(visual as never);
    expect(b).toEqual({ minX: 0, minY: 0, maxX: 900, maxY: 450 });
  });

  it('scales to the area, never beyond the limit, and centres the result', () => {
    const b = { minX: 0, minY: 0, maxX: 800, maxY: 300 };
    const fit = fitLayout(b, { w: 1680, h: 720 });
    expect(fit.scale).toBe(1.3);
    expect(fit.x + (800 * fit.scale) / 2).toBeCloseTo(840, 5);
    expect(fit.y + (300 * fit.scale) / 2).toBeCloseTo(360, 5);
  });

  it('scales large layouts down to fit inside the margin', () => {
    const fit = fitLayout({ minX: 100, minY: 50, maxX: 2100, maxY: 850 }, { w: 1680, h: 720 }, 20);
    expect(fit.scale).toBeCloseTo(1640 / 2000, 5);
    expect(2000 * fit.scale).toBeLessThanOrEqual(1640 + 1e-9);
    expect(fit.x + 100 * fit.scale).toBeGreaterThanOrEqual(20 - 1e-9);
  });
});

describe('planNodeText', () => {
  it('keeps full text in a card that was sized for it', () => {
    const plan = planNodeText({ w: 420, h: 172 }, 1, true);
    expect(plan).toMatchObject({
      labelLines: 2,
      detailLines: 2,
      showDetail: true,
      showIcon: true,
      labelFont: 30,
      detailFont: 22,
    });
  });

  it('gives up the second detail line first, then the second label line', () => {
    expect(planNodeText({ w: 340, h: 146 }, 1, true)).toMatchObject({ labelLines: 2, detailLines: 1 });
    expect(planNodeText({ w: 340, h: 112 }, 1, true)).toMatchObject({ labelLines: 1, detailLines: 1 });
  });

  it('raises fonts so they stay legible on screen when the diagram is scaled down a little', () => {
    const plan = planNodeText({ w: 300, h: 160 }, 0.9, false);
    expect(plan.detailFont * 0.9).toBeGreaterThanOrEqual(22 - 1e-9);
    expect(plan.labelFont * 0.9).toBeGreaterThanOrEqual(26 - 1e-9);
  });

  it('drops the second line, the detail and the icon before overflowing a small card', () => {
    const plan = planNodeText({ w: 300, h: 120 }, 0.55, true);
    expect(plan.labelLines).toBe(1);
    expect(plan.showDetail).toBe(false);
    expect(plan.showIcon).toBe(false);
    const used = plan.labelLines * plan.labelFont * 1.15 + (plan.showDetail ? 6 + plan.detailFont * 1.2 : 0);
    expect(used).toBeLessThanOrEqual(120 - 44 + 1e-6);
  });
});
