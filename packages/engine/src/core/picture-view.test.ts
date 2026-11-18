import { describe, expect, it } from 'vitest';
import {
  cameraMove,
  FULL_VIEW,
  focusView,
  HIGHLIGHT_INNER,
  HIGHLIGHT_OUTER,
  LABEL_GAP,
  MAX_FOCUS_SCALE,
  type PictureRect,
  placeLabel,
  placeLabels,
  scaleOf,
  viewAt,
} from './picture-view.ts';
import { contrastOn, parseColor } from './theme.ts';

const inside = (v: PictureRect): boolean =>
  v.x >= -1e-9 && v.y >= -1e-9 && v.x + v.w <= 1 + 1e-9 && v.y + v.h <= 1 + 1e-9 && v.w > 0 && v.h > 0;

const FOCUSES: PictureRect[] = [
  { x: 0, y: 0, w: 1, h: 1 },
  { x: 0.4, y: 0.4, w: 0.2, h: 0.2 },
  { x: 0, y: 0, w: 0.2, h: 0.2 },
  { x: 0.8, y: 0.8, w: 0.2, h: 0.2 },
  { x: 0.1, y: 0.7, w: 0.6, h: 0.25 },
  { x: 0.3, y: 0.05, w: 0.3, h: 0.9 },
];

describe('focusView', () => {
  it('fills the window with the box as far as its shape allows, never above the largest scale', () => {
    expect(scaleOf(focusView({ x: 0.2, y: 0.2, w: 0.5, h: 0.25 }))).toBeCloseTo(2);
    expect(scaleOf(focusView({ x: 0.2, y: 0.2, w: 0.25, h: 0.5 }))).toBeCloseTo(2);
    expect(scaleOf(focusView({ x: 0.2, y: 0.2, w: 0.2, h: 0.2 }))).toBeCloseTo(MAX_FOCUS_SCALE);
    expect(scaleOf(focusView({ x: 0.5, y: 0.5, w: 0.02, h: 0.02 }))).toBe(MAX_FOCUS_SCALE);
  });

  it('contains the box, stays inside the picture and is not centred near an edge', () => {
    for (const focus of FOCUSES) {
      const v = focusView(focus);
      expect(inside(v)).toBe(true);
      expect(v.x).toBeLessThanOrEqual(focus.x + 1e-9);
      expect(v.y).toBeLessThanOrEqual(focus.y + 1e-9);
      if (focus.w <= v.w) expect(v.x + v.w).toBeGreaterThanOrEqual(focus.x + focus.w - 1e-9);
      if (focus.h <= v.h) expect(v.y + v.h).toBeGreaterThanOrEqual(focus.y + focus.h - 1e-9);
    }
    expect(focusView({ x: 0, y: 0, w: 0.2, h: 0.2 })).toEqual({ x: 0, y: 0, w: 0.25, h: 0.25 });
    const corner = focusView({ x: 0.8, y: 0.8, w: 0.2, h: 0.2 });
    expect(corner.x + corner.w).toBeCloseTo(1);
    expect(corner.y + corner.h).toBeCloseTo(1);
  });

  it('survives values outside the ranges that a checked storyboard has', () => {
    const odd: PictureRect[] = [
      { x: -3, y: 9, w: 0, h: -1 },
      { x: Number.NaN, y: Number.POSITIVE_INFINITY, w: 5, h: Number.NaN },
    ];
    for (const focus of odd) {
      const v = focusView(focus);
      expect(inside(v)).toBe(true);
      expect(scaleOf(v)).toBeLessThanOrEqual(MAX_FOCUS_SCALE);
    }
  });
});

describe('cameraMove', () => {
  it('starts at the later of 1.2 s and the first beat, and takes 60% of the scene', () => {
    expect(cameraMove(10, 0)).toEqual({ start: 1.2, end: 7.2 });
    expect(cameraMove(10, 2)).toEqual({ start: 2, end: 8 });
  });

  it('takes at least 2.5 s and at most 8 s', () => {
    const short = cameraMove(6, 0);
    expect(short.end - short.start).toBeCloseTo(3.6);
    const mid = cameraMove(4.2, 0);
    expect(mid.end - mid.start).toBeGreaterThanOrEqual(2.5);
    const late = cameraMove(30, 2);
    expect(late.end - late.start).toBeCloseTo(8);
    const long = cameraMove(40, 0);
    expect(long.end - long.start).toBeCloseTo(8);
  });

  it('ends at least 0.5 s before the scene ends, with a shorter move in a short scene', () => {
    for (const [duration, beat] of [
      [4, 0],
      [3, 0],
      [10, 9],
      [60, 59],
      [1.5, 0],
    ] as const) {
      const move = cameraMove(duration, beat);
      expect(move.end).toBeLessThanOrEqual(Math.max(duration - 0.5, 0.4) + 1e-9);
      expect(move.end - move.start).toBeGreaterThanOrEqual(0.4 - 1e-9);
      expect(move.start).toBeGreaterThanOrEqual(0);
    }
    const short = cameraMove(3, 0);
    expect(short.end).toBe(2.5);
    expect(short.end - short.start).toBeLessThan(2.5);
  });

  it('gives a usable move for a value that is not a number', () => {
    const move = cameraMove(Number.NaN, Number.NaN);
    expect(Number.isFinite(move.start) && Number.isFinite(move.end) && move.end > move.start).toBe(true);
  });
});

