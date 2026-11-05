/**
 * Simple stroke icons on a 24 x 24 grid, stored as SVG path data.
 *
 * Icons are drawn with `currentColor`, so CSS `color` styles them. Zero-length segments
 * such as "M7 7h.01" draw as dots because the stroke has round caps.
 */
import { s } from './dom.ts';

export interface IconDef {
  /** Path data, one string per path. */
  readonly paths: readonly string[];
  /** Filled shape instead of an outline (the pointer glyph). */
  readonly filled?: boolean;
}

export const ICONS = {
  // One per architecture / flow node kind.
  service: {
    paths: [
      'M5 4h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
      'M5 13h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2z',
      'M7 7.5h.01',
      'M7 16.5h.01',
      'M11 7.5h6',
      'M11 16.5h6',
    ],
  },
  module: {
    paths: ['M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z', 'M4 7.5l8 4.5 8-4.5', 'M12 12v9'],
  },
  ui: {
    paths: [
      'M5 4.5h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2z',
      'M3 9h18',
      'M6.5 6.75h.01',
      'M9.5 6.75h.01',
      'M7 13h5',
      'M7 16h9',
    ],
  },
  api: {
    paths: [
      'M9 4C7 4 6 5 6 7v2c0 1.5-.8 3-2 3 1.2 0 2 1.5 2 3v2c0 2 1 3 3 3',
      'M15 4c2 0 3 1 3 3v2c0 1.5.8 3 2 3-1.2 0-2 1.5-2 3v2c0 2-1 3-3 3',
      'M12 9.5v5',
      'M9.8 12h4.4',
    ],
  },
  database: {
    paths: [
      'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z',
      'M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6',
      'M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
    ],
  },
  queue: {
    paths: ['M3 8h5v8H3z', 'M10 8h5v8h-5z', 'M17 12h4', 'M19 9.5l2.5 2.5-2.5 2.5'],
  },
  external: {
    paths: ['M10 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-4', 'M14 4h6v6', 'M20 4l-9 9'],
  },
  file: {
    paths: [
      'M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
      'M14 3v5h5',
      'M9 13h6',
      'M9 17h4',
    ],
  },
  test: {
    paths: ['M9 3h6', 'M10 3v6L4.6 18.2A1.6 1.6 0 0 0 6 21h12a1.6 1.6 0 0 0 1.4-2.8L14 9V3', 'M7.6 15h8.8'],
  },
  config: {
    paths: [
      'M4 6h8',
      'M18 6h2',
      'M12 6a3 3 0 1 0 6 0 3 3 0 1 0-6 0',
      'M4 12h2',
      'M12 12h8',
      'M6 12a3 3 0 1 0 6 0 3 3 0 1 0-6 0',
      'M4 18h9',
      'M19 18h1',
      'M13 18a3 3 0 1 0 6 0 3 3 0 1 0-6 0',
    ],
  },
  user: {
    paths: ['M8 8a4 4 0 1 0 8 0 4 4 0 1 0-8 0', 'M4 20c0-4 3.6-6 8-6s8 2 8 6'],
  },
  cli: {
    paths: [
      'M5 4.5h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2z',
      'M7 9.5l3 2.5-3 2.5',
      'M12.5 15h4.5',
    ],
  },

  // Interface glyphs.
  lock: {
    paths: [
      'M6 11h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z',
      'M8 11V8a4 4 0 0 1 8 0v3',
      'M12 14.5v2',
    ],
  },
  chevron: { paths: ['M9 5l7 7-7 7'] },
  arrow: { paths: ['M4 12h16', 'M14 6l6 6-6 6'] },
  back: { paths: ['M19 12H5', 'M11 6l-6 6 6 6'] },
  reload: { paths: ['M20 12a8 8 0 1 1-2.5-5.8', 'M20 4v4.5h-4.5'] },
  check: { paths: ['M5 12.5l4.5 4.5L19 7.5'] },
  plus: { paths: ['M12 5v14', 'M5 12h14'] },
  image: {
    paths: [
      'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
      'M8.5 10.5a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0',
      'M3 17l5-5 4 4 3-3 6 6',
    ],
  },
  cursor: { paths: ['M5 3v16.5l4.2-4 2.9 6.2 3-1.4-2.9-6.1H19L5 3z'], filled: true },
} as const satisfies Record<string, IconDef>;

export type IconName = keyof typeof ICONS;

export interface IconOptions {
  /** Rendered size in px (square). Default 24. */
  size?: number;
  /** Stroke width in grid units. Default 1.75. */
  stroke?: number;
  class?: string;
}

/** Build an inline SVG for an icon. The caller sets `color` in CSS. */
export function icon(name: IconName, options: IconOptions = {}): SVGSVGElement {
  const def: IconDef = ICONS[name];
  const size = options.size ?? 24;
  const svg = s('svg', {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: def.filled ? 'currentColor' : 'none',
    stroke: 'currentColor',
    'stroke-width': options.stroke ?? 1.75,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  });
  if (options.class) svg.setAttribute('class', options.class);
  for (const d of def.paths) svg.append(s('path', { d }));
  return svg;
}
