/**
 * Sizes that the architecture diagram layout (in Node, visuals/layout.ts) and the diagram template
 * (in the browser, runtime/templates/architecture.ts) must agree on: the area the diagram is zoomed
 * into, the fonts and how they grow, the card paddings and the edge label limits. Both sides import
 * them from here, so a card is sized for exactly the text and the zoom the browser draws.
 */
import { CONTENT_H, CONTENT_W } from './render-plan.ts';

/** The area of the content frame in layout pixels, its margin and the largest zoom the template applies. */
export interface DiagramArea {
  w: number;
  h: number;
  margin: number;
  maxScale: number;
}

export const DIAGRAM_AREA: DiagramArea = { w: CONTENT_W, h: CONTENT_H, margin: 20, maxScale: 1.3 };

/**
 * The zoom that fits a layout of this size into the area (never above the largest allowed). The
 * layout sizes its cards for this zoom and the template applies it.
 */
export function fitScale(width: number, height: number, area: DiagramArea = DIAGRAM_AREA): number {
  const { w, h, margin, maxScale } = area;
  return Math.min((w - 2 * margin) / Math.max(1, width), (h - 2 * margin) / Math.max(1, height), maxScale);
}

export interface DiagramFonts {
  label: number;
  detail: number;
  edge: number;
}

/** Design font sizes in layout pixels. The template scales the whole layer, so on screen they are larger. */
export const LABEL_FONT = 30;
export const DETAIL_FONT = 22;
export const EDGE_FONT = 22;
export const BASE_FONTS: DiagramFonts = { label: LABEL_FONT, detail: DETAIL_FONT, edge: EDGE_FONT };
/** Smallest size on screen for node labels and for secondary text, in px. */
export const MIN_LABEL_SCREEN = 26;
export const MIN_SECONDARY_SCREEN = 22;
/** Below this zoom the fonts stop growing: a diagram that crowded cannot be made legible by boosting them. */
export const MIN_BOOST_SCALE = 0.6;

/**
 * Font sizes in layout pixels for a diagram drawn at `scale`. At a scale of 1 or more they are the
 * design sizes (which then grow with the scale); a diagram that has to shrink gets larger layout
 * fonts, so the text stays at or above 26 px (labels) and 22 px (everything else) on screen, down to
 * a zoom of 0.6.
 */
export function fontsForScale(scale: number): DiagramFonts {
  const s = Math.min(1, Math.max(MIN_BOOST_SCALE, scale));
  return {
    label: Math.max(LABEL_FONT, MIN_LABEL_SCREEN / s),
    detail: Math.max(DETAIL_FONT, MIN_SECONDARY_SCREEN / s),
    edge: Math.max(EDGE_FONT, MIN_SECONDARY_SCREEN / s),
  };
}

/** Letter spacing of the node label in em, and the line heights of label and detail. */
export const LABEL_SPACING_EM = -0.015;
export const LABEL_LINE_HEIGHT = 1.15;
export const DETAIL_LINE_HEIGHT = 1.2;

/** Space inside a node card that is not text: padding, icon and the gap after it, in px. */
export const NODE_ICON = 52;
export const NODE_ICON_GAP = 16;
export const NODE_PAD_LEFT = 18;
export const NODE_PAD_RIGHT = 22;
export const NODE_CHROME = NODE_PAD_LEFT + NODE_ICON + NODE_ICON_GAP + NODE_PAD_RIGHT;
/** Padding above and below the text of a card, and the gap between label and detail, in px. */
export const NODE_PAD_Y = 22;
export const NODE_TEXT_GAP = 6;

/** Widest an edge label gets before it wraps, per direction, in layout pixels. */
export const EDGE_WRAP: Record<'LR' | 'TB', number> = { LR: 250, TB: 420 };
/** Widest an edge label pill may become before its text is cut, in layout pixels. */
export const EDGE_LABEL_MAX = 420;
/** An edge label pill: padding in em of the edge font, text line height and the height of a one line pill. */
export const EDGE_PILL_PAD_EM = 0.7;
export const EDGE_PILL_VPAD_EM = 0.25;
export const EDGE_LINE_HEIGHT = 1.2;
export const EDGE_PILL_HEIGHT_EM = 2 * EDGE_PILL_VPAD_EM + EDGE_LINE_HEIGHT;