describe('viewAt', () => {
  const focus = { x: 0.7, y: 0.6, w: 0.25, h: 0.2 };
  const move = cameraMove(10, 0);

  it('shows the whole picture without a focus and before the move, and rests on the focus view after it', () => {
    expect(viewAt(null, move, 5)).toEqual(FULL_VIEW);
    expect(viewAt(focus, move, 0)).toEqual(FULL_VIEW);
    expect(viewAt(focus, move, move.start)).toEqual(FULL_VIEW);
    expect(viewAt(focus, move, move.end)).toEqual(focusView(focus));
    expect(viewAt(focus, move, 99)).toEqual(focusView(focus));
  });

  it('keeps every view inside the picture and never lowers the scale', () => {
    for (const f of FOCUSES) {
      let last = 0;
      for (let t = -1; t <= 12; t += 0.01) {
        const v = viewAt(f, move, t);
        expect(inside(v)).toBe(true);
        expect(scaleOf(v)).toBeGreaterThanOrEqual(last - 1e-9);
        last = scaleOf(v);
      }
    }
  });

  it('has no jump in speed: it starts and stops at rest and its speed changes by small steps', () => {
    const dt = 0.01;
    const edge = (t: number): number => {
      const v = viewAt(focus, move, t);
      return v.x + v.w;
    };
    const speeds: number[] = [];
    for (let t = 0; t < 10; t += dt) speeds.push((edge(t + dt) - edge(t)) / dt);
    const peak = Math.max(...speeds.map(Math.abs));
    expect(peak).toBeGreaterThan(0);
    expect(Math.abs(speeds[0] ?? 1)).toBe(0);
    expect(Math.abs(speeds.at(-1) ?? 1)).toBe(0);
    for (let i = 1; i < speeds.length; i++) {
      expect(Math.abs((speeds[i] ?? 0) - (speeds[i - 1] ?? 0))).toBeLessThan(peak * 0.05);
    }
  });

  it('shows the whole picture for a move that has no length', () => {
    expect(viewAt(focus, { start: 3, end: 3 }, 2.9)).toEqual(FULL_VIEW);
    expect(viewAt(focus, { start: 3, end: 3 }, 3)).toEqual(focusView(focus));
  });
});

describe('placeLabel', () => {
  const picture = { w: 1000, h: 600 };
  const label = { w: 200, h: 36 };

  it('goes above the box when there is room, then below, then inside', () => {
    expect(placeLabel({ x: 0.3, y: 0.5, w: 0.2, h: 0.2 }, label, picture).side).toBe('above');
    expect(placeLabel({ x: 0.3, y: 0.02, w: 0.2, h: 0.2 }, label, picture).side).toBe('below');
    expect(placeLabel({ x: 0.3, y: 0.02, w: 0.2, h: 0.96 }, label, picture).side).toBe('inside');
  });

  it('needs the height of the label and its gap', () => {
    const y = (label.h + LABEL_GAP) / picture.h;
    expect(placeLabel({ x: 0.3, y, w: 0.2, h: 0.2 }, label, picture).side).toBe('above');
    expect(placeLabel({ x: 0.3, y: y - 0.01, w: 0.2, h: 0.2 }, label, picture).side).toBe('below');
  });

  it('moves left so that the label stays in the picture, and not past the left edge', () => {
    expect(placeLabel({ x: 0.3, y: 0.5, w: 0.2, h: 0.2 }, label, picture).dx).toBe(0);
    expect(placeLabel({ x: 0.9, y: 0.5, w: 0.1, h: 0.2 }, label, picture).dx).toBeCloseTo(-100);
    expect(
      placeLabel({ x: 0.05, y: 0.5, w: 0.1, h: 0.2 }, { w: 400, h: 36 }, picture).dx,
    ).toBeGreaterThanOrEqual(-50);
  });

  it('counts the room in the view that the camera rests on, in screen pixels', () => {
    const box = { x: 0.5, y: 0.5, w: 0.1, h: 0.1 };
    // The view starts just above the box: no room above it on the screen at the end of the move.
    const rest = { x: 0.4, y: 0.49, w: 0.25, h: 0.25 };
    expect(placeLabel(box, label, picture).side).toBe('above');
    expect(placeLabel(box, label, picture, rest).side).toBe('below');
  });

  it('ignores a view that does not show the box', () => {
    const box = { x: 0.5, y: 0.5, w: 0.1, h: 0.1 };
    expect(placeLabel(box, label, picture, { x: 0, y: 0, w: 0.25, h: 0.25 }).side).toBe('above');
  });
});

