/**
 * Where a note card goes next to a code window. Pure geometry, no DOM: the code view knows exactly
 * where every row of text ends, so a card can be put where it covers no code. All boxes use one
 * coordinate system (the scene's content area).
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One row of code text: its top and bottom edge and where its last character ends. */
export interface InkRow {
  top: number;
  bottom: number;
  right: number;
}

export type CalloutKind =
  /** Beside the window, in free space to its right. */
  | 'side'
  /** Over the window's empty right-hand side, above the focused lines. */
  | 'above'
  /** Over the window's empty right-hand side, below the focused lines. */
  | 'below'
  /** Above the window, outside it. */
  | 'top'
  /** Under the window, outside it. */
  | 'under';

export interface Placement extends Box {
  kind: CalloutKind;
  /** Area of code text the card covers, in square px. Zero unless there was no free place. */
  covered: number;
}

export interface PlaceInput {
  /** The space the scene may use. */
  area: Box;
  /** The code window. */
  window: Box;
  /** The part of the window a card may sit on: below the title bar and above the footer. */
  inner: Box;
  /** The focused rows (bar position), or null when the note points at no row. */
  focus: { top: number; bottom: number } | null;
  /** Text rows of the window. */
  ink: readonly InkRow[];
  /** Card size for a given width. Widths are tried in order, so put the preferred one first. */
  sizeFor: (width: number) => { w: number; h: number };
  widths: readonly number[];
  /** Space between the window and a card beside it. */
  gap?: number;
  /** Lowest y a card under the window may reach (for example, above the caption). */
  underLimit?: number;
}

/** Space kept between a card and the code text it avoids, in px. */
export const INK_MARGIN = 18;
/**
 * How far a card inside the window stays from its right edge, in px. The strip between them is
 * where a leader line runs when the card is not next to the focus bar.
 */
export const EDGE_INSET = 40;
/** Space between a card and the focus bar, in px. */
const FOCUS_GAP = 14;

/** Square px of code text a card at (x, y) with size w x h would cover. */
export function coveredInk(box: Box, window: Box, ink: readonly InkRow[]): number {
  let area = 0;
  for (const row of ink) {
    const rowRight = window.x + row.right + INK_MARGIN;
    const width = Math.min(box.x + box.w, rowRight) - box.x;
    const height = Math.min(box.y + box.h, row.bottom) - Math.max(box.y, row.top);
    if (width > 0 && height > 0) area += width * height;
  }
  return area;
}

interface Candidate extends Placement {
  dist: number;
  rank: number;
}

/**
 * Choose where a note card goes. In order of preference: beside the window, then on the window's
 * free right-hand side above or below the focused lines (nearest first), then above or under the
 * window. Only when none of these is free does the card cover code, and then as little as possible.
 */
export function placeCallout(input: PlaceInput): Placement {
  const { area, window: win, inner, focus, ink } = input;
  const gap = input.gap ?? 56;
  const rowHeight = ink.length > 0 ? Math.max(8, (ink[0]!.bottom - ink[0]!.top) / 2) : 20;
  const mid = focus ? (focus.top + focus.bottom) / 2 : win.y + win.h / 2;
  const found: Candidate[] = [];

  for (const width of input.widths) {
    const { w, h } = input.sizeFor(width);

    // Beside the window.
    const sideX = win.x + win.w + gap;
    if (sideX + w <= area.x + area.w + 0.5) {
      const low = Math.max(area.y, win.y);
      const high = Math.max(low + h, Math.min(area.y + area.h, win.y + win.h));
      const y = Math.max(low, Math.min(high - h, mid - h / 2));
      found.push({ kind: 'side', x: sideX, y, w, h, covered: 0, dist: Math.abs(y + h / 2 - mid), rank: 0 });
    }

    // On the window itself, right-aligned, clear of the focus bar.
    const insideX = win.x + win.w - EDGE_INSET - w;
    if (insideX > win.x + 96) {
      const first = inner.y + 8;
      const last = inner.y + inner.h - 8 - h;
      for (let y = first; y <= last + 0.5; y += rowHeight) {
        if (focus && y < focus.bottom + FOCUS_GAP && y + h > focus.top - FOCUS_GAP) continue;
        const box = { x: insideX, y, w, h };
        found.push({
          kind: focus && y + h <= focus.top ? 'above' : 'below',
          ...box,
          covered: coveredInk(box, win, ink),
          dist: Math.abs(y + h / 2 - mid),
          rank: 1,
        });
      }
    }

    // Above the window, and under it if the scene has room there.
    const outsideX = Math.max(area.x, Math.min(area.x + area.w - w, win.x + win.w - w));
    const topY = win.y - 16 - h;
    if (topY >= area.y) {
      found.push({
        kind: 'top',
        x: outsideX,
        y: topY,
        w,
        h,
        covered: 0,
        dist: Math.abs(topY + h / 2 - mid),
        rank: 2,
      });
    }
    if (input.underLimit !== undefined) {
      const y = win.y + win.h + 16;
      if (y + h <= input.underLimit) {
        found.push({
          kind: 'under',
          x: outsideX,
          y,
          w,
          h,
          covered: 0,
          dist: Math.abs(y + h / 2 - mid),
          rank: 2,
        });
      }
    }
  }

  found.sort(
    (a, b) =>
      Number(a.covered > 0) - Number(b.covered > 0) ||
      (a.covered > 0 ? a.covered - b.covered : 0) ||
      a.rank - b.rank ||
      a.dist - b.dist,
  );
  const best = found[0];
  if (best) return { kind: best.kind, x: best.x, y: best.y, w: best.w, h: best.h, covered: best.covered };

  // The window leaves no room at all (a very short one): sit on its lower right corner.
  const { w, h } = input.sizeFor(input.widths[input.widths.length - 1] ?? 360);
  const box = { x: win.x + win.w - EDGE_INSET - w, y: Math.max(inner.y, win.y + win.h - h - 8), w, h };
  return { kind: 'below', ...box, covered: coveredInk(box, win, ink) };
}
