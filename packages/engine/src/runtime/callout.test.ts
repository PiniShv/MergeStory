import { describe, expect, it } from 'vitest';
import { type Box, coveredInk, EDGE_INSET, type InkRow, placeCallout } from './callout.ts';

const AREA: Box = { x: 0, y: 0, w: 1680, h: 700 };

/** A window with `rows` text rows of 40 px; `rights[i]` is where row i ends. */
function windowWith(width: number, rights: number[], top = 100) {
  const barHeight = 64;
  const rowH = 40;
  const win: Box = { x: 0, y: top, w: width, h: barHeight + 36 + rights.length * rowH };
  const ink: InkRow[] = rights.map((right, i) => ({
    top: top + barHeight + 18 + i * rowH,
    bottom: top + barHeight + 18 + (i + 1) * rowH,
    right,
  }));
  const inner: Box = { x: 0, y: top + barHeight, w: width, h: win.h - barHeight };
  return { win, ink, inner };
}

const card = (h: number) => (width: number) => ({ w: width, h });

describe('placeCallout', () => {
  it('puts the card beside the window when there is room', () => {
    const { win, ink, inner } = windowWith(1000, Array(10).fill(900));
    const focus = { top: ink[4]!.top, bottom: ink[5]!.bottom };
    const placed = placeCallout({
      area: AREA,
      window: win,
      inner,
      focus,
      ink,
      sizeFor: card(100),
      widths: [460],
    });
    expect(placed.kind).toBe('side');
    expect(placed.x).toBeGreaterThanOrEqual(win.x + win.w);
    expect(placed.x + placed.w).toBeLessThanOrEqual(AREA.x + AREA.w);
    // Level with the focus, inside the window's height.
    const mid = (focus.top + focus.bottom) / 2;
    expect(Math.abs(placed.y + placed.h / 2 - mid)).toBeLessThan(1);
    expect(placed.covered).toBe(0);
  });

  it('keeps a side card inside the height of the window when the focus is at an edge', () => {
    const { win, ink, inner } = windowWith(1000, Array(10).fill(900));
    const focus = { top: ink[0]!.top, bottom: ink[0]!.bottom };
    const placed = placeCallout({
      area: AREA,
      window: win,
      inner,
      focus,
      ink,
      sizeFor: card(160),
      widths: [460],
    });
    expect(placed.kind).toBe('side');
    expect(placed.y).toBeGreaterThanOrEqual(win.y);
  });

  it('uses the free right-hand side of a wide window, clear of the focus bar and of code', () => {
    // Long lines at the top, short ones lower down.
    const rights = [1500, 700, 1450, 600, 500, 480, 450, 400, 380, 300];
    const { win, ink, inner } = windowWith(1640, rights);
    const focus = { top: ink[0]!.top, bottom: ink[0]!.bottom };
    const placed = placeCallout({
      area: AREA,
      window: win,
      inner,
      focus,
      ink,
      sizeFor: card(110),
      widths: [520, 460, 400, 340, 300],
    });
    expect(['above', 'below']).toContain(placed.kind);
    expect(placed.covered).toBe(0);
    expect(placed.y).toBeGreaterThanOrEqual(focus.bottom);
    expect(placed.x + placed.w).toBeLessThanOrEqual(win.x + win.w - EDGE_INSET + 0.5);
    expect(coveredInk(placed, win, ink)).toBe(0);
  });

  it('goes above the focus when the lines below it are long', () => {
    const rights = [400, 380, 360, 340, 1500, 1500, 1500, 1500, 1500, 1500];
    const { win, ink, inner } = windowWith(1640, rights);
    const focus = { top: ink[7]!.top, bottom: ink[7]!.bottom };
    const placed = placeCallout({
      area: AREA,
      window: win,
      inner,
      focus,
      ink,
      sizeFor: card(110),
      widths: [520, 460, 400],
    });
    expect(placed.kind).toBe('above');
    expect(placed.y + placed.h).toBeLessThanOrEqual(focus.top);
    expect(placed.covered).toBe(0);
  });

  it('prefers a narrower card to covering code', () => {
    // Row 1 ends at 1300; a 520 px card at the right would start at 1080 and cover it.
    const rights = [1550, 1300, 400, 400, 400, 400];
    const { win, ink, inner } = windowWith(1640, rights);
    const focus = { top: ink[0]!.top, bottom: ink[0]!.bottom };
    const placed = placeCallout({
      area: AREA,
      window: win,
      inner,
      focus,
      ink,
      sizeFor: card(90),
      widths: [520, 300],
    });
    expect(placed.covered).toBe(0);
  });

  it('never overlaps the focus bar', () => {
    const rights = [200, 200, 200, 200, 200, 200, 200, 200];
    const { win, ink, inner } = windowWith(1640, rights);
    const focus = { top: ink[3]!.top - 4, bottom: ink[4]!.bottom + 4 };
    const placed = placeCallout({
      area: AREA,
      window: win,
      inner,
      focus,
      ink,
      sizeFor: card(100),
      widths: [460],
    });
    const overlapsBar = placed.y < focus.bottom && placed.y + placed.h > focus.top;
    expect(overlapsBar).toBe(false);
  });

  it('covers as little code as it can when nothing is free', () => {
    const rights = Array(8).fill(1600);
    rights[5] = 1300;
    rights[6] = 1300;
    rights[7] = 1300;
    const { win, ink, inner } = windowWith(1640, rights);
    const focus = { top: ink[0]!.top, bottom: ink[0]!.bottom };
    const placed = placeCallout({
      area: AREA,
      window: win,
      inner,
      focus,
      ink,
      sizeFor: card(100),
      widths: [460],
    });
    expect(placed.covered).toBeGreaterThan(0);
    // The least covered place is the one over the shorter lines at the bottom.
    expect(placed.y).toBeGreaterThanOrEqual(ink[4]!.top);
  });

  it('can sit under the window when the scene has room there', () => {
    const rights = Array(3).fill(1600);
    const { win, ink, inner } = windowWith(1640, rights, 40);
    const focus = { top: ink[0]!.top, bottom: ink[0]!.bottom };
    const placed = placeCallout({
      area: AREA,
      window: win,
      inner,
      focus,
      ink,
      sizeFor: card(100),
      widths: [460],
      underLimit: 690,
    });
    expect(placed.kind).toBe('under');
    expect(placed.y).toBeGreaterThanOrEqual(win.y + win.h);
    expect(placed.y + placed.h).toBeLessThanOrEqual(690);
  });

  it('goes above the window when the lines are long all the way down and there is room above', () => {
    const rights = Array(3).fill(1600);
    const { win, ink, inner } = windowWith(1640, rights, 300);
    const focus = { top: ink[1]!.top, bottom: ink[1]!.bottom };
    const placed = placeCallout({
      area: AREA,
      window: win,
      inner,
      focus,
      ink,
      sizeFor: card(100),
      widths: [460],
    });
    expect(placed.kind).toBe('top');
    expect(placed.y + placed.h).toBeLessThanOrEqual(win.y);
    expect(placed.y).toBeGreaterThanOrEqual(AREA.y);
    expect(placed.covered).toBe(0);
  });

  it('places a note that points at no row beside the window, level with its middle', () => {
    const { win, ink, inner } = windowWith(900, Array(10).fill(800));
    const placed = placeCallout({
      area: AREA,
      window: win,
      inner,
      focus: null,
      ink,
      sizeFor: card(100),
      widths: [460],
    });
    expect(placed.kind).toBe('side');
    expect(Math.abs(placed.y + placed.h / 2 - (win.y + win.h / 2))).toBeLessThan(1);
  });

  it('always returns a place, even for a window that is too short for the card', () => {
    const { win, ink, inner } = windowWith(1640, [300]);
    const placed = placeCallout({
      area: AREA,
      window: win,
      inner,
      focus: { top: ink[0]!.top, bottom: ink[0]!.bottom },
      ink,
      sizeFor: card(200),
      widths: [460],
    });
    expect(Number.isFinite(placed.x) && Number.isFinite(placed.y)).toBe(true);
  });
});

describe('coveredInk', () => {
  const win: Box = { x: 0, y: 0, w: 1000, h: 400 };
  const ink: InkRow[] = [
    { top: 100, bottom: 140, right: 500 },
    { top: 140, bottom: 180, right: 800 },
  ];

  it('counts the text a box would sit on, with a margin', () => {
    expect(coveredInk({ x: 900, y: 100, w: 90, h: 80 }, win, ink)).toBe(0);
    expect(coveredInk({ x: 700, y: 100, w: 200, h: 40 }, win, ink)).toBe(0);
    expect(coveredInk({ x: 700, y: 140, w: 200, h: 40 }, win, ink)).toBeGreaterThan(0);
  });

  it('ignores rows above and below the box', () => {
    expect(coveredInk({ x: 0, y: 200, w: 900, h: 100 }, win, ink)).toBe(0);
  });
});
