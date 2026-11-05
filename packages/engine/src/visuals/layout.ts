/**
 * Architecture diagram layout. Node and edge positions are computed here, in Node, so the browser
 * runtime only draws them. Nodes are sized from their real text (label 30 px bold, detail 22 px)
 * so the template never has to cut a name short, and the spacing is tuned for a 1920x1080 frame.
 */
import dagre from '@dagrejs/dagre';
import {
  BASE_FONTS,
  DETAIL_LINE_HEIGHT,
  DIAGRAM_AREA,
  type DiagramFonts,
  EDGE_LABEL_MAX,
  EDGE_LINE_HEIGHT,
  EDGE_PILL_HEIGHT_EM,
  EDGE_PILL_PAD_EM,
  EDGE_PILL_VPAD_EM,
  EDGE_WRAP,
  fitScale,
  fontsForScale,
  LABEL_LINE_HEIGHT,
  LABEL_SPACING_EM,
  NODE_CHROME,
  NODE_PAD_Y,
  NODE_TEXT_GAP,
} from '../core/diagram-metrics.ts';
import type { ArchitectureResolved } from '../core/render-plan.ts';
import type { Visual } from '../core/storyboard-schema.ts';

export type ArchitectureVisual = Extract<Visual, { type: 'architecture' }>;

// ---------------------------------------------------------------------------
// Text metrics
// ---------------------------------------------------------------------------

export type GlyphWeight = 500 | 600 | 700;

/**
 * Advance widths of Inter (the video font) in thousandths of an em, for the printable ASCII
 * characters (space to tilde) at three weights. Kerning is ignored, which makes the estimate
 * very slightly wide: a good side to err on.
 */
const ADVANCE_TABLE: Record<GlyphWeight, string> = {
  500: '267 304 494 639 646 993 653 313 369 369 521 667 303 462 303 370 646 415 616 627 656 603 630 571 629 630 303 315 667 667 667 527 982 709 657 733 722 603 589 748 745 272 575 688 565 913 756 767 642 769 648 646 653 740 709 1003 701 696 641 369 370 369 477 463 337 568 618 577 618 587 379 620 602 252 252 559 252 888 602 604 618 618 387 539 340 602 575 829 557 575 559 440 346 440 667',
  600: '252 321 523 644 650 1004 663 326 373 373 540 673 319 465 319 379 660 423 623 636 666 612 640 576 640 640 319 329 673 673 673 543 999 728 659 737 722 605 588 749 746 277 580 703 565 922 759 769 645 773 652 650 660 736 728 1020 720 713 652 373 379 373 481 469 351 574 624 583 624 591 389 626 612 262 262 569 262 900 612 609 624 624 397 549 353 612 587 839 569 588 566 455 359 455 673',
  700: '237 338 552 649 655 1016 672 339 377 377 559 679 334 468 334 388 674 431 630 646 676 622 649 582 651 649 334 343 679 679 679 560 1016 747 662 740 722 607 587 751 747 281 584 719 565 932 762 771 648 777 657 655 667 732 747 1038 738 731 664 377 388 377 487 476 365 581 630 588 630 596 398 632 623 271 271 580 271 913 623 613 630 630 407 560 366 623 600 850 580 602 573 469 372 469 679',
};

/** Punctuation outside ASCII that labels use often, with its advance per weight (same order). */
const EXTRA_CHARS = '…·’‘“”–—×−•';
const EXTRA_TABLE: Record<GlyphWeight, string> = {
  500: '910 303 277 277 474 471 500 1000 667 667 533',
  600: '956 319 294 294 507 501 500 1000 673 673 503',
  700: '1002 334 311 311 540 532 500 1000 679 679 474',
};

const parseTable = (table: string): number[] => table.split(' ').map(Number);
const ADVANCES: Record<GlyphWeight, number[]> = {
  500: parseTable(ADVANCE_TABLE[500]),
  600: parseTable(ADVANCE_TABLE[600]),
  700: parseTable(ADVANCE_TABLE[700]),
};
const EXTRAS: Record<GlyphWeight, number[]> = {
  500: parseTable(EXTRA_TABLE[500]),
  600: parseTable(EXTRA_TABLE[600]),
  700: parseTable(EXTRA_TABLE[700]),
};

