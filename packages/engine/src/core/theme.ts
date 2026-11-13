/**
 * Video themes. A theme is data, never code: one theme.json with colors for the design tokens of the
 * video runtime and the name of a Shiki theme for code. The built-in themes are in assets/themes and
 * go through the same loader as the themes people make.
 *
 * Where a theme comes from: a name finds a built-in theme, then $MERGESTORY_HOME/themes/<name>. Any
 * other value must be the full path of a theme folder, which only the command line, the user's own
 * config file and MERGESTORY_THEME give. The storyboard, the pull request, the repository, the HTTP
 * API and the agent commands never do.
 */
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundledThemesInfo } from 'shiki';
import { z } from 'zod';
import { BUILT_IN_THEMES, THEME_NAME } from './config.ts';
import { MergeStoryError } from './errors.ts';
import { assertNoLinks, homeLayout } from './paths.ts';
import type { ThemeName } from './render-plan.ts';

export { BUILT_IN_THEMES };

type BuiltIn = (typeof BUILT_IN_THEMES)[number];

/** The theme a dark or a light theme starts from when it extends nothing. */
const BASES: Record<ThemeName, BuiltIn> = { dark: 'midnight', light: 'paper' };

/** The colors a theme may set: design tokens of the runtime (runtime/styles.ts), without "--". */
export const THEME_TOKENS = [
  'bg-0',
  'bg-1',
  'surface-1',
  'surface-2',
  'surface-code',
  'surface-inset',
  'border-1',
  'border-2',
  'text-0',
  'text-1',
  'text-2',
  'text-3',
  'accent',
  'accent-soft',
  'accent-2',
  'accent-2-soft',
  'accent-ink',
  'accent-2-ink',
  'brand-1',
  'brand-2',
  'glow',
  'glow-2',
  'cap-bg',
  'cap-fg',
  'cap-ring',
  'sev-info',
  'sev-low',
  'sev-medium',
  'sev-high',
] as const;

/**
 * Tokens with the same meaning in every theme: added, removed and changed lines, and the badges that
 * say a picture is simulated or that secrets were masked. A theme cannot make a video hide either.
 */
export const LOCKED_TOKENS = [
  'add',
  'add-soft',
  'add-line',
  'del',
  'del-soft',
  'del-line',
  'mod',
  'mod-soft',
  'badge-bg',
  'badge-simulated',
  'badge-actual',
  'badge-masked',
  'badge-reported',
  'on-status',
  'edge-added',
] as const;

/** The locked colors that show what a change did, as runtime/styles.ts draws them on each base. */
export const CHANGE_COLORS: Record<ThemeName, Record<string, string>> = {
  dark: { add: '#3ddc97', del: '#ff6b81', mod: '#ffc861', 'edge-added': '#8c7bff' },
  light: { add: '#0f9f6e', del: '#d6334f', mod: '#b7791f', 'edge-added': '#6750f0' },
};
const CHANGE_CONTRAST = 2;

const BUILT_IN_DIR = fileURLToPath(new URL('../../assets/themes/', import.meta.url));
const THEME_FILE = 'theme.json';
const MAX_THEME_BYTES = 64 * 1024;
/** Never part of a color, but part of every way to make CSS load something or end a declaration. */
const FORBIDDEN = ['://', 'url(', '@import', 'expression', '<', ';'];
const MAX_VALUE_LENGTH = 64;

/** A theme ready for a render plan. */
export interface ResolvedTheme {
  name: string;
  /** The runtime look the colors apply to. */
  base: ThemeName;
  /** Token colors by token name, without "--". */
  colors: Record<string, string>;
  /** The bundled Shiki theme for code. */
  shiki: string;
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

/** Red, green and blue from 0 to 255, alpha from 0 to 1. */
export type Rgba = [number, number, number, number];

// Small numbers only: a 40-digit hue is a number to JavaScript, but the browser draws something else.
const N = String.raw`(\d{1,3}(?:\.\d{1,4})?|\.\d{1,4})`;
const ALPHA = String.raw`${N}(%?)`;
const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB = [
  new RegExp(String.raw`^rgba?\( *${N} *, *${N} *, *${N} *(?:, *${ALPHA} *)?\)$`, 'i'),
  new RegExp(String.raw`^rgba?\( *${N} +${N} +${N} *(?:/ *${ALPHA} *)?\)$`, 'i'),
];
const HSL = [
  new RegExp(String.raw`^hsla?\( *${N}(?:deg)? *, *${N}% *, *${N}% *(?:, *${ALPHA} *)?\)$`, 'i'),
  new RegExp(String.raw`^hsla?\( *${N}(?:deg)? +${N}% +${N}% *(?:/ *${ALPHA} *)?\)$`, 'i'),
];

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return [f(0), f(8), f(4)];
}

