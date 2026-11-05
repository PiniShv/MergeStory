/** Architecture diagram: node cards pop in on their beats, edges draw in, new edges carry data packets. */
import {
  DETAIL_LINE_HEIGHT,
  DIAGRAM_AREA,
  EDGE_LABEL_MAX,
  EDGE_LINE_HEIGHT,
  EDGE_PILL_PAD_EM,
  EDGE_PILL_VPAD_EM,
  EDGE_WRAP,
  fitScale,
  fontsForScale,
  LABEL_LINE_HEIGHT,
  LABEL_SPACING_EM,
  NODE_ICON,
  NODE_ICON_GAP,
  NODE_PAD_LEFT,
  NODE_PAD_RIGHT,
  NODE_PAD_Y,
  NODE_TEXT_GAP,
} from '../../core/diagram-metrics.ts';
import type { ArchitectureResolved } from '../../core/render-plan.ts';
import { clamp01, ease, enter, lerp, q } from '../anim.ts';
import { css, h, s } from '../dom.ts';
import { icon } from '../icons.ts';
import { pop } from '../motion.ts';
import type { TemplateFactory } from '../types.ts';

const CORNER_RADIUS = 20;
const ARROW_LEN = 18;
/** How long new edges carry packets after they have drawn in. */
const PACKET_SECONDS = 3.6;
const PACKET_PERIOD = 1.2;
const DRAW_SECONDS = 0.7;

export interface PathPoint {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface RoundedPath {
  /** SVG path data. */
  d: string;
  length: number;
  /** Point and heading (radians) at a distance along the path. */
  at(distance: number): { x: number; y: number; angle: number };
}

interface Piece {
  curve: boolean;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  cx: number;
  cy: number;
  len: number;
  /** Cumulative length at CURVE_STEPS + 1 samples (curves only). */
  cum: number[];
}

const CURVE_STEPS = 16;
const num = (v: number) => String(Math.round(v * 100) / 100);

function quad(p: Piece, t: number): { x: number; y: number } {
  const u = 1 - t;
  return {
    x: u * u * p.ax + 2 * u * t * p.cx + t * t * p.bx,
    y: u * u * p.ay + 2 * u * t * p.cy + t * t * p.by,
  };
}

/** A polyline with rounded corners, plus exact positions along it (for packets and arrowheads). */
export function roundedPath(input: readonly PathPoint[], radius = CORNER_RADIUS): RoundedPath {
  const pts: PathPoint[] = [];
  for (const p of input) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 0.01) pts.push(p);
  }
  const first = pts[0];
  if (!first || pts.length < 2) {
    const p = first ?? { x: 0, y: 0 };
    return { d: `M${num(p.x)} ${num(p.y)}`, length: 0, at: () => ({ x: p.x, y: p.y, angle: 0 }) };
  }

  const pieces: Piece[] = [];
  const cmds = [`M${num(first.x)} ${num(first.y)}`];
  let cursor = first;
  const line = (to: PathPoint) => {
    const len = Math.hypot(to.x - cursor.x, to.y - cursor.y);
    if (len > 0.001) {
      pieces.push({
        curve: false,
        ax: cursor.x,
        ay: cursor.y,
        bx: to.x,
        by: to.y,
        cx: 0,
        cy: 0,
        len,
        cum: [],
      });
      cmds.push(`L${num(to.x)} ${num(to.y)}`);
    }
    cursor = to;
  };
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1] as PathPoint;
    const cur = pts[i] as PathPoint;
    const next = pts[i + 1] as PathPoint;
    const lin = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const lout = Math.hypot(next.x - cur.x, next.y - cur.y);
    const ux = (cur.x - prev.x) / lin;
    const uy = (cur.y - prev.y) / lin;
    const vx = (next.x - cur.x) / lout;
    const vy = (next.y - cur.y) / lout;
    const r = Math.min(radius, lin / 2, lout / 2);
    const straight = Math.abs(ux * vy - uy * vx) < 1e-3 && ux * vx + uy * vy > 0;
    if (straight || r < 0.5) {
      line(cur);
      continue;
    }
    const a = { x: cur.x - ux * r, y: cur.y - uy * r };
    const b = { x: cur.x + vx * r, y: cur.y + vy * r };
    line(a);
    const piece: Piece = {
      curve: true,
      ax: a.x,
      ay: a.y,
      bx: b.x,
      by: b.y,
      cx: cur.x,
      cy: cur.y,
      len: 0,
      cum: [0],
    };
    let prevPoint = { x: a.x, y: a.y };
    for (let k = 1; k <= CURVE_STEPS; k++) {
      const p = quad(piece, k / CURVE_STEPS);
      piece.len += Math.hypot(p.x - prevPoint.x, p.y - prevPoint.y);
      piece.cum.push(piece.len);
      prevPoint = p;
    }
    pieces.push(piece);
    cmds.push(`Q${num(cur.x)} ${num(cur.y)} ${num(b.x)} ${num(b.y)}`);
    cursor = b;
  }
  line(pts[pts.length - 1] as PathPoint);

  const length = pieces.reduce((sum, p) => sum + p.len, 0);
  const at = (distance: number) => {
    let rest = Math.max(0, Math.min(length, distance));
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i] as Piece;
      if (rest > p.len && i < pieces.length - 1) {
        rest -= p.len;
        continue;
      }
      const local = Math.min(rest, p.len);
      if (!p.curve) {
        const t = p.len === 0 ? 0 : local / p.len;
        return {
          x: lerp(p.ax, p.bx, t),
          y: lerp(p.ay, p.by, t),
          angle: Math.atan2(p.by - p.ay, p.bx - p.ax),
        };
      }
      let k = 0;
      while (k < CURVE_STEPS - 1 && (p.cum[k + 1] as number) < local) k++;
      const lo = p.cum[k] as number;
      const hi = p.cum[k + 1] as number;
      const t = (k + (hi > lo ? (local - lo) / (hi - lo) : 0)) / CURVE_STEPS;
      const point = quad(p, t);
      const tx = 2 * (1 - t) * (p.cx - p.ax) + 2 * t * (p.bx - p.cx);
      const ty = 2 * (1 - t) * (p.cy - p.ay) + 2 * t * (p.by - p.cy);
      return { x: point.x, y: point.y, angle: Math.atan2(ty, tx) };
    }
    return { x: first.x, y: first.y, angle: 0 };
  };
  return { d: cmds.join(''), length, at };
}