/** Width of one character in thousandths of an em. Unknown characters count as an average letter. */
function advanceOf(ch: string, weight: GlyphWeight): number {
  const code = ch.codePointAt(0) ?? 0;
  if (code >= 32 && code <= 126) return ADVANCES[weight][code - 32] ?? 600;
  const extra = EXTRA_CHARS.indexOf(ch);
  if (extra >= 0) return EXTRAS[weight][extra] ?? 600;
  return code >= 0x2e80 ? 1000 : 600;
}

export interface TextFont {
  /** Font size in px. */
  px: number;
  weight: GlyphWeight;
  /** Letter spacing in em (the node label uses a slightly tight -0.015). */
  spacingEm?: number;
}

/** Width in px of a single line of text. */
export function textWidth(text: string, font: TextFont): number {
  let total = 0;
  let count = 0;
  for (const ch of text) {
    total += advanceOf(ch, font.weight);
    count += 1;
  }
  return (total / 1000 + count * (font.spacingEm ?? 0)) * font.px;
}

interface Segment {
  text: string;
  /** A space comes before this piece (it starts a new word). */
  spaceBefore: boolean;
}

/**
 * Pieces of text that the browser does not split further without need: words, cut after a hyphen
 * or a slash the way a line break may fall in "src/weather-api/index.ts".
 */
function segmentsOf(text: string): Segment[] {
  const out: Segment[] = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const pieces = word.split(/(?<=[-/])(?=\S)/);
    pieces.forEach((piece, i) => out.push({ text: piece, spaceBefore: i === 0 && out.length > 0 }));
  }
  return out;
}

/** Width of the widest piece of `text` that cannot be broken at a space, hyphen or slash. */
export function longestSegment(text: string, font: TextFont): number {
  return Math.max(0, ...segmentsOf(text).map((segment) => textWidth(segment.text, font)));
}

/**
 * Number of lines `text` takes in a box `width` px wide: lines break at spaces and after hyphens and
 * slashes, and a piece that is wider than the box breaks anywhere (the template sets
 * overflow-wrap: anywhere). Empty text takes no lines.
 */
export function countLines(text: string, width: number, font: TextFont): number {
  const segments = segmentsOf(text);
  if (segments.length === 0) return 0;
  const room = Math.max(1, width);
  const space = textWidth(' ', font);
  let lines = 1;
  let used = 0;
  for (const segment of segments) {
    const w = textWidth(segment.text, font);
    const gap = segment.spaceBefore && used > 0 ? space : 0;
    if (used > 0 && used + gap + w <= room) {
      used += gap + w;
      continue;
    }
    if (used > 0) lines += 1;
    if (w <= room) {
      used = w;
    } else {
      const rows = Math.ceil(w / room);
      lines += rows - 1;
      used = w - (rows - 1) * room;
    }
  }
  return lines;
}

/**
 * The smallest box width, from `from` up to `to`, in which `text` takes at most `maxLines` lines. If
 * there is none, the widest (the text is then cut, as a last resort).
 */
export function widthForLines(
  text: string,
  font: TextFont,
  maxLines: number,
  from: number,
  to: number,
): number {
  for (let width = Math.ceil(from); width < to; width += 4) {
    if (countLines(text, width, font) <= maxLines) return width;
  }
  return Math.ceil(to);
}

// ---------------------------------------------------------------------------
// Node sizes
// ---------------------------------------------------------------------------

export const MIN_NODE_WIDTH = 260;
export const MIN_NODE_HEIGHT = 96;
export const MAX_NODE_WIDTH = 480;

export const MAX_LABEL_LINES = 2;
export const MAX_DETAIL_LINES = 2;
/** Extra room kept beside every line of text, as a share of its width plus a few pixels. */
const TEXT_SLACK = 1.02;
const TEXT_SLACK_PX = 6;

const LAYOUT_MARGIN = 28;

export interface NodeSize {
  w: number;
  h: number;
}

export interface NodeEstimate extends NodeSize {
  labelLines: number;
  detailLines: number;
}

export interface NodeSizeOptions {
  /** Widest the card may become before text wraps; default MAX_NODE_WIDTH. */
  maxWidth?: number;
  fonts?: DiagramFonts;
}