describe('placeLabel at the view the camera rests on', () => {
  const picture = { w: 1000, h: 560 };
  const label = { w: 160, h: 36 };
  const rest = focusView({ x: 0.55, y: 0.45, w: 0.3, h: 0.3 });

  it('starts the label at the left edge of the resting view when the box starts left of it', () => {
    const wide = { x: 0.1, y: 0.5, w: 0.8, h: 0.2 };
    expect(placeLabel(wide, label, picture).x).toBe(0.1);
    expect(placeLabel(wide, label, picture, rest).x).toBeCloseTo(0.55);
    // A box that starts inside the view, or outside it on the right, keeps its own edge.
    expect(placeLabel({ x: 0.6, y: 0.5, w: 0.5, h: 0.2 }, label, picture, rest).x).toBe(0.6);
    // A box that is not in the view at all is not moved by it.
    expect(placeLabel({ x: 0.1, y: 0.05, w: 0.2, h: 0.1 }, label, picture, rest).x).toBe(0.1);
  });
});

describe('placeLabels', () => {
  const picture = { w: 1000, h: 560 };

  it('puts the second of two labels that lie on top of each other on another side', () => {
    const items = [
      { box: { x: 0, y: 0, w: 0.2, h: 0.1 }, label: { w: 200, h: 36 } },
      { box: { x: 0.12, y: 0.02, w: 0.2, h: 0.1 }, label: { w: 180, h: 36 } },
    ];
    // Alone, both go below their box, and the second covers most of the first.
    expect(items.map((i) => placeLabel(i.box, i.label, picture).side)).toEqual(['below', 'below']);
    expect(placeLabels(items, picture).map((p) => p.side)).toEqual(['below', 'inside']);
  });

  it('takes the next free side, and keeps its first side when none is free', () => {
    const same = { box: { x: 0.3, y: 0.5, w: 0.2, h: 0.2 }, label: { w: 200, h: 36 } };
    expect(placeLabels([same, same, same, same], picture).map((p) => p.side)).toEqual([
      'above',
      'below',
      'inside',
      'above',
    ]);
  });

  it('does not move labels that are apart', () => {
    const a = { box: { x: 0.1, y: 0.5, w: 0.1, h: 0.1 }, label: { w: 150, h: 36 } };
    const b = { box: { x: 0.7, y: 0.5, w: 0.1, h: 0.1 }, label: { w: 150, h: 36 } };
    expect(placeLabels([a, b], picture).map((p) => p.side)).toEqual(['above', 'above']);
  });

  it('counts labels that were pulled to the left edge of the resting view', () => {
    const rest = focusView({ x: 0.55, y: 0.45, w: 0.3, h: 0.3 });
    const label = { w: 200, h: 36 };
    const a = { box: { x: 0.1, y: 0.5, w: 0.8, h: 0.2 }, label };
    const b = { box: { x: 0.2, y: 0.5, w: 0.7, h: 0.2 }, label };
    // Both labels start at the same place at rest, so the second one goes below its box.
    expect(placeLabels([a, b], picture, rest).map((p) => p.side)).toEqual(['above', 'below']);
  });
});

describe('the lines of a highlight', () => {
  const white = parseColor(HIGHLIGHT_INNER);
  const black = parseColor(HIGHLIGHT_OUTER);

  it('have a contrast of 4.5 to 1 on any colour, with white or with black', () => {
    if (!white || !black) throw new Error('the line colours must parse');
    const levels = [0, 17, 51, 85, 119, 128, 136, 153, 170, 187, 204, 238, 255];
    let worst = Number.POSITIVE_INFINITY;
    for (const r of levels) {
      for (const g of levels) {
        for (const b of levels) {
          const bg: [number, number, number, number] = [r, g, b, 1];
          worst = Math.min(worst, Math.max(contrastOn(white, bg), contrastOn(black, bg)));
        }
      }
    }
    expect(worst).toBeGreaterThanOrEqual(4.5);
    // The grey that sits between the two is where it is weakest, and it is still above 4.5.
    expect(worst).toBeLessThan(4.7);
  });
});