/**
 * If `inside` lies within `rect`, move it along the segment towards `toward` until it leaves the
 * rectangle. Lets edges that start at a node's centre end on the node's border instead.
 */
export function clipToRect(inside: PathPoint, toward: PathPoint, rect: Rect): PathPoint {
  const within =
    inside.x > rect.x && inside.x < rect.x + rect.w && inside.y > rect.y && inside.y < rect.y + rect.h;
  if (!within) return inside;
  const dx = toward.x - inside.x;
  const dy = toward.y - inside.y;
  let t = Number.POSITIVE_INFINITY;
  if (dx > 0) t = Math.min(t, (rect.x + rect.w - inside.x) / dx);
  else if (dx < 0) t = Math.min(t, (rect.x - inside.x) / dx);
  if (dy > 0) t = Math.min(t, (rect.y + rect.h - inside.y) / dy);
  else if (dy < 0) t = Math.min(t, (rect.y - inside.y) / dy);
  if (!(t > 0) || t >= 1) return inside;
  return { x: inside.x + dx * t, y: inside.y + dy * t };
}

/** Move the last point back along its segment, so a line ends inside its arrowhead. */
export function trimEnd(points: readonly PathPoint[], amount: number): PathPoint[] {
  const out = points.slice();
  const end = out[out.length - 1];
  const before = out[out.length - 2];
  if (!end || !before) return out;
  const len = Math.hypot(end.x - before.x, end.y - before.y);
  if (len <= amount + 2) return out;
  out[out.length - 1] = {
    x: end.x - ((end.x - before.x) / len) * amount,
    y: end.y - ((end.y - before.y) / len) * amount,
  };
  return out;
}

/** The area a diagram occupies: the declared layout box grown to include every node and edge point. */
export function layoutBounds(
  visual: Pick<ArchitectureResolved, 'width' | 'height' | 'nodes' | 'edges'>,
): Bounds {
  const b: Bounds = { minX: 0, minY: 0, maxX: Math.max(1, visual.width), maxY: Math.max(1, visual.height) };
  for (const n of visual.nodes) {
    b.minX = Math.min(b.minX, n.x - n.w / 2);
    b.minY = Math.min(b.minY, n.y - n.h / 2);
    b.maxX = Math.max(b.maxX, n.x + n.w / 2);
    b.maxY = Math.max(b.maxY, n.y + n.h / 2);
  }
  for (const e of visual.edges) {
    for (const p of e.points) {
      b.minX = Math.min(b.minX, p.x);
      b.minY = Math.min(b.minY, p.y);
      b.maxX = Math.max(b.maxX, p.x);
      b.maxY = Math.max(b.maxY, p.y);
    }
  }
  return b;
}

