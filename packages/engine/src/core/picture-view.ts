/**
 * The arithmetic of the camera and of highlight labels on a picture. Node (tests) and the browser
 * runtime (the screenshot and recording templates) both use it, so they always agree.
 * A box or a view is in fractions of the picture, (0, 0) is its top left corner.
 * This file must stay dependency-free: the browser runtime imports it too.
 */

export interface PictureRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The whole picture. */
export const FULL_VIEW: PictureRect = { x: 0, y: 0, w: 1, h: 1 };

/** The camera never zooms in further than this. */
export const MAX_FOCUS_SCALE = 4;

/** The camera move: it starts no earlier than this, takes this share of the scene, and ends this long before the scene does. */
const MOVE_START_MIN_SEC = 1.2;
const MOVE_SHARE = 0.6;
const MOVE_LENGTH_MIN_SEC = 2.5;
const MOVE_LENGTH_MAX_SEC = 8;
const MOVE_END_GAP_SEC = 0.5;
/** A very short scene still gets a move of this length. */
const MOVE_SHORTEST_SEC = 0.4;

/**
 * The two thin lines on each side of the accent line of a highlight. For any colour under a box, white
 * or black has a contrast of at least 4.58 to 1 with it (their two ratios multiply to 21), so a box can
 * be seen on every picture. The outer line is pure black: a near-black would only guarantee 4.41.
 */
export const HIGHLIGHT_OUTER = '#000000';
export const HIGHLIGHT_INNER = '#ffffff';

/** Space between a label and its box, in pixels of the screen. */
export const LABEL_GAP = 8;

const finite = (n: number, fallback: number): number => (Number.isFinite(n) ? n : fallback);
const clamp = (n: number, low: number, high: number): number => Math.min(high, Math.max(low, n));

/**
 * The view the camera rests on: the focus box fills the window as far as its shape allows (the
 * window has the picture's shape, so the view is a square of fractions), at most MAX_FOCUS_SCALE times
 * as close as the whole picture. It never shows anything outside the picture, so near an edge the box
 * is not centred.
 */
export function focusView(focus: PictureRect): PictureRect {
  const w = clamp(finite(focus.w, 1), 0.001, 1);
  const h = clamp(finite(focus.h, 1), 0.001, 1);
  const x = clamp(finite(focus.x, 0), 0, 1 - w);
  const y = clamp(finite(focus.y, 0), 0, 1 - h);
  const size = 1 / clamp(Math.min(1 / w, 1 / h), 1, MAX_FOCUS_SCALE);
  return {
    x: clamp(x + w / 2 - size / 2, 0, 1 - size),
    y: clamp(y + h / 2 - size / 2, 0, 1 - size),
    w: size,
    h: size,
  };
}

/** When the camera move starts and ends, in scene seconds. `firstBeatSec` is when the first beat starts. */
export function cameraMove(durationSec: number, firstBeatSec: number): { start: number; end: number } {
  const duration = Math.max(0, finite(durationSec, 0));
  const length = clamp(duration * MOVE_SHARE, MOVE_LENGTH_MIN_SEC, MOVE_LENGTH_MAX_SEC);
  const wanted = Math.max(MOVE_START_MIN_SEC, finite(firstBeatSec, 0));
  const end = Math.min(wanted + length, Math.max(duration - MOVE_END_GAP_SEC, MOVE_SHORTEST_SEC));
  return { start: Math.min(wanted, end - MOVE_SHORTEST_SEC), end };
}

const easeInOutSine = (p: number): number => -(Math.cos(Math.PI * p) - 1) / 2;

/**
 * The part of the picture that the camera shows at scene time `t`: the whole picture until the move
 * starts, then each edge of the view moves in a straight line (eased in and out) to the focus view,
 * which it keeps. So every view lies inside the picture and the scale never goes down.
 */
export function viewAt(
  focus: PictureRect | null,
  move: { start: number; end: number },
  t: number,
): PictureRect {
  if (!focus) return FULL_VIEW;
  const span = move.end - move.start;
  const raw = span > 0 ? (finite(t, 0) - move.start) / span : t >= move.end ? 1 : 0;
  const p = easeInOutSine(clamp(raw, 0, 1));
  const to = focusView(focus);
  const mix = (a: number, b: number): number => a + (b - a) * p;
  return { x: mix(0, to.x), y: mix(0, to.y), w: mix(1, to.w), h: mix(1, to.h) };
}

/** How many times larger than the whole picture the view shows it. */
export const scaleOf = (view: PictureRect): number => 1 / Math.max(view.w, 1 / MAX_FOCUS_SCALE);

export type LabelSide = 'above' | 'below' | 'inside';