/** A color in hex, rgb()/rgba() or hsl()/hsla() notation, or null for anything else. */
export function parseColor(value: string): Rgba | null {
  const hex = HEX.exec(value);
  if (hex) {
    const short = hex[1]!.length <= 4;
    const digits = short ? [...hex[1]!].map((d) => d + d).join('') : hex[1]!;
    const byte = (i: number) => Number.parseInt(digits.slice(i, i + 2), 16);
    return [byte(0), byte(2), byte(4), digits.length === 8 ? byte(6) / 255 : 1];
  }
  for (const [forms, rgb] of [
    [RGB, true],
    [HSL, false],
  ] as const) {
    const m = forms.map((form) => form.exec(value)).find(Boolean);
    if (!m) continue;
    const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const alpha = m[4] === undefined ? 1 : Number(m[4]) / (m[5] === '%' ? 100 : 1);
    if (alpha > 1) return null;
    if (rgb) return a <= 255 && b <= 255 && c <= 255 ? [a, b, c, alpha] : null;
    return a <= 360 && b <= 100 && c <= 100 ? [...hslToRgb(a, b / 100, c / 100), alpha] : null;
  }
  return null;
}

/** Why a theme value is not accepted, or null when it is a plain color. */
export function colorProblem(value: string): string | null {
  const lower = value.toLowerCase();
  const forbidden = FORBIDDEN.find((part) => lower.includes(part));
  if (forbidden) return `contains "${forbidden}", which a theme may not use`;
  if (value.length > MAX_VALUE_LENGTH || !parseColor(value)) {
    return 'is not a color: use #rrggbb, rgb(), rgba(), hsl() or hsla()';
  }
  return null;
}

/** A ratio for a message, rounded down, so 2.996 never reads as the 3:1 it misses. */
const ratioText = (ratio: number): string => (Math.floor(ratio * 100) / 100).toFixed(2);