/** Scale (never above `maxScale`) and offset that centre `bounds` inside the area, minus a margin. */
export function fitLayout(
  bounds: Bounds,
  area: { w: number; h: number },
  margin = DIAGRAM_AREA.margin,
  maxScale = DIAGRAM_AREA.maxScale,
): { scale: number; x: number; y: number } {
  const w = Math.max(1, bounds.maxX - bounds.minX);
  const hh = Math.max(1, bounds.maxY - bounds.minY);
  const scale = fitScale(w, hh, { ...area, margin, maxScale });
  return {
    scale,
    x: (area.w - w * scale) / 2 - bounds.minX * scale,
    y: (area.h - hh * scale) / 2 - bounds.minY * scale,
  };
}

export interface NodeTextPlan {
  labelFont: number;
  detailFont: number;
  /** Upper limits for the number of lines; the text may use fewer. */
  labelLines: 1 | 2;
  detailLines: 1 | 2;
  showDetail: boolean;
  showIcon: boolean;
}

/**
 * Font sizes and limits for the text inside a node card. The layout sized the card for this text,
 * so normally everything is shown in full. Only a card that is too small for its text (a diagram
 * scaled far down) gives up lines, then the detail, rather than overflow.
 */
export function planNodeText(
  node: { w: number; h: number },
  scale: number,
  hasDetail: boolean,
): NodeTextPlan {
  const fonts = fontsForScale(scale);
  let labelLines: 1 | 2 = 2;
  let detailLines: 1 | 2 = 2;
  let showDetail = hasDetail;
  let labelFont = fonts.label;
  const room = node.h - 2 * NODE_PAD_Y;
  const used = () =>
    labelLines * labelFont * LABEL_LINE_HEIGHT +
    (showDetail ? NODE_TEXT_GAP + detailLines * fonts.detail * DETAIL_LINE_HEIGHT : 0);
  if (used() > room) detailLines = 1;
  if (used() > room) labelLines = 1;
  if (used() > room) showDetail = false;
  if (used() > room) labelFont = Math.max(14, room / LABEL_LINE_HEIGHT);
  return {
    labelFont,
    detailFont: fonts.detail,
    labelLines,
    detailLines,
    showDetail,
    showIcon: (node.w - 110) * scale >= 150,
  };
}

const STATUS_LABEL: Record<ArchitectureResolved['nodes'][number]['status'], string | null> = {
  added: 'NEW',
  modified: 'CHANGED',
  removed: 'REMOVED',
  unchanged: null,
};