/**
 * Node size from its text: wide enough for the label and detail on one line each, up to `maxWidth`,
 * then wrapped (label up to two lines, detail up to two lines) and tall enough for what wraps. A
 * card is never narrower than its longest word, so names are not broken in the middle.
 */
export function estimateNodeSize(
  label: string,
  detail: string | null,
  options: NodeSizeOptions = {},
): NodeEstimate {
  const fonts = options.fonts ?? BASE_FONTS;
  const labelFont: TextFont = { px: fonts.label, weight: 700, spacingEm: LABEL_SPACING_EM };
  const detailFont: TextFont = { px: fonts.detail, weight: 500 };
  const labelText = label.trim();
  const detailText = detail?.trim() ?? '';
  const widest = Math.max(
    textWidth(labelText, labelFont),
    detailText ? textWidth(detailText, detailFont) : 0,
  );
  const longestWord = Math.max(longestSegment(labelText, labelFont), longestSegment(detailText, detailFont));
  const minText = MIN_NODE_WIDTH - NODE_CHROME;
  const hardMax = MAX_NODE_WIDTH - NODE_CHROME;
  const floor = Math.min(hardMax, Math.max(minText, Math.ceil(longestWord * TEXT_SLACK) + TEXT_SLACK_PX));
  const ceiling = Math.max(floor, (options.maxWidth ?? MAX_NODE_WIDTH) - NODE_CHROME);
  const single = Math.ceil(widest * TEXT_SLACK) + TEXT_SLACK_PX;
  // One line each if the card may be that wide; otherwise as narrow as keeps every part within its
  // line limit, so text is only cut when even the widest card cannot hold it.
  const needed = Math.max(
    widthForLines(labelText, labelFont, MAX_LABEL_LINES, floor, hardMax),
    detailText ? widthForLines(detailText, detailFont, MAX_DETAIL_LINES, floor, hardMax) : 0,
  );
  const text = Math.min(hardMax, Math.max(floor, needed, Math.min(ceiling, single)));
  // Count lines against a slightly smaller box than the real one, so a line is never a pixel short.
  const room = text - 2;
  const labelLines = Math.min(MAX_LABEL_LINES, Math.max(1, countLines(labelText, room, labelFont)));
  const detailLines = detailText ? Math.min(MAX_DETAIL_LINES, countLines(detailText, room, detailFont)) : 0;
  const content =
    labelLines * fonts.label * LABEL_LINE_HEIGHT +
    (detailLines > 0 ? NODE_TEXT_GAP + detailLines * fonts.detail * DETAIL_LINE_HEIGHT : 0);
  return {
    w: Math.round(text + NODE_CHROME),
    h: Math.max(MIN_NODE_HEIGHT, Math.ceil(2 * NODE_PAD_Y + content)),
    labelLines,
    detailLines,
  };
}

export const MAX_EDGE_LINES = 2;

export interface EdgeLabelBox {
  /** Pill width in layout pixels. */
  w: number;
  /** Pill height in layout pixels. */
  h: number;
  lines: number;
}

/**
 * Size of an edge label pill: one line if it fits `wrapAt`, else wrapped (at most two lines). The pill
 * is never narrower than its longest word.
 */
