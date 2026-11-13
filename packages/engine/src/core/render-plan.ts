/**
 * RenderPlan: the fully resolved, self-contained description of a video.
 *
 * Built in Node by the visuals layer (real code lines, syntax tokens, diagram layout,
 * absolute timings) and consumed by the browser runtime, which turns it into frames.
 * The runtime never fetches anything: every asset is inside the plan (images as data URLs).
 *
 * This file must stay type-only and dependency-free: the browser runtime imports it too.
 */
import type { NodeKind, SceneRole, Severity, TransitionType } from './storyboard-schema.ts';

/** The base look of the runtime. A theme is drawn on one of the two. */
export type ThemeName = 'dark' | 'light';
export type QualityPreset = 'draft' | 'standard' | 'high';

export interface RenderPlan {
  version: 1;
  /** Output size in pixels. The runtime lays out at 1920x1080 and scales to this size. */
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  theme: ThemeName;
  /**
   * Colors of the theme, by design token without "--" (see core/theme.ts). Plans made before themes
   * have none, and the base colors of `theme` apply.
   */
  colors?: Record<string, string>;
  meta: PlanMeta;
  captions: { enabled: boolean; cues: PlanCue[] };
  chapters: { title: string; startSec: number }[];
  scenes: PlannedScene[];
  /** Branded end card appended after the last scene. */
  outro: { startSec: number; durationSec: number; tagline: string; lines: string[] };
}

export interface PlanMeta {
  title: string;
  /** e.g. "acme/weather-app". Never a local filesystem path. */
  repoLabel: string;
  /** e.g. "PR #42", or "feature/retry" for local runs. */
  changeLabel: string;
  /** Short head commit, e.g. "3f9c2ab". */
  headShort: string;
  stats: { files: number; additions: number; deletions: number };
  engineVersion: string;
}

export interface PlanCue {
  startSec: number;
  endSec: number;
  text: string;
}

export type BadgeKind = 'simulated' | 'actual' | 'masked' | 'reported';

export interface PlannedScene {
  id: string;
  role: SceneRole;
  title: string;
  /** Absolute start in seconds. Scenes overlap by transitionIn.durationSec. */
  startSec: number;
  durationSec: number;
  transitionIn: { type: TransitionType; durationSec: number };
  /** Narration beats with absolute timings. Visual elements key their animations off these. */
  beats: { index: number; startSec: number; durationSec: number; text: string }[];
  visual: ResolvedVisual;
  /** Evidence chips shown at the bottom of the scene, e.g. "src/retry.ts:12-40". The plan holds at most three, with line ranges already collapsed; the runtime draws them as given. */
  refs: string[];
  badges: { kind: BadgeKind; text: string }[];
}

// ---------------------------------------------------------------------------
// Resolved visuals (one per template)
// ---------------------------------------------------------------------------

export interface TextBeat {
  text: string;
  beat: number;
}

/** A syntax-highlighted token. c = CSS color (null = theme default), s = font style bits (1 italic, 2 bold, 4 underline). */
export interface CodeToken {
  t: string;
  c: string | null;
  s: number;
}

export interface CodeLine {
  kind: 'add' | 'del' | 'ctx';
  oldNumber: number | null;
  newNumber: number | null;
  tokens: CodeToken[];
}

export interface ResolvedCode {
  path: string;
  language: string;
  side: 'head' | 'base';
  lines: CodeLine[];
  /** True when one or more secrets were masked in these lines. */
  masked: boolean;
  /** True when the requested range was shortened to fit on screen. */
  truncated: boolean;
}

export interface ResolvedImage {
  /** data: URL (PNG or JPEG). */
  src: string;
  width: number;
  height: number;
}

export interface TitleResolved {
  type: 'title';
  kicker: string | null;
  heading: string;
  subheading: string | null;
  /** At most STORYBOARD_LIMITS.maxChips; the plan builder cuts the rest. */
  chips: string[];
}

export interface MissionResolved {
  type: 'mission';
  problem: string;
  goal: string;
  points: TextBeat[];
}

export interface FilesResolved {
  type: 'files';
  caption: string | null;
  totals: { files: number; additions: number; deletions: number };
  groups: {
    component: string;
    files: {
      path: string;
      status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';
      additions: number;
      deletions: number;
      highlighted: boolean;
      trivial: boolean;
    }[];
  }[];
  /** Files left out to fit the screen. */
  hiddenCount: number;
}