const ARCH_CSS = `
.ms-arch__layer { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.ms-arch__edges { position: absolute; left: 0; top: 0; overflow: visible; }
.ms-arch__line { fill: none; stroke-linecap: butt; stroke-linejoin: round; }
.ms-arch__line--unchanged { stroke: var(--text-3); stroke-width: 3; stroke-dasharray: 1; }
.ms-arch__line--added { stroke: var(--accent); stroke-width: 4; stroke-dasharray: 1; }
.ms-arch__line--removed { stroke: var(--del); stroke-width: 3; stroke-dasharray: 11 9; }
.ms-arch__head--unchanged { fill: var(--text-3); }
.ms-arch__head--added { fill: var(--accent); }
.ms-arch__head--removed { fill: var(--del); }
.ms-arch__packet-core { fill: var(--accent-2); }
.ms-arch__packet-halo { fill: var(--accent-2); opacity: 0.28; }
.ms-arch__elabel {
  position: absolute;
  left: 0;
  top: 0;
  box-sizing: border-box;
  width: max-content;
  max-width: var(--ar-ewrap);
  padding: ${EDGE_PILL_VPAD_EM}em ${EDGE_PILL_PAD_EM}em;
  border-radius: 0.85em;
  font-size: var(--ar-edge);
  font-weight: 600;
  line-height: ${EDGE_LINE_HEIGHT};
  text-align: center;
  color: var(--text-2);
  background: var(--surface-2);
  box-shadow: 0 0 0 1px var(--border-2);
}
.ms-arch__elabel span {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.ms-arch__elabel--added { color: var(--accent); box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 55%, transparent); }
.ms-arch__elabel--removed { color: var(--del); box-shadow: 0 0 0 1px color-mix(in srgb, var(--del) 55%, transparent); }

.ms-arch__node { position: absolute; }
.ms-arch__glow {
  position: absolute;
  inset: 0;
  border-radius: 24px;
  box-shadow: 0 0 46px color-mix(in srgb, var(--status) 42%, transparent);
}
.ms-arch__card {
  position: relative;
  display: flex;
  align-items: center;
  gap: ${NODE_ICON_GAP}px;
  width: 100%;
  height: 100%;
  padding: 0 ${NODE_PAD_RIGHT}px 0 ${NODE_PAD_LEFT}px;
  border-radius: 24px;
  background: var(--surface-2);
  box-shadow: var(--shadow-lift), 0 0 0 2px color-mix(in srgb, var(--status) 70%, transparent);
}
.ms-arch__node--unchanged .ms-arch__card { box-shadow: var(--shadow-lift), 0 0 0 1.5px var(--border-2); opacity: 0.84; }
.ms-arch__node--removed .ms-arch__card { box-shadow: var(--shadow-lift); border: 2.5px dashed var(--status); }
.ms-arch__icon {
  display: grid;
  place-items: center;
  flex: none;
  width: ${NODE_ICON}px;
  height: ${NODE_ICON}px;
  border-radius: 15px;
  color: var(--status);
  background: var(--status-soft);
}
.ms-arch__node--unchanged .ms-arch__icon { color: var(--text-2); }
.ms-arch__text { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: ${NODE_TEXT_GAP}px; }
.ms-arch__label {
  font-size: var(--nl, var(--ar-label));
  font-weight: 700;
  letter-spacing: ${LABEL_SPACING_EM}em;
  line-height: ${LABEL_LINE_HEIGHT};
  color: var(--text-0);
  overflow: hidden;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: var(--lines, 2);
}
.ms-arch__node--removed .ms-arch__label { color: var(--text-2); text-decoration: line-through; text-decoration-thickness: 2px; }
.ms-arch__detail {
  font-size: var(--nd, var(--ar-detail));
  font-weight: 500;
  line-height: ${DETAIL_LINE_HEIGHT};
  color: var(--text-2);
  overflow: hidden;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: var(--dlines, 2);
}
.ms-arch__pill {
  position: absolute;
  top: -24px;
  right: 20px;
  display: inline-flex;
  align-items: center;
  height: 36px;
  padding: 0 15px;
  border-radius: var(--radius-pill);
  font-size: var(--ar-pill);
  font-weight: 800;
  letter-spacing: 0.08em;
  line-height: 1;
  color: #071022;
  background: var(--status);
  box-shadow: 0 8px 20px -8px color-mix(in srgb, var(--status) 80%, transparent);
}
:root[data-theme='light'] .ms-arch__pill { color: #fff; }
`;

type Node = ArchitectureResolved['nodes'][number];
type Edge = ArchitectureResolved['edges'][number];