export interface LabelPlacement {
  /** Above the box's top left corner, below the box, or inside the box at its top. */
  side: LabelSide;
  /** Move to the right, in screen pixels; zero or less (a label moves left to stay in the picture). */
  dx: number;
  /** Where the label's left edge starts, as a fraction of the picture: the box's left edge, or the left edge of the view it rests on. */
  x: number;
}

/** A label inside its box keeps clear of the box's three lines. */
export const INSIDE_OFFSET = 10;

const overlapsView = (box: PictureRect, view: PictureRect): boolean =>
  box.x < view.x + view.w && box.x + box.w > view.x && box.y < view.y + view.h && box.y + box.h > view.y;

/** The views in which a box is on screen: the whole picture and, when the box is in it, the view the camera rests on. */
const viewsOf = (box: PictureRect, rest: PictureRect): PictureRect[] =>
  overlapsView(box, rest) ? [FULL_VIEW, rest] : [FULL_VIEW];

/**
 * Where the label of a box goes. A label keeps its size on the screen while the camera moves, so the
 * room is counted in screen pixels, in the whole picture and, when the box is in it, in the view the
 * camera rests on. `picture` is the size of the whole picture at scale 1 (pixels). `fits` lists the
 * sides that have room, best first; `inside` is always the last one.
 */
function spot(
  box: PictureRect,
  label: { w: number; h: number },
  picture: { w: number; h: number },
  rest: PictureRect,
): { fits: LabelSide[]; dx: number; x: number } {
  const views = viewsOf(box, rest);
  const room = (f: (v: PictureRect) => number): number => Math.min(...views.map((v) => f(v) / v.w));
  // A box that starts left of the resting view puts its label at that view's left edge, so it is seen at rest.
  const x = views.length > 1 ? Math.max(box.x, rest.x) : box.x;
  const above = room((v) => (box.y - v.y) * picture.h);
  const below = room((v) => (v.y + v.h - box.y - box.h) * picture.h);
  const right = room((v) => (v.x + v.w - x) * picture.w);
  const left = room((v) => (x - v.x) * picture.w);
  const need = label.h + LABEL_GAP;
  const fits: LabelSide[] = [];
  if (above >= need) fits.push('above');
  if (below >= need) fits.push('below');
  fits.push('inside');
  return { fits, dx: 0 - clamp(label.w - right, 0, Math.max(0, left)), x };
}

export function placeLabel(
  box: PictureRect,
  label: { w: number; h: number },
  picture: { w: number; h: number },
  rest: PictureRect = FULL_VIEW,
): LabelPlacement {
  const { fits, dx, x } = spot(box, label, picture, rest);
  return { side: fits[0] ?? 'inside', dx, x };
}

/** The rectangle of a placed label on the screen, in pixels from the top left of the view. */
function labelRect(
  box: PictureRect,
  label: { w: number; h: number },
  at: LabelPlacement,
  picture: { w: number; h: number },
  view: PictureRect,
): PictureRect {
  const top = ((box.y - view.y) * picture.h) / view.w;
  const bottom = ((box.y + box.h - view.y) * picture.h) / view.w;
  const inside = at.side === 'inside';
  const y =
    at.side === 'above'
      ? top - LABEL_GAP - label.h
      : at.side === 'below'
        ? bottom + LABEL_GAP
        : top + INSIDE_OFFSET;
  const x = ((at.x - view.x) * picture.w) / view.w + at.dx + (inside ? INSIDE_OFFSET : 0);
  return { x, y, w: label.w, h: label.h };
}

const crosses = (a: PictureRect, b: PictureRect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Where the labels of one picture go. Each label is placed as `placeLabel` says, but when it would lie
 * on top of an earlier label (in the whole picture or in the view the camera rests on) it takes the next
 * side that has room and is free. When none is free it keeps its first side.
 */
export function placeLabels(
  items: readonly { box: PictureRect; label: { w: number; h: number } }[],
  picture: { w: number; h: number },
  rest: PictureRect = FULL_VIEW,
): LabelPlacement[] {
  const done: LabelPlacement[] = [];
  items.forEach((item, index) => {
    const { fits, dx, x } = spot(item.box, item.label, picture, rest);
    const free = (side: LabelSide): boolean => {
      const at: LabelPlacement = { side, dx, x };
      return done.every((other, j) => {
        const before = items[j];
        if (!before) return true;
        const shared = viewsOf(item.box, rest).filter((v) => viewsOf(before.box, rest).includes(v));
        return !shared.some((v) =>
          crosses(
            labelRect(item.box, item.label, at, picture, v),
            labelRect(before.box, before.label, other, picture, v),
          ),
        );
      });
    };
    done[index] = { side: fits.find(free) ?? fits[0] ?? 'inside', dx, x };
  });
  return done;
}