export interface ArchitectureResolved {
  type: 'architecture';
  /** Direction the diagram was laid out in; can differ from the storyboard when the other one reads better. */
  direction: 'LR' | 'TB';
  /** Layout box in logical pixels; the runtime scales it to fit the content area. */
  width: number;
  height: number;
  nodes: {
    id: string;
    label: string;
    detail: string | null;
    kind: NodeKind;
    status: 'added' | 'modified' | 'removed' | 'unchanged';
    beat: number;
    x: number; // center
    y: number; // center
    w: number;
    h: number;
  }[];
  edges: {
    from: string;
    to: string;
    label: string | null;
    status: 'added' | 'removed' | 'unchanged';
    beat: number;
    /** Polyline through the layout box, from source to target. */
    points: { x: number; y: number }[];
  }[];
}

export interface FlowResolved {
  type: 'flow';
  actors: { id: string; label: string; kind: NodeKind }[];
  steps: {
    from: string;
    to: string;
    label: string;
    detail: string | null;
    kind: 'request' | 'response' | 'event' | 'call';
    beat: number;
  }[];
}

export interface CodeResolved {
  type: 'code';
  mode: 'snippet' | 'diff';
  code: ResolvedCode;
  /** Focus ranges in file line numbers on code.side (not positions in code.lines). */
  focus: { startLine: number; endLine: number; note: string | null; beat: number }[];
  caption: string | null;
}

/** One side of a before and after pair. A terminal panel is illustrative output, not a real run. */
export type ResolvedPanel = { label: string } & (
  | { kind: 'code'; code: ResolvedCode }
  | { kind: 'bullets'; bullets: string[] }
  | { kind: 'terminal'; terminal: { kind: 'command' | 'output' | 'comment'; text: string; beat: number }[] }
  | { kind: 'screenshot'; image: ResolvedImage }
);

export interface BeforeAfterResolved {
  type: 'before-after';
  before: ResolvedPanel;
  after: ResolvedPanel;
  caption: string | null;
}

export interface TerminalResolved {
  type: 'terminal';
  title: string;
  lines: { kind: 'command' | 'output' | 'comment'; text: string; beat: number }[];
}

export interface BrowserResolved {
  type: 'browser';
  url: string;
  pageTitle: string;
  blocks: {
    kind: 'heading' | 'text' | 'button' | 'input' | 'list' | 'table' | 'card' | 'toast' | 'badge' | 'image';
    text: string;
    items: string[];
    emphasis: boolean;
    beat: number;
  }[];
}

export interface ChecklistResolved {
  type: 'checklist';
  items: {
    title: string;
    detail: string;
    severity: Severity;
    /** e.g. "src/retry.ts:12-40", or null. */
    refLabel: string | null;
    beat: number;
  }[];
}

export interface BulletsResolved {
  type: 'bullets';
  heading: string | null;
  items: TextBeat[];
}

export interface ScreenshotResolved {
  type: 'screenshot';
  image: ResolvedImage;
  caption: string | null;
}

export interface SummaryResolved {
  type: 'summary';
  points: TextBeat[];
  closing: string | null;
}

export type ResolvedVisual =
  | TitleResolved
  | MissionResolved
  | FilesResolved
  | ArchitectureResolved
  | FlowResolved
  | CodeResolved
  | BeforeAfterResolved
  | TerminalResolved
  | BrowserResolved
  | ChecklistResolved
  | BulletsResolved
  | ScreenshotResolved
  | SummaryResolved;

// ---------------------------------------------------------------------------
// Browser runtime API (window.__MERGESTORY__)
// ---------------------------------------------------------------------------

export interface SeekResult {
  /**
   * false only when the frame is guaranteed identical to the previous seek's frame.
   * The renderer then reuses the previous screenshot instead of capturing a new one.
   */
  dirty: boolean;
}

export interface MergeStoryRuntimeApi {
  /** Build the DOM for the whole plan and wait until fonts and images are ready. */
  load(plan: RenderPlan): Promise<void>;
  /** Show the frame at an absolute time. Must be a pure function of timeSec. */
  seek(timeSec: number): SeekResult;
}

/** Logical layout size. All templates are designed for this canvas. */
export const STAGE_WIDTH = 1920;
export const STAGE_HEIGHT = 1080;
/** The content area inside the safe margins: the box templates render into (see .ms-content). */
export const CONTENT_W = 1680;
export const CONTENT_H = 704;