export const architectureTemplate: TemplateFactory<ArchitectureResolved> = (visual, ctx) => {
  css('architecture', ARCH_CSS);
  const { sw } = ctx;
  const bounds = layoutBounds(visual);
  const fit = fitLayout(bounds, DIAGRAM_AREA);
  const { scale } = fit;
  const boxW = bounds.maxX - bounds.minX;
  const boxH = bounds.maxY - bounds.minY;
  // Text stays at 22 px or more on screen even when the layout is scaled down.
  const fonts = fontsForScale(scale);
  const direction = visual.direction === 'TB' ? 'TB' : 'LR';
  const layer = h('div', {
    class: 'ms-arch__layer',
    style: {
      width: `${boxW}px`,
      height: `${boxH}px`,
      transform: `translate(${q(fit.x, 2)}px, ${q(fit.y, 2)}px) scale(${q(scale, 4)})`,
      '--ar-label': `${q(fonts.label, 2)}px`,
      '--ar-detail': `${q(fonts.detail, 2)}px`,
      '--ar-pill': `${q(fonts.detail, 2)}px`,
      '--ar-edge': `${q(fonts.edge, 2)}px`,
      '--ar-ewrap': `${EDGE_WRAP[direction]}px`,
    },
  });
  const root = h('div', { class: 'ms-content ms-arch' }, layer);
  const shift = (p: PathPoint): PathPoint => ({ x: p.x - bounds.minX, y: p.y - bounds.minY });

  const svg = s('svg', {
    class: 'ms-arch__edges',
    width: boxW,
    height: boxH,
    viewBox: `0 0 ${boxW} ${boxH}`,
  });
  layer.append(svg);

  // Nodes.
  const rects = new Map<string, Rect>();
  const nodeStart = new Map<string, number>();
  const nodes = ctx.withStarts(visual.nodes, 0.12).map((node: Node & { start: number }) => {
    const rect = {
      x: node.x - node.w / 2 - bounds.minX,
      y: node.y - node.h / 2 - bounds.minY,
      w: node.w,
      h: node.h,
    };
    rects.set(node.id, rect);
    nodeStart.set(node.id, node.start);
    const pillText = STATUS_LABEL[node.status];
    const text = planNodeText(node, scale, Boolean(node.detail));
    const labelEl = h('div', { class: 'ms-arch__label', text: node.label });
    const detailEl =
      node.detail && text.showDetail ? h('div', { class: 'ms-arch__detail', text: node.detail }) : null;
    const textBox = h('div', { class: 'ms-arch__text' }, labelEl, detailEl);
    const card = h(
      'div',
      { class: 'ms-arch__card' },
      text.showIcon ? h('div', { class: 'ms-arch__icon' }, icon(node.kind, { size: 30, stroke: 1.8 })) : null,
      textBox,
    );
    const glow = node.status === 'unchanged' ? null : h('div', { class: 'ms-arch__glow' });
    const el = h(
      'div',
      {
        class: `ms-arch__node ms-arch__node--${node.status} ms-status-${node.status}`,
        style: {
          left: `${rect.x}px`,
          top: `${rect.y}px`,
          width: `${rect.w}px`,
          height: `${rect.h}px`,
          '--nl': `${q(text.labelFont, 2)}px`,
          '--nd': `${q(text.detailFont, 2)}px`,
          '--lines': String(text.labelLines),
          '--dlines': String(text.detailLines),
        },
      },
      glow,
      card,
      pillText ? h('div', { class: 'ms-arch__pill', text: pillText }) : null,
    );
    layer.append(el);
    return { el, glow, card, textBox, labelEl, detailEl, plan: text, start: node.start };
  });

  // Edges.
  const edges = ctx.withStarts(visual.edges, 0.15).flatMap((edge: Edge & { start: number }) => {
    const fromRect = rects.get(edge.from);
    const toRect = rects.get(edge.to);
    if (!fromRect || !toRect) return [];
    let points = edge.points.map(shift);
    if (points.length < 2) {
      points = [
        { x: fromRect.x + fromRect.w / 2, y: fromRect.y + fromRect.h / 2 },
        { x: toRect.x + toRect.w / 2, y: toRect.y + toRect.h / 2 },
      ];
    }
    points[0] = clipToRect(points[0] as PathPoint, points[1] as PathPoint, fromRect);
    const last = points.length - 1;
    points[last] = clipToRect(points[last] as PathPoint, points[last - 1] as PathPoint, toRect);

    const full = roundedPath(points);
    const drawn = roundedPath(trimEnd(points, ARROW_LEN - 6));
    const tip = full.at(full.length);
    const start = Math.max(
      edge.start,
      (nodeStart.get(edge.from) ?? 0) + 0.35,
      (nodeStart.get(edge.to) ?? 0) + 0.35,
    );

    const path = s('path', { class: `ms-arch__line ms-arch__line--${edge.status}`, d: drawn.d });
    if (edge.status !== 'removed') path.setAttribute('pathLength', '1');
    const head = s('path', {
      class: `ms-arch__head--${edge.status}`,
      d: `M0 0L${-ARROW_LEN} -9.5L${-ARROW_LEN} 9.5Z`,
      transform: `translate(${num(tip.x)} ${num(tip.y)}) rotate(${num((tip.angle * 180) / Math.PI)})`,
    });
    svg.append(path, head);

    const packets =
      edge.status === 'added' && full.length > 40
        ? [0, 0.5].map((phase) => {
            const g = s(
              'g',
              {},
              s('circle', { class: 'ms-arch__packet-halo', r: 15 }),
              s('circle', { class: 'ms-arch__packet-core', r: 7 }),
            );
            svg.append(g);
            return { g, phase };
          })
        : [];

    let label: HTMLElement | null = null;
    const labelText = (edge.label ?? '').trim();
    if (labelText !== '' && full.length > 0) {
      const mid = full.at(full.length / 2);
      label = h(
        'div',
        { class: `ms-arch__elabel ms-arch__elabel--${edge.status}` },
        h('span', { text: labelText }),
      );
      label.style.left = `${q(mid.x, 1)}px`;
      label.style.top = `${q(mid.y, 1)}px`;
      layer.append(label);
    }
    return [{ edge, path, head, packets, label, full, start }];
  });

  return {
    root,
    /**
     * Check the text of every card once, with the real font. The layout sized each card for its text,
     * so this only catches a few pixels of difference: smaller type first (never below 24 px for
     * names and 22 px for details on screen), then a one-line detail. Cutting text is the last step.
     */
    layout() {
      for (const n of nodes) fitNodeText(n, scale);
      for (const e of edges) if (e.label) fitEdgeLabel(e.label, EDGE_WRAP[direction]);
    },
    update(t) {
      for (const n of nodes) {
        pop(sw, n.el, enter(t, n.start, 0.6, ease.linear), 0.88);
        if (n.glow) sw.opacity(n.glow, lerp(1, 0.55, enter(t, n.start + 0.35, 0.9)));
      }
      for (const e of edges) {
        const p = enter(t, e.start, DRAW_SECONDS, ease.inOutCubic);
        if (e.edge.status === 'removed') {
          const f = enter(t, e.start, 0.5);
          sw.opacity(e.path, f);
          sw.opacity(e.head, f);
        } else {
          sw.opacity(e.path, p > 0 ? 1 : 0);
          sw.style(e.path, 'stroke-dashoffset', String(q(1 - p, 4)));
          sw.opacity(e.head, clamp01((p - 0.8) / 0.2));
        }
        if (e.label) {
          const f = enter(t, e.start + 0.35, 0.45);
          sw.opacity(e.label, f);
          sw.transform(e.label, `translate(-50%, -50%) translate(0px, ${q((1 - f) * 8, 2)}px)`);
        }
        // Packets travel only for a few seconds after the edge has drawn in.
        const since = t - (e.start + DRAW_SECONDS);
        for (const packet of e.packets) {
          if (since < 0 || since > PACKET_SECONDS) {
            sw.opacity(packet.g, 0);
            continue;
          }
          const x = (((since / PACKET_PERIOD + packet.phase) % 1) + 1) % 1;
          const pos = e.full.at(x * e.full.length);
          const fade = Math.min(1, x / 0.12, (1 - x) / 0.12);
          sw.attr(packet.g, 'transform', `translate(${q(pos.x, 1)} ${q(pos.y, 1)})`);
          sw.opacity(packet.g, clamp01(fade) * clamp01(1 - (since - (PACKET_SECONDS - 0.5)) / 0.5));
        }
      }
    },
  };
};