function luminance([r, g, b]: Rgba): number {
  const linear = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** `top` drawn over the opaque color `below`. */
function over(top: Rgba, below: Rgba): Rgba {
  const mix = (i: number) => top[i]! * top[3] + below[i]! * (1 - top[3]);
  return [mix(0), mix(1), mix(2), 1];
}

/** WCAG contrast ratio of a (possibly see-through) text color on an opaque background. */
export function contrastOn(text: Rgba, background: Rgba): number {
  const [hi, lo] = [luminance(over(text, background)), luminance(background)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** The smallest contrast each text color needs on every background. The accents color labels and chips. */
const TEXT_CONTRAST: Record<string, number> = {
  'text-0': 4.5,
  'text-1': 4.5,
  'text-2': 4.5,
  'text-3': 3,
  accent: 3,
  'accent-2': 3,
};
const CAPTION_CONTRAST = 7;

/** A theme color by token. Every theme holds all colors that the checks read (its base has them all). */
function colorReader(theme: ResolvedTheme): (token: string) => Rgba {
  return (token) => {
    const value = parseColor(theme.colors[token] ?? '');
    if (!value) throw new MergeStoryError('INTERNAL', `Theme "${theme.name}" has no color for ${token}.`);
    return value;
  };
}

/** Boxes the video draws on its background: cards, code windows, insets, and insets and code on cards. */
const LAYERS = [
  [],
  ['surface-1'],
  ['surface-2'],
  ['surface-code'],
  ['surface-inset'],
  ['surface-1', 'surface-inset'],
  ['surface-2', 'surface-inset'],
  ['surface-1', 'surface-code'],
  ['surface-2', 'surface-code'],
];

/**
 * The backgrounds text and changes are drawn on: the stage gradient from bg-1 (top) to bg-0 (bottom),
 * at five points, with every box of LAYERS on it. The soft glows behind scenes are left out.
 */
function backgroundsOf(color: (token: string) => Rgba): [string, Rgba][] {
  const [top, bottom] = [color('bg-1'), color('bg-0')];
  const out: [string, Rgba][] = [];
  for (const at of [0, 0.25, 0.5, 0.75, 1]) {
    const stage: Rgba = [0, 1, 2].map((i) => top[i]! * (1 - at) + bottom[i]! * at).concat(1) as Rgba;
    const where =
      at === 0 ? 'bg-1' : at === 1 ? 'bg-0' : `the background ${at * 100}% of the way from bg-1 to bg-0`;
    for (const layers of LAYERS) {
      const background = layers.reduce((below, surface) => over(color(surface), below), stage);
      out.push([[...layers].reverse().concat(where).join(' on '), background]);
    }
  }
  return out;
}

/**
 * Problems no flag allows: a see-through background, or a background that would hide what a change
 * did. Each locked change color (added, removed and changed lines, added connections) must stand out
 * from every background.
 */
export function safetyProblems(theme: ResolvedTheme): string[] {
  const color = colorReader(theme);
  const problems = ['bg-0', 'bg-1'].flatMap((token) =>
    color(token)[3] < 1 ? [`${token} must be opaque: it is the background of the whole video.`] : [],
  );
  if (problems.length > 0) return problems;
  for (const [token, value] of Object.entries(CHANGE_COLORS[theme.base])) {
    for (const [where, background] of backgroundsOf(color)) {
      const ratio = contrastOn(parseColor(value)!, background);
      if (ratio < CHANGE_CONTRAST) {
        problems.push(
          `${token} (${value}) reaches ${ratioText(ratio)}:1 on ${where}, so a change could be missed; it needs ${CHANGE_CONTRAST}:1.`,
        );
        break;
      }
    }
  }
  return problems;
}

/** Contrast problems of a theme with opaque backgrounds, one sentence each. None means easy to read. */
export function contrastProblems(theme: ResolvedTheme): string[] {
  const color = colorReader(theme);
  const problems: string[] = [];
  const backgrounds = backgroundsOf(color);
  for (const [token, minimum] of Object.entries(TEXT_CONTRAST)) {
    for (const [where, background] of backgrounds) {
      const ratio = contrastOn(color(token), background);
      if (ratio < minimum) {
        problems.push(`${token} reaches ${ratioText(ratio)}:1 on ${where}; it needs ${minimum}:1.`);
        break;
      }
    }
  }
  // A caption sits on whatever the scene shows, so try its pill over every grey from black to white.
  for (let grey = 0; grey <= 255; grey += 15) {
    const pill = over(color('cap-bg'), [grey, grey, grey, 1]);
    const ratio = contrastOn(color('cap-fg'), pill);
    if (ratio < CAPTION_CONTRAST) {
      problems.push(
        `Captions (cap-fg on cap-bg) reach ${ratioText(ratio)}:1 over some scenes; they need ${CAPTION_CONTRAST}:1.`,
      );
      break;
    }
  }
  const code = bundledThemesInfo.find((info) => info.id === theme.shiki);
  if (code && code.type !== theme.base) {
    problems.push(
      `code.shiki "${theme.shiki}" is a ${code.type} theme on a ${theme.base} video: code would be hard to read.`,
    );
  }
  return problems;
}

// ---------------------------------------------------------------------------
// theme.json
// ---------------------------------------------------------------------------

const Color = z.string().superRefine((value, ctx) => {
  const problem = colorProblem(value);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});

const tokens = new Set<string>(THEME_TOKENS);
const locked = new Set<string>(LOCKED_TOKENS);

const Palette = z.record(z.string(), Color).superRefine((colors, ctx) => {
  for (const key of Object.keys(colors)) {
    if (locked.has(key)) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message:
          'cannot be changed: added, removed and changed lines, and the badges, look the same in every theme',
      });
    } else if (!tokens.has(key)) {
      ctx.addIssue({ code: 'custom', path: [key], message: 'is not a color a theme can set' });
    }
  }
});

const ThemeFileSchema = z.strictObject({
  schema: z.literal(1),
  name: z.string().regex(THEME_NAME, '1-40 characters: a-z, 0-9 and "-", starting with a letter or digit'),
  extends: z.enum(BUILT_IN_THEMES).optional(),
  colors: z.strictObject({ dark: Palette.optional(), light: Palette.optional() }).optional(),
  code: z
    .strictObject({
      shiki: z
        .string()
        .refine(
          (id) => bundledThemesInfo.some((info) => info.id === id),
          'is not a Shiki theme that MergeStory has',
        ),
    })
    .optional(),
});

type ThemeFile = z.infer<typeof ThemeFileSchema>;

function themeError(
  message: string,
  hint = 'See docs/themes.md for what a theme may contain.',
): MergeStoryError {
  return new MergeStoryError('CONFIG_INVALID', message, { hint });
}