export function edgeLabelSize(label: string, fonts: DiagramFonts, wrapAt: number): EdgeLabelBox {
  const font: TextFont = { px: fonts.edge, weight: 600 };
  const pad = 2 * EDGE_PILL_PAD_EM * fonts.edge;
  const text = label.trim();
  const longestWord = longestSegment(text, font);
  const floor = Math.max(wrapAt, Math.ceil(longestWord + pad) + 4);
  const single = textWidth(text, font) + pad;
  if (single <= floor) {
    return { w: Math.ceil(single), h: Math.ceil(EDGE_PILL_HEIGHT_EM * fonts.edge), lines: 1 };
  }
  // Two lines as narrow as the floor allows; wider only if the text would not fit two lines at all.
  const wrap = widthForLines(text, font, MAX_EDGE_LINES, floor - pad - 2, EDGE_LABEL_MAX - pad - 2) + pad + 2;
  const lines = Math.min(MAX_EDGE_LINES, Math.max(2, countLines(text, wrap - pad - 2, font)));
  const vertical = 2 * EDGE_PILL_VPAD_EM * fonts.edge;
  return { w: Math.ceil(wrap), h: Math.ceil(lines * EDGE_LINE_HEIGHT * fonts.edge + vertical), lines };
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

export type Placed = Pick<ArchitectureResolved, 'width' | 'height' | 'nodes' | 'edges'>;

// ---------------------------------------------------------------------------
// Folding a long chain into two rows
// ---------------------------------------------------------------------------

/** A diagram that needs a zoom below this is cut into two rows if that helps. */
const FOLD_BELOW_SCALE = 0.8;
/** Two rows are used when they allow a zoom at least this much larger than one. */
const FOLD_GAIN = 1.25;
/** Space between the two rows: room for the arrows that join them, and their labels. */
const FOLD_GAP = 150;
/** Room a row needs above its nodes (the status pill) and below them (edge labels). */
const ROW_TOP = 30;
const ROW_BOTTOM = 22;
/** Distance between arrows that share the channel between the rows. */
const CHANNEL_STEP = 26;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Space kept between an arrow and a card it passes, in px. */
const CLEARANCE = 10;

/** Whether a horizontal or vertical segment from a to b touches a rectangle grown by `pad`. */
function segmentHitsRect(
  a: { x: number; y: number },
  b: { x: number; y: number },
  rect: Rect,
  pad: number,
): boolean {
  const left = rect.x - rect.w / 2 - pad;
  const right = rect.x + rect.w / 2 + pad;
  const top = rect.y - rect.h / 2 - pad;
  const bottom = rect.y + rect.h / 2 + pad;
  return (
    Math.max(Math.min(a.x, b.x), left) <= Math.min(Math.max(a.x, b.x), right) &&
    Math.max(Math.min(a.y, b.y), top) <= Math.min(Math.max(a.y, b.y), bottom)
  );
}

/** The same layout with its two axes swapped (left to right becomes top to bottom). */
export function transpose(placed: Placed): Placed {
  return {
    width: placed.height,
    height: placed.width,
    nodes: placed.nodes.map((n) => ({ ...n, x: n.y, y: n.x, w: n.h, h: n.w })),
    edges: placed.edges.map((e) => ({ ...e, points: e.points.map((p) => ({ x: p.y, y: p.x })) })),
  };
}

/**
 * Cut a left to right layout into two rows, one under the other, so a long chain of ranks is not
 * squeezed into one thin strip. The ranks are split where the two rows come out equally long.
 * Edges inside a row keep their route; an edge between the rows goes down (or up) out of its
 * node, along the channel between the rows and into the other node. Returns null when there are
 * fewer than three ranks, or when an arrow between the rows would have to pass through a card.
 */
export function foldRows(placed: Placed): Placed | null {
  const ranks = new Map<number, number[]>();
  placed.nodes.forEach((n, i) => {
    const key = Math.round(n.x);
    ranks.set(key, [...(ranks.get(key) ?? []), i]);
  });
  const keys = [...ranks.keys()].sort((a, b) => a - b);
  if (keys.length < 3) return null;

  const extent = (members: readonly number[]) => {
    let left = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (const i of members) {
      const n = placed.nodes[i] as Rect;
      left = Math.min(left, n.x - n.w / 2);
      right = Math.max(right, n.x + n.w / 2);
      top = Math.min(top, n.y - n.h / 2 - ROW_TOP);
      bottom = Math.max(bottom, n.y + n.h / 2 + ROW_BOTTOM);
    }
    return { left, right, top, bottom };
  };
  const membersOf = (rankKeys: readonly number[]) => rankKeys.flatMap((k) => ranks.get(k) ?? []);

  let split = 1;
  let narrowest = Number.POSITIVE_INFINITY;
  for (let m = 1; m < keys.length; m++) {
    const a = extent(membersOf(keys.slice(0, m)));
    const b = extent(membersOf(keys.slice(m)));
    const longest = Math.max(a.right - a.left, b.right - b.left);
    if (longest < narrowest) {
      narrowest = longest;
      split = m;
    }
  }
  const firstRow = new Set(membersOf(keys.slice(0, split)));
  const a = extent([...firstRow]);
  const b = extent(membersOf(keys.slice(split)));

  const dx1 = LAYOUT_MARGIN - a.left;
  const dy1 = LAYOUT_MARGIN - a.top;
  const dx2 = LAYOUT_MARGIN - b.left;
  // The second row starts FOLD_GAP below the lowest edge of the first one.
  const dy2 = dy1 + a.bottom + FOLD_GAP - b.top;
  const rowOf = new Map<string, 1 | 2>();
  const nodes = placed.nodes.map((n, i) => {
    const row: 1 | 2 = firstRow.has(i) ? 1 : 2;
    rowOf.set(n.id, row);
    return { ...n, x: round1(n.x + (row === 1 ? dx1 : dx2)), y: round1(n.y + (row === 1 ? dy1 : dy2)) };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const channel = dy1 + a.bottom + FOLD_GAP / 2;

  const crossing = placed.edges.filter((e) => rowOf.get(e.from) !== rowOf.get(e.to));
  const edges = placed.edges.map((edge) => {
    const rowFrom = rowOf.get(edge.from) as 1 | 2;
    const rowTo = rowOf.get(edge.to) as 1 | 2;
    if (rowFrom === rowTo) {
      const dx = rowFrom === 1 ? dx1 : dx2;
      const dy = rowFrom === 1 ? dy1 : dy2;
      return { ...edge, points: edge.points.map((p) => ({ x: round1(p.x + dx), y: round1(p.y + dy) })) };
    }
    const from = byId.get(edge.from) as Rect;
    const to = byId.get(edge.to) as Rect;
    const k = crossing.indexOf(edge);
    const y = channel + (k - (crossing.length - 1) / 2) * CHANNEL_STEP;
    const down = rowFrom === 1;
    const out = down ? from.y + from.h / 2 : from.y - from.h / 2;
    const into = down ? to.y - to.h / 2 : to.y + to.h / 2;
    return {
      ...edge,
      points: [
        { x: round1(from.x), y: round1(out) },
        { x: round1(from.x), y: round1(y) },
        { x: round1(to.x), y: round1(y) },
        { x: round1(to.x), y: round1(into) },
      ],
    };
  });

  // A fold is only good when no arrow between the rows runs through a card on its way.
  for (const edge of edges) {
    if (rowOf.get(edge.from) === rowOf.get(edge.to)) continue;
    for (let i = 0; i + 1 < edge.points.length; i++) {
      const a = edge.points[i] as { x: number; y: number };
      const b = edge.points[i + 1] as { x: number; y: number };
      for (const n of nodes) {
        if (n.id === edge.from || n.id === edge.to) continue;
        if (segmentHitsRect(a, b, n, CLEARANCE)) return null;
      }
    }
  }

  const right = Math.max(...nodes.map((n) => n.x + n.w / 2));
  const bottom = Math.max(...nodes.map((n) => n.y + n.h / 2 + ROW_BOTTOM));
  return { width: Math.ceil(right + LAYOUT_MARGIN), height: Math.ceil(bottom + LAYOUT_MARGIN), nodes, edges };
}

/**
 * The layout in one piece, or in two rows (two columns for a top to bottom diagram) when it would
 * have to be drawn small and the two-row version can be drawn clearly larger.
 */
function foldIfSmall(direction: 'LR' | 'TB', placed: Placed): Placed {
  const scale = fitScale(placed.width, placed.height);
  if (scale >= FOLD_BELOW_SCALE || placed.nodes.length < 4) return placed;
  const horizontal = direction === 'LR';
  const folded = foldRows(horizontal ? placed : transpose(placed));
  if (!folded) return placed;
  const result = horizontal ? folded : transpose(folded);
  return fitScale(result.width, result.height) > scale * FOLD_GAIN ? result : placed;
}

/** Space between nodes of one rank, and between ranks, in layout pixels. */
const NODE_SEP = { LR: 88, TB: 80 } as const;
const RANK_SEP = { LR: 84, TB: 96 } as const;
/** The most extra space between nodes of one rank that is added to use a stage that is mostly empty. */
const MAX_EXTRA_NODE_SEP = 80;

interface PlaceOptions {
  direction: 'LR' | 'TB';
  maxNodeWidth: number;
  fonts: DiagramFonts;
  /** Extra space between nodes of one rank, on top of the usual. */
  extraNodeSep?: number;
}

/** One dagre run with fixed node widths and fonts. */
function place(
  nodes: Map<string, ArchitectureVisual['nodes'][number]>,
  edges: ArchitectureVisual['edges'],
  options: PlaceOptions,
): Placed {
  const { direction, maxNodeWidth, fonts } = options;
  const horizontal = direction === 'LR';
  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setGraph({
    rankdir: horizontal ? 'LR' : 'TB',
    nodesep: NODE_SEP[direction] + (options.extraNodeSep ?? 0),
    ranksep: RANK_SEP[direction],
    edgesep: 24,
    marginx: LAYOUT_MARGIN,
    marginy: LAYOUT_MARGIN,
    ranker: 'network-simplex',
  });
  graph.setDefaultEdgeLabel(() => ({}));

  for (const [id, node] of nodes) {
    const size = estimateNodeSize(node.label, node.detail, { maxWidth: maxNodeWidth, fonts });
    graph.setNode(id, { width: size.w, height: size.h });
  }
  edges.forEach((edge, index) => {
    const label = (edge.label ?? '').trim();
    const box = label ? edgeLabelSize(label, fonts, EDGE_WRAP[direction]) : null;
    // Keep a little room around the pill so arrows show on both sides of it.
    graph.setEdge(
      edge.from,
      edge.to,
      box ? { width: box.w + 28, height: box.h + 14, labelpos: 'c' } : {},
      String(index),
    );
  });

  dagre.layout(graph);
  const box = graph.graph();

  const placedNodes: ArchitectureResolved['nodes'] = [];
  for (const [id, node] of nodes) {
    const placed = graph.node(id);
    placedNodes.push({
      id,
      label: node.label,
      detail: node.detail,
      kind: node.kind,
      status: node.status,
      beat: node.beat,
      x: round1(placed.x),
      y: round1(placed.y),
      w: placed.width,
      h: placed.height,
    });
  }

  const byId = new Map(placedNodes.map((n) => [n.id, n]));
  const placedEdges: ArchitectureResolved['edges'] = edges.map((edge, index) => {
    const layoutEdge = graph.edge(edge.from, edge.to, String(index));
    let points = ((layoutEdge?.points ?? []) as Array<{ x: number; y: number }>).map((p) => ({
      x: round1(p.x),
      y: round1(p.y),
    }));
    if (points.length < 2) {
      // Fall back to a straight line between the node centres.
      const from = byId.get(edge.from)!;
      const to = byId.get(edge.to)!;
      points = [
        { x: from.x, y: from.y },
        { x: to.x, y: to.y },
      ];
    }
    return {
      from: edge.from,
      to: edge.to,
      label: edge.label,
      status: edge.status,
      beat: edge.beat,
      points,
    };
  });

  return foldIfSmall(direction, {
    width: Math.ceil(box.width ?? 0),
    height: Math.ceil(box.height ?? 0),
    nodes: placedNodes,
    edges: placedEdges,
  });
}

/** Widest a card may be, tried in order: roomy first, then narrower so more text wraps. */
const WIDTH_STEPS = [MAX_NODE_WIDTH, 400, 340] as const;
/** A diagram that needs a zoom below this is tried again with narrower cards. */
const COMFORTABLE_SCALE = 0.92;
/** Narrower cards are used when they allow a zoom this much larger. */
const NARROWER_CARDS_GAIN = 1.04;
const MAX_FONT_ROUNDS = 12;
/** The font rounds stop when the zoom changes by less than this. */
const SCALE_SETTLED = 0.004;
/** A diagram that still needs a zoom below this is also tried in the other direction. */
const TRY_OTHER_DIRECTION = 0.8;
/** The other direction is used when it allows a zoom this much larger. */
const OTHER_DIRECTION_GAIN = 1.12;

export interface ArchitectureLayout extends Placed {
  /** The direction the diagram was laid out in; the other one when that fits much better. */
  direction: 'LR' | 'TB';
}

interface Solved {
  placed: Placed;
  scale: number;
  options: PlaceOptions;
}

/**
 * Lay out in one direction. A diagram that would have to shrink on screen gets narrower cards (more
 * wrapping) and larger layout fonts, so text stays legible; the fonts and the zoom are settled
 * together, because larger fonts make the diagram larger.
 */
function solve(
  nodes: Map<string, ArchitectureVisual['nodes'][number]>,
  edges: ArchitectureVisual['edges'],
  direction: 'LR' | 'TB',
): Solved {
  let best: Solved | null = null;
  for (const maxNodeWidth of WIDTH_STEPS) {
    let options: PlaceOptions = { direction, maxNodeWidth, fonts: BASE_FONTS };
    let placed = place(nodes, edges, options);
    let scale = fitScale(placed.width, placed.height);
    for (let round = 0; round < MAX_FONT_ROUNDS && scale < 1; round++) {
      // Aim a little low: a slightly larger font than needed is safe, a smaller one would overflow.
      options = { direction, maxNodeWidth, fonts: fontsForScale(scale * 0.97) };
      placed = place(nodes, edges, options);
      const next = fitScale(placed.width, placed.height);
      const settled = Math.abs(next - scale) < SCALE_SETTLED;
      scale = next;
      if (settled) break;
    }
    // Narrower cards (more wrapping) are only worth it for a clear gain in size.
    if (!best || scale > best.scale * NARROWER_CARDS_GAIN) best = { placed, scale, options };
    if (scale >= COMFORTABLE_SCALE) break;
  }
  return best as Solved;
}

/**
 * Use free space on the stage: when the zoom is set by the length of the diagram, the nodes of a
 * rank are moved apart across it, so the diagram does not sit as a thin strip in a mostly empty frame.
 */
function spread(
  solved: Solved,
  nodes: Map<string, ArchitectureVisual['nodes'][number]>,
  edges: ArchitectureVisual['edges'],
): Solved {
  const { placed, scale, options } = solved;
  const horizontal = options.direction === 'LR';
  const area = horizontal ? DIAGRAM_AREA.h : DIAGRAM_AREA.w;
  const used = horizontal ? placed.height : placed.width;
  const slack = (area - 2 * DIAGRAM_AREA.margin) / scale - used;
  const ranks = new Map<number, number>();
  for (const node of placed.nodes) {
    const key = Math.round(horizontal ? node.x : node.y);
    ranks.set(key, (ranks.get(key) ?? 0) + 1);
  }
  const widest = Math.max(1, ...ranks.values());
  if (widest < 2 || slack < 60) return solved;
  const extra = Math.min(MAX_EXTRA_NODE_SEP, (slack * 0.35) / (widest - 1));
  const spreadOptions = { ...options, extraNodeSep: Math.round(extra) };
  const wider = place(nodes, edges, spreadOptions);
  const next = fitScale(wider.width, wider.height);
  return next >= scale - 0.002 ? { placed: wider, scale: next, options: spreadOptions } : solved;
}

/**
 * Lay out an architecture diagram. Cards are sized from their text and the whole diagram is zoomed
 * to the stage (see solve). A diagram that stays too small in the direction it was drawn in is also
 * tried the other way round and turned when that is clearly better. Edges that name an unknown node
 * are dropped and repeated node ids keep their first definition, so a slightly wrong storyboard
 * still draws.
 */
export function layoutArchitecture(visual: ArchitectureVisual): ArchitectureLayout {
  const direction = visual.direction === 'TB' ? 'TB' : 'LR';
  const nodes = new Map<string, ArchitectureVisual['nodes'][number]>();
  for (const node of visual.nodes) if (!nodes.has(node.id)) nodes.set(node.id, node);
  const edges: ArchitectureVisual['edges'] = visual.edges.filter(
    (edge) => nodes.has(edge.from) && nodes.has(edge.to),
  );

  let best = solve(nodes, edges, direction);
  if (best.scale < TRY_OTHER_DIRECTION && nodes.size > 1) {
    const other = solve(nodes, edges, direction === 'LR' ? 'TB' : 'LR');
    if (other.scale > best.scale * OTHER_DIRECTION_GAIN) best = other;
  }
  best = spread(best, nodes, edges);
  return { ...best.placed, direction: best.options.direction };
}