interface NodeParts {
  el: HTMLElement;
  card: HTMLElement;
  textBox: HTMLElement;
  labelEl: HTMLElement;
  detailEl: HTMLElement | null;
  plan: NodeTextPlan;
}

/**
 * Widen an edge label pill, a little at a time, until its text fits in two lines. The layout reserved
 * the same room from its own measure of the text; this uses the real font.
 */
function fitEdgeLabel(pill: HTMLElement, wrapAt: number): void {
  const span = pill.firstElementChild as HTMLElement | null;
  if (!span) return;
  const cut = () => span.scrollHeight > span.clientHeight + 1;
  let width = wrapAt;
  pill.style.maxWidth = `${width}px`;
  while (cut() && width < EDGE_LABEL_MAX) {
    width = Math.min(EDGE_LABEL_MAX, width + 6);
    pill.style.maxWidth = `${width}px`;
  }
}

/** Shrink the type of one card until its text fits, giving up lines only when it cannot. */
function fitNodeText(n: NodeParts, scale: number): void {
  const cut = (el: HTMLElement | null) => el !== null && el.scrollHeight > el.clientHeight + 1;
  const clipped = () =>
    cut(n.labelEl) || cut(n.detailEl) || n.textBox.offsetHeight > n.card.clientHeight - 12;
  if (!clipped()) return;
  const labelFloor = Math.min(n.plan.labelFont, 24 / scale);
  const detailFloor = Math.min(n.plan.detailFont, 22 / scale);
  let label = n.plan.labelFont;
  let detail = n.plan.detailFont;
  while (clipped() && (label > labelFloor || detail > detailFloor)) {
    label = Math.max(labelFloor, label - 1);
    detail = Math.max(detailFloor, detail - 1);
    n.el.style.setProperty('--nl', `${q(label, 2)}px`);
    n.el.style.setProperty('--nd', `${q(detail, 2)}px`);
  }
  if (clipped()) n.el.style.setProperty('--dlines', '1');
}