/**
 * The text of a file in a theme folder. Only a plain file inside the folder: no absolute path, no
 * "..", no symbolic link, no hard link, and its real path must stay inside the folder. Built-in
 * themes may be hard links, which some package managers make when they install.
 */
export async function readThemeFile(folder: string, name: string, builtIn = false): Promise<string> {
  if (isAbsolute(name) || name.split(/[\\/]/).includes('..')) {
    throw themeError(`"${name}" is not a file inside the theme folder.`);
  }
  // Without a trailing "/" or "/.", which would make the link check follow a link.
  const dir = resolve(folder);
  await assertNoLinks(dir, false);
  const root = await realpath(dir).catch(() => {
    throw themeError(
      `Theme folder not found: ${folder}`,
      'Theme names are lowercase, such as terminal. A path must lead to a folder that holds theme.json.',
    );
  });
  const path = join(root, name);
  const info = await lstat(path).catch(() => null);
  if (!info) throw themeError(`The theme folder has no ${name}: ${folder}`);
  if (!info.isFile()) throw themeError(`${name} in ${folder} must be a plain file, not a link or a folder.`);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => {
    throw themeError(`${name} in ${folder} could not be opened as a plain file.`);
  });
  try {
    const stats = await handle.stat();
    if (stats.ino !== info.ino || stats.dev !== info.dev) {
      throw themeError(`${name} in ${folder} changed while it was read.`);
    }
    if (!stats.isFile() || (!builtIn && stats.nlink !== 1)) {
      throw themeError(`${name} in ${folder} must be a plain file with a single name, not a hard link.`);
    }
    if (stats.size > MAX_THEME_BYTES) throw themeError(`${name} in ${folder} is larger than 64 KB.`);
    if (!(await realpath(path)).startsWith(root + sep)) {
      throw themeError(`${name} is outside the theme folder ${folder}.`);
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

/** A theme.json value checked against the format; `where` names it in errors. */
function parseThemeFile(data: unknown, where: string): ThemeFile {
  const parsed = ThemeFileSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 6)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw themeError(`The theme in ${where} is not valid: ${issues}`);
  }
  return parsed.data;
}

async function readTheme(folder: string, builtIn: boolean): Promise<ThemeFile> {
  const text = await readThemeFile(folder, THEME_FILE, builtIn);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw themeError(`${THEME_FILE} is not valid JSON: ${folder}`);
  }
  return parseThemeFile(data, folder);
}

/** A theme with its colors complete: those of the theme it extends (or of its base), then its own. */
async function complete(file: ThemeFile, isBase: boolean): Promise<ResolvedTheme> {
  const { dark, light } = file.colors ?? {};
  if (dark && light) {
    throw themeError(
      `Theme "${file.name}" sets both colors.dark and colors.light. A theme is dark or light: keep one.`,
    );
  }
  const own: ThemeName | null = light ? 'light' : dark ? 'dark' : null;
  const parentName = file.extends ?? (isBase ? null : BASES[own ?? 'dark']);
  const parent = parentName ? await builtInTheme(parentName) : null;
  if (parent && own && parent.base !== own) {
    throw themeError(
      `Theme "${file.name}" extends ${parentName}, a ${parent.base} theme, so its colors go under colors.${parent.base}.`,
    );
  }
  const base = own ?? parent?.base ?? 'dark';
  return {
    name: file.name,
    base,
    colors: { ...parent?.colors, ...(dark ?? light) },
    shiki: file.code?.shiki ?? parent?.shiki ?? 'github-dark-default',
  };
}

function builtInTheme(name: BuiltIn): Promise<ResolvedTheme> {
  return readTheme(join(BUILT_IN_DIR, name), true).then((file) =>
    complete(file, name === BASES.dark || name === BASES.light),
  );
}

export interface LoadThemeOptions {
  /** The MergeStory home (config.home); null means the default. */
  home?: string | null;
  /** Warn about low contrast instead of refusing the theme. */
  allowLowContrast?: boolean;
  warn?: (message: string) => void;
}

/**
 * The theme a setting names: a built-in theme (dark and light are midnight and paper), else
 * $MERGESTORY_HOME/themes/<name>, else the full path of a theme folder (or of its theme.json).
 * A theme that is hard to read is refused unless `allowLowContrast` is set.
 */
export async function loadTheme(value: string, options: LoadThemeOptions = {}): Promise<ResolvedTheme> {
  const name = value === 'dark' ? 'midnight' : value === 'light' ? 'paper' : value;
  let theme: ResolvedTheme;
  if ((BUILT_IN_THEMES as readonly string[]).includes(name)) {
    theme = await builtInTheme(name as BuiltIn);
  } else if (THEME_NAME.test(name)) {
    const folder = join(homeLayout(options.home).themes, name);
    if (!(await lstat(folder).catch(() => null))) {
      throw themeError(
        `There is no theme named "${name}".`,
        `Built-in themes: ${BUILT_IN_THEMES.join(', ')}. Your own themes go in ${join(homeLayout(options.home).themes, '<name>', THEME_FILE)}. For a theme folder here, write ./${name}.`,
      );
    }
    theme = await complete(await readTheme(folder, false), false);
  } else if (isAbsolute(value)) {
    const folder = basename(value) === THEME_FILE ? dirname(value) : value;
    theme = await complete(await readTheme(folder, false), false);
  } else {
    throw themeError(`"${value}" is not a theme name or the full path of a theme folder.`);
  }
  return checked(theme, options);
}

/** The theme, after the checks: never usable when unsafe, and hard to read only when allowed. */
function checked(theme: ResolvedTheme, options: LoadThemeOptions): ResolvedTheme {
  const unsafe = safetyProblems(theme);
  if (unsafe.length > 0) {
    throw themeError(
      `Theme "${theme.name}" cannot be used. ${unsafe.join(' ')}`,
      'Backgrounds must be opaque and must differ from the fixed colors of added, removed and changed lines. --allow-low-contrast does not change this.',
    );
  }
  const problems = contrastProblems(theme);
  if (problems.length > 0 && !options.allowLowContrast) {
    throw themeError(
      `Theme "${theme.name}" is hard to read. ${problems.join(' ')}`,
      'Change these colors, or pass --allow-low-contrast to use the theme anyway.',
    );
  }
  for (const problem of problems) options.warn?.(`Theme "${theme.name}": ${problem}`);
  return theme;
}

// ---------------------------------------------------------------------------
// A theme made from brand colors (theme init)
// ---------------------------------------------------------------------------

const WHITE: Rgba = [255, 255, 255, 1];
const BLACK: Rgba = [0, 0, 0, 1];
const toHex = (c: Rgba): string =>
  `#${c
    .slice(0, 3)
    .map((v) => Math.round(v).toString(16).padStart(2, '0'))
    .join('')}`;
const mix = (a: Rgba, b: Rgba, share: number): Rgba => [
  ...([0, 1, 2].map((i) => a[i]! * (1 - share) + b[i]! * share) as [number, number, number]),
  1,
];
const seeThrough = (c: Rgba, alpha: number): string =>
  `rgba(${c
    .slice(0, 3)
    .map((v) => Math.round(v))
    .join(', ')}, ${alpha})`;

/** Hue in degrees, and saturation and lightness from 0 to 1. */
function hsl([r, g, b]: Rgba): [number, number, number] {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === rr ? ((gg - bb) / d) % 6 : max === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

/** A color that can carry a brand: clearly colored, neither near black nor near white. */
const vivid = (c: Rgba): boolean => {
  const [, s, l] = hsl(c);
  return s >= 0.3 && l >= 0.2 && l <= 0.8;
};
const hueDistance = (a: Rgba, b: Rgba): number => {
  const d = Math.abs(hsl(a)[0] - hsl(b)[0]);
  return Math.min(d, 360 - d);
};

/**
 * The colors of a brand file, such as CSS variables, design tokens in JSON or a plain list: every
 * opaque hex, rgb() or hsl() value, in the order it appears, each once.
 */
export function brandColors(text: string): Rgba[] {
  const out: Rgba[] = [];
  const seen = new Set<string>();
  for (const [raw] of text.matchAll(/#[0-9a-f]{3,8}\b|(?:rgba?|hsla?)\([^)]{0,60}\)/gi)) {
    const color = parseColor(raw);
    if (!color || color[3] < 1 || seen.has(toHex(color))) continue;
    seen.add(toHex(color));
    out.push(color);
  }
  return out;
}

/**
 * The accent colors of a theme made from one or two brand colors, related to them the way the accent
 * colors of midnight (dark) and paper (light) are related to theirs.
 */
export function accentColors(base: ThemeName, accent: Rgba, accent2: Rgba | null): Record<string, string> {
  const paler = (c: Rgba, white: number) => toHex(mix(c, WHITE, white));
  const deeper = (c: Rgba, black: number) => toHex(mix(c, BLACK, black));
  if (base === 'dark') {
    return {
      accent: toHex(accent),
      'accent-soft': seeThrough(accent, 0.16),
      'accent-ink': paler(accent, 0.53),
      'brand-1': paler(accent, 0.37),
      glow: toHex(accent),
      ...(accent2 && {
        'accent-2': toHex(accent2),
        'accent-2-soft': seeThrough(accent2, 0.14),
        'accent-2-ink': paler(accent2, 0.45),
        'brand-2': toHex(accent2),
        'glow-2': toHex(accent2),
      }),
    };
  }
  return {
    accent: toHex(accent),
    'accent-soft': seeThrough(accent, 0.1),
    'accent-ink': deeper(accent, 0.12),
    'brand-1': deeper(accent, 0.12),
    glow: paler(accent, 0.3),
    ...(accent2 && {
      'accent-2': toHex(accent2),
      'accent-2-soft': seeThrough(accent2, 0.1),
      'accent-2-ink': deeper(accent2, 0.2),
      'brand-2': deeper(accent2, 0.2),
      'glow-2': paler(accent2, 0.3),
    }),
  };
}

export interface CreateThemeOptions {
  name: string;
  /** The built-in theme to start from; it decides dark or light. Default midnight. */
  from?: string;
  /** Brand colors given as flags. They win over the brand file. */
  accent?: string;
  accent2?: string;
  /** The text of a brand file; its first two vivid colors of clearly different hues are used. */
  brand?: string;
  allowLowContrast?: boolean;
  warn?: (message: string) => void;
}

function flagColor(flag: string, value: string | undefined): Rgba | null {
  if (value === undefined) return null;
  const problem = colorProblem(value);
  const color = parseColor(value);
  if (problem || !color || color[3] < 1) {
    throw themeError(`${flag} must be an opaque color, such as #ff7a1a.`, 'Use #rrggbb, rgb() or hsl().');
  }
  return color;
}

/**
 * A new theme from brand colors: the theme.json to write, and the theme it gives, after the same
 * checks as a theme that is loaded.
 */
export async function createTheme(
  options: CreateThemeOptions,
): Promise<{ file: ThemeFile; theme: ResolvedTheme }> {
  const from =
    options.from === 'dark' ? 'midnight' : options.from === 'light' ? 'paper' : (options.from ?? 'midnight');
  if (!(BUILT_IN_THEMES as readonly string[]).includes(from)) {
    throw themeError(`--from must be a built-in theme: ${BUILT_IN_THEMES.join(', ')}.`);
  }
  if (!THEME_NAME.test(options.name) || [...BUILT_IN_THEMES, 'dark', 'light'].includes(options.name)) {
    throw themeError(
      `"${options.name}" cannot be the name of a new theme.`,
      'Use 1-40 characters: a-z, 0-9 and "-", and not the name of a built-in theme.',
    );
  }
  const parent = await builtInTheme(from as BuiltIn);
  // Brand colors that labels can use on this look: a navy brand color suits paper, not midnight.
  const backgrounds = backgroundsOf(colorReader(parent));
  const readable = (c: Rgba) =>
    backgrounds.every(([, bg]) => contrastOn(c, bg) >= (TEXT_CONTRAST.accent ?? 3));
  const found = (options.brand === undefined ? [] : brandColors(options.brand)).filter(vivid);
  const accent = flagColor('--accent', options.accent) ?? found.find(readable) ?? found[0] ?? null;
  if (!accent) {
    throw themeError(
      options.brand === undefined
        ? 'Give --accent or --brand.'
        : 'The brand file has no clearly colored value written as #hex, rgb() or hsl().',
      'Pass the main brand color with --accent, for example --accent "#ff7a1a".',
    );
  }
  const accent2 =
    flagColor('--accent-2', options.accent2) ??
    found.find((c) => readable(c) && hueDistance(c, accent) >= 30) ??
    null;
  const base = parent.base;
  const file = parseThemeFile(
    { schema: 1, name: options.name, extends: from, colors: { [base]: accentColors(base, accent, accent2) } },
    `the new theme "${options.name}"`,
  );
  try {
    return { file, theme: checked(await complete(file, false), options) };
  } catch (err) {
    if (!(err instanceof MergeStoryError)) throw err;
    const picked = `Accent ${toHex(accent)}${accent2 ? `, accent-2 ${toHex(accent2)}` : ''} on ${from}.`;
    throw themeError(`${picked} ${err.message}`, err.hint);
  }
}
