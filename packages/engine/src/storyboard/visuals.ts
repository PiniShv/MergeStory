/** Rules that depend on the visual type: size limits, evidence ids, on-screen text and internal consistency. */
import { MIN_CLIP_SECONDS } from '../core/recording-frames.ts';
import {
  type Highlight,
  STORYBOARD_LIMITS as LIMITS,
  type PictureBox,
  type Scene,
  type Visual,
} from '../core/storyboard-schema.ts';
import type { Run, TextCleaner } from './run.ts';
import type { IssueCode } from './types.ts';

function trimList<T>(list: T[], max: number, path: string, what: string, run: Run): T[] {
  if (list.length <= max) return list;
  run.fix(path, `kept the first ${max} of ${list.length} ${what} (the limit is ${max})`);
  return list.slice(0, max);
}

function dedupeById<T extends { id: string }>(list: T[], path: string, what: string, run: Run): T[] {
  const seen = new Set<string>();
  return list.filter((item, index) => {
    if (seen.has(item.id)) {
      run.fix(`${path}[${index}]`, `dropped a duplicate ${what} id "${item.id}"`);
      return false;
    }
    seen.add(item.id);
    return true;
  });
}

/**
 * The last branch of a switch over the visual types. The parameter has type never, so adding a
 * visual type makes every such switch fail to compile until it handles the new type.
 */
export function exhaustive(_visual: never): void {}

/** Trim lists to the limits in STORYBOARD_LIMITS. */
export function applyVisualLimits(visual: Visual, p: string, run: Run): void {
  switch (visual.type) {
    case 'title':
      visual.chips = trimList(visual.chips, LIMITS.maxChips, `${p}.chips`, 'chips', run);
      break;
    case 'mission':
      visual.points = trimList(visual.points, LIMITS.maxMissionPoints, `${p}.points`, 'points', run);
      break;
    case 'architecture':
      visual.nodes = trimList(
        dedupeById(visual.nodes, `${p}.nodes`, 'node', run),
        LIMITS.maxArchitectureNodes,
        `${p}.nodes`,
        'nodes',
        run,
      );
      break;
    case 'flow':
      visual.actors = trimList(
        dedupeById(visual.actors, `${p}.actors`, 'actor', run),
        LIMITS.maxFlowActors,
        `${p}.actors`,
        'actors',
        run,
      );
      visual.steps = trimList(visual.steps, LIMITS.maxFlowSteps, `${p}.steps`, 'steps', run);
      break;
    case 'before-after':
      for (const [name, panel] of [
        ['before', visual.before],
        ['after', visual.after],
      ] as const) {
        panel.bullets = trimList(panel.bullets, LIMITS.maxBullets, `${p}.${name}.bullets`, 'bullets', run);
        panel.terminal = trimList(
          panel.terminal,
          LIMITS.maxTerminalLines,
          `${p}.${name}.terminal`,
          'terminal lines',
          run,
        );
        panel.highlights = trimList(
          panel.highlights,
          LIMITS.maxHighlights,
          `${p}.${name}.highlights`,
          'highlights',
          run,
        );
      }
      break;
    case 'terminal':
      visual.lines = trimList(visual.lines, LIMITS.maxTerminalLines, `${p}.lines`, 'terminal lines', run);
      break;
    case 'browser':
      visual.blocks = trimList(visual.blocks, LIMITS.maxBrowserBlocks, `${p}.blocks`, 'blocks', run);
      break;
    case 'checklist':
      visual.items = trimList(visual.items, LIMITS.maxChecklistItems, `${p}.items`, 'checklist items', run);
      break;
    case 'bullets':
      visual.items = trimList(visual.items, LIMITS.maxBullets, `${p}.items`, 'bullets', run);
      break;
    case 'summary':
      visual.points = trimList(visual.points, LIMITS.maxBullets, `${p}.points`, 'points', run);
      break;
    case 'screenshot':
    case 'recording':
      visual.highlights = trimList(
        visual.highlights,
        LIMITS.maxHighlights,
        `${p}.highlights`,
        'highlights',
        run,
      );
      break;
    case 'files':
    case 'code':
    case 'repro':
    case 'log':
      break;
    default:
      exhaustive(visual);
  }
}

/** Keep only evidence ids that exist; warn about changes that cite nothing. */
export function filterVisualEvidence(visual: Visual, p: string, run: Run): void {
  switch (visual.type) {
    case 'architecture':
      visual.nodes.forEach((node, index) => {
        const path = `${p}.nodes[${index}]`;
        node.evidence = run.validEvidence(node.evidence, `${path}.evidence`);
        if (node.status !== 'unchanged' && node.evidence.length === 0) {
          run.warn(
            path,
            'no-evidence',
            `node "${node.label}" is ${node.status} but cites no evidence (for example M1 or F2)`,
          );
        }
      });
      break;
    case 'flow':
      visual.steps.forEach((step, index) => {
        const path = `${p}.steps[${index}]`;
        step.evidence = run.validEvidence(step.evidence, `${path}.evidence`);
        if (step.evidence.length === 0)
          run.warn(path, 'no-evidence', `step "${step.label}" cites no evidence (for example F2.H1 or S3)`);
      });
      break;
    case 'checklist':
      visual.items.forEach((item, index) => {
        const path = `${p}.items[${index}]`;
        item.evidence = run.validEvidence(item.evidence, `${path}.evidence`);
        if (item.evidence.length === 0)
          run.warn(path, 'no-evidence', `item "${item.title}" cites no evidence (for example R1)`);
      });
      break;
    case 'title':
    case 'mission':
    case 'files':
    case 'code':
    case 'before-after':
    case 'terminal':
    case 'browser':
    case 'bullets':
    case 'screenshot':
    case 'recording':
    case 'repro':
    case 'log':
    case 'summary':
      break;
    default:
      exhaustive(visual);
  }
}

/** A highlight label is on-screen text like a caption: the same checks, and null when nothing is left. */
function cleanHighlightLabels(list: Highlight[], path: string, cleaner: TextCleaner): Highlight[] {
  return list.map((highlight, i) => ({
    ...highlight,
    label: cleaner.optional(highlight.label, `${path}[${i}].label`),
  }));
}

/** Remove unverifiable claims and names that the change does not contain from on-screen text. */
export function cleanVisualText(visual: Visual, p: string, cleaner: TextCleaner): void {
  switch (visual.type) {
    case 'title':
      visual.kicker = cleaner.optional(visual.kicker, `${p}.kicker`);
      visual.heading = cleaner.required(visual.heading, `${p}.heading`);
      visual.subheading = cleaner.optional(visual.subheading, `${p}.subheading`);
      visual.chips = cleaner.list(visual.chips, `${p}.chips`);
      break;
    case 'mission':
      visual.problem = cleaner.required(visual.problem, `${p}.problem`);
      visual.goal = cleaner.required(visual.goal, `${p}.goal`);
      visual.points = cleaner.keepTexts(visual.points, `${p}.points`);
      break;
    case 'files':
      visual.caption = cleaner.optional(visual.caption, `${p}.caption`);
      break;
    case 'architecture':
      visual.nodes = cleaner.keepTitled(visual.nodes, 'label', `${p}.nodes`, 'optional');
      visual.edges = visual.edges.map((edge, i) => ({
        ...edge,
        label: cleaner.optional(edge.label, `${p}.edges[${i}].label`),
      }));
      break;
    case 'flow':
      visual.actors = cleaner.keepTitled(visual.actors, 'label', `${p}.actors`);
      visual.steps = cleaner.keepTitled(visual.steps, 'label', `${p}.steps`, 'optional');
      break;
    case 'code':
    case 'log':
      visual.focus = visual.focus.map((focus, i) => ({
        ...focus,
        note: cleaner.optional(focus.note, `${p}.focus[${i}].note`),
      }));
      visual.caption = cleaner.optional(visual.caption, `${p}.caption`);
      break;
    case 'before-after':
      for (const name of ['before', 'after'] as const) {
        const panel = visual[name];
        panel.label = cleaner.required(panel.label, `${p}.${name}.label`);
        panel.bullets = cleaner.list(panel.bullets, `${p}.${name}.bullets`);
        panel.terminal = cleaner.keepTexts(panel.terminal, `${p}.${name}.terminal`);
        panel.highlights = cleanHighlightLabels(panel.highlights, `${p}.${name}.highlights`, cleaner);
      }
      visual.caption = cleaner.optional(visual.caption, `${p}.caption`);
      break;
    case 'terminal':
      visual.title = cleaner.required(visual.title, `${p}.title`);
      visual.lines = cleaner.keepTexts(visual.lines, `${p}.lines`);
      break;
    case 'browser':
      visual.pageTitle = cleaner.required(visual.pageTitle, `${p}.pageTitle`);
      visual.blocks = visual.blocks.flatMap((block, i) => {
        const path = `${p}.blocks[${i}]`;
        const text = cleaner.clean(block.text, `${path}.text`);
        const items = cleaner.list(block.items, `${path}.items`);
        const hadContent = block.text.trim() !== '' || block.items.length > 0;
        if (hadContent && !text.trim() && items.length === 0) return [];
        return [{ ...block, text, items }];
      });
      break;
    case 'checklist':
      visual.items = cleaner.keepTitled(visual.items, 'title', `${p}.items`, 'text');
      break;
    case 'bullets':
      visual.heading = cleaner.optional(visual.heading, `${p}.heading`);
      visual.items = cleaner.keepTexts(visual.items, `${p}.items`);
      break;
    case 'screenshot':
    case 'recording':
      visual.caption = cleaner.optional(visual.caption, `${p}.caption`);
      visual.highlights = cleanHighlightLabels(visual.highlights, `${p}.highlights`, cleaner);
      break;
    case 'repro':
      // A repro visual holds only step numbers; the text comes from the reproduction and is masked when the plan is built.
      break;
    case 'summary':
      visual.points = cleaner.keepTexts(visual.points, `${p}.points`);
      visual.closing = cleaner.optional(visual.closing, `${p}.closing`);
      break;
    default:
      exhaustive(visual);
  }
}

/** Top-level domains that mark a bare word as a web host. */
export const COMMON_TLDS =
  'com|org|net|io|dev|app|co|ai|cloud|local|test|internal|example|edu|gov|me|us|uk|de|fr|info|biz|xyz';
const SCHEME_AND_HOST = /^(?:[a-z][a-z0-9+.-]*:)?\/\/[^/?#]*/i;
const BARE_HOST = new RegExp(
  `^(?:localhost|www\\.[^/?#\\s]+|\\d{1,3}(?:\\.\\d{1,3}){3}|[^/?#\\s]+\\.(?:${COMMON_TLDS})|[^/?#\\s]+:\\d+)(?::\\d+)?(?=[/?#]|$)`,
  'i',
);

/** A browser address shows a path only. Scheme, host and credentials are removed. */
export function normalizeBrowserUrl(url: string): string {
  let rest = url.trim();
  const withScheme = SCHEME_AND_HOST.exec(rest);
  if (withScheme) rest = rest.slice(withScheme[0].length);
  else {
    const bare = BARE_HOST.exec(rest);
    if (bare) rest = rest.slice(bare[0].length);
  }
  if (!rest.startsWith('/')) rest = `/${rest}`;
  return rest;
}

/** Replace a visual that cannot be shown with the changed-files overview. */
export function fallbackToFiles(
  scene: Scene,
  path: string,
  reason: string,
  run: Run,
  highlightPaths: string[] = [],
  code: IssueCode = 'visual-fallback',
): void {
  const showable = [...new Set(highlightPaths)].filter((candidate) => run.refs.isShowable(candidate));
  scene.visual = { type: 'files', highlightPaths: showable, caption: null };
  run.warn(path, code, `${reason}; showing the changed-files overview instead`);
  run.fix(path, 'replaced the visual with the changed-files overview');
}

const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), high);
/** Least part of the clip a trim may leave, and the smallest zoom box side (a fraction of the frame). */
const MIN_ZOOM_SIDE = 0.05;

/**
 * Put the trim, speed and zoom of a recording visual into range. Every repair lands on a value that
 * passes the same check again, so a second validation changes nothing.
 */
function checkRecordingWindow(
  visual: Extract<Visual, { type: 'recording' }>,
  durationSec: number,
  vp: string,
  run: Run,
): void {
  const maxClip = run.config.inputs.maxClipSeconds;
  const shown = (n: number): string => `${Math.round(n * 10) / 10}`;
  if (visual.trim) {
    let { start, end } = visual.trim;
    if (start > end) {
      [start, end] = [end, start];
      run.fix(`${vp}.trim`, 'put start and end in order');
    }
    const inside = Math.min(end, durationSec) - Math.max(start, 0);
    if (inside < Math.min(MIN_CLIP_SECONDS, durationSec)) {
      run.error(
        `${vp}.trim`,
        'recording-trim-out-of-range',
        `the trim ${shown(start)} to ${shown(end)} s is outside the recording, which lasts ${shown(durationSec)} s; choose a part inside it`,
      );
      return;
    }
    const clamped = { start: clamp(start, 0, durationSec), end: clamp(end, 0, durationSec) };
    if (clamped.start !== start || clamped.end !== end) {
      run.warn(
        `${vp}.trim`,
        'recording-trim-out-of-range',
        `the trim ${shown(start)} to ${shown(end)} s reaches outside the recording, which lasts ${shown(durationSec)} s; it was cut to fit`,
      );
      run.fix(
        `${vp}.trim`,
        `cut the trim to ${shown(clamped.start)} to ${shown(clamped.end)} s, inside the recording`,
      );
    }
    visual.trim = clamped;
  }
  const { start, end } = visual.trim ?? { start: 0, end: durationSec };
  // The small margin keeps a window that was cut to the limit from failing the same test again.
  if (end - start > maxClip + 1e-6) {
    run.warn(
      `${vp}.trim`,
      'recording-too-long',
      `a scene can show at most ${maxClip} s of a recording; the clip was shortened from ${shown(end - start)} s`,
    );
    run.fix(`${vp}.trim`, `shortened the clip from the end to ${maxClip} s (the limit is ${maxClip} s)`);
    visual.trim = { start, end: start + maxClip };
  }
  if (visual.speed !== null) {
    const { minRecordingSpeed: low, maxRecordingSpeed: high } = LIMITS;
    const speed = clamp(visual.speed, low, high);
    if (speed !== visual.speed) {
      run.fix(
        `${vp}.speed`,
        `changed the speed from ${visual.speed} to ${speed} (the range is ${low} to ${high})`,
      );
      visual.speed = speed;
    }
  }
  if (visual.zoom) {
    const w = clamp(visual.zoom.w, MIN_ZOOM_SIDE, 1);
    const h = clamp(visual.zoom.h, MIN_ZOOM_SIDE, 1);
    const zoom = { x: clamp(visual.zoom.x, 0, 1 - w), y: clamp(visual.zoom.y, 0, 1 - h), w, h };
    if (zoom.x !== visual.zoom.x || zoom.y !== visual.zoom.y || w !== visual.zoom.w || h !== visual.zoom.h) {
      run.fix(`${vp}.zoom`, 'moved the zoom box inside the frame (x, y, w and h are fractions from 0 to 1)');
      visual.zoom = zoom;
    }
  }
}

/** Two numbers closer than this are the same: a box that ends exactly on an edge may be off by a rounding error. */
const EPSILON = 1e-9;
const near = (a: number, b: number): boolean => Math.abs(a - b) <= EPSILON;

/**
 * Put a box inside the picture: the sides into minSide..1, then the corner so that the box fits.
 * Every repair lands on a box that passes the same check again, and a box that is fine keeps its own
 * numbers. Says in one fix what changed: the box moved, or only a side was raised to the smallest size.
 */
function repairBox<T extends PictureBox>(box: T, minSide: number, noun: string, path: string, run: Run): T {
  const w = clamp(box.w, minSide, 1);
  const h = clamp(box.h, minSide, 1);
  const fit = { x: clamp(box.x, 0, 1 - w), y: clamp(box.y, 0, 1 - h), w, h };
  const raised = box.w < minSide - EPSILON || box.h < minSide - EPSILON;
  const moved =
    !near(fit.x, box.x) ||
    !near(fit.y, box.y) ||
    !near(w, Math.max(box.w, minSide)) ||
    !near(h, Math.max(box.h, minSide));
  if (!moved && !raised) return box;
  const parts = [];
  if (moved) parts.push(`moved the ${noun} inside the picture (x, y, w and h are fractions from 0 to 1)`);
  if (raised) {
    parts.push(`${moved ? 'made it' : `made the ${noun}`} at least ${minSide} of the picture wide and high`);
  }
  run.fix(path, parts.join(' and '));
  return { ...box, ...fit };
}

/** Cut a label to the limit at a word boundary where there is one. The "…" counts in the limit. */
function shortenLabel(label: string): string {
  const chars = Array.from(label.trim());
  const room = LIMITS.maxHighlightLabelLength - 1;
  // The cut is at the last space inside the room, or right here when the next character is one.
  const space = /\s/.test(chars[room] ?? '') ? room : chars.slice(0, room).findLastIndex((c) => /\s/.test(c));
  const word = chars.slice(0, Math.max(space, 0)).join('').trimEnd();
  // A word boundary that leaves almost nothing is no use: cut at the limit instead.
  return `${Array.from(word).length >= 2 ? word : chars.slice(0, room).join('').trimEnd()}…`;
}

function checkHighlights(list: Highlight[], path: string, run: Run): Highlight[] {
  return list.map((highlight, index) => {
    const at = `${path}[${index}]`;
    const box = repairBox(highlight, LIMITS.minHighlightSide, 'highlight', at, run);
    let label = highlight.label;
    const length = label === null ? 0 : Array.from(label).length;
    if (label !== null && length > LIMITS.maxHighlightLabelLength) {
      run.warn(
        `${at}.label`,
        'highlight-label-too-long',
        `the label has ${length} characters and the limit is ${LIMITS.maxHighlightLabelLength}; it was shortened`,
      );
      run.fix(
        `${at}.label`,
        `shortened the label to at most ${LIMITS.maxHighlightLabelLength} characters (the limit is ${LIMITS.maxHighlightLabelLength})`,
      );
      label = shortenLabel(label);
    }
    return { ...box, label };
  });
}

function checkFocus(visual: { focus: PictureBox | null }, path: string, run: Run): void {
  if (visual.focus) visual.focus = repairBox(visual.focus, LIMITS.minFocusSide, 'focus', path, run);
}

/**
 * The steps of a repro visual: only steps of the supplied reproduction, each once, in order, at most
 * 6. Every repair lands on a list that passes the same check again, so a second validation changes nothing.
 */
function checkReproSteps(visual: Extract<Visual, { type: 'repro' }>, vp: string, run: Run): void {
  const repro = run.repro;
  if (!repro) {
    run.error(
      `${vp}.steps`,
      'repro-unknown',
      'no reproduction was supplied, so use another visual; pass --repro-file (repro.json for the agent commands) to supply one',
    );
    return;
  }
  const count = repro.steps.length;
  const seen = new Set<number>();
  visual.steps = visual.steps.filter(({ step }, index) => {
    if (step < 1 || step > count) {
      run.warn(
        `${vp}.steps[${index}].step`,
        'repro-step-unknown',
        `step ${step} is not a step of the supplied reproduction, which has ${count} step${count === 1 ? '' : 's'}; it was dropped`,
      );
      run.fix(`${vp}.steps[${index}]`, `dropped step ${step} because the reproduction has no such step`);
      return false;
    }
    if (seen.has(step)) {
      run.fix(`${vp}.steps[${index}]`, `dropped step ${step} because it is listed twice`);
      return false;
    }
    seen.add(step);
    return true;
  });
  if (visual.steps.length === 0) {
    run.error(
      `${vp}.steps`,
      'repro-unknown',
      `the repro visual has no step of the supplied reproduction; list steps from 1 to ${count}, or use another visual`,
    );
    return;
  }
  if (visual.steps.some(({ step }, index) => index > 0 && step < (visual.steps[index - 1]?.step ?? 0))) {
    visual.steps.sort((a, b) => a.step - b.step);
    run.fix(`${vp}.steps`, 'put the steps in the order of the reproduction');
  }
  visual.steps = trimList(visual.steps, LIMITS.maxReproSteps, `${vp}.steps`, 'steps', run);
}

/** Internal consistency of one visual after the other steps: dangling ids, empty lists, screenshots, addresses. */
export function checkVisualIntegrity(scene: Scene, p: string, run: Run, cleaner: TextCleaner): void {
  const visual = scene.visual;
  const vp = `${p}.visual`;
  switch (visual.type) {
    case 'architecture': {
      const ids = new Set(visual.nodes.map((node) => node.id));
      visual.edges = visual.edges.filter((edge, index) => {
        if (ids.has(edge.from) && ids.has(edge.to)) return true;
        run.fix(
          `${vp}.edges[${index}]`,
          `dropped the edge "${edge.from}" -> "${edge.to}" because it points at a node that does not exist`,
        );
        return false;
      });
      if (visual.nodes.length === 0) fallbackToFiles(scene, vp, 'the architecture diagram has no nodes', run);
      break;
    }
    case 'flow': {
      const ids = new Set(visual.actors.map((actor) => actor.id));
      visual.steps = visual.steps.filter((step, index) => {
        if (ids.has(step.from) && ids.has(step.to)) return true;
        run.fix(
          `${vp}.steps[${index}]`,
          `dropped the step "${step.label}" because "${step.from}" or "${step.to}" is not an actor`,
        );
        return false;
      });
      if (visual.actors.length === 0 || visual.steps.length === 0)
        fallbackToFiles(scene, vp, 'the flow has no actors or no steps', run);
      break;
    }
    case 'files': {
      visual.highlightPaths = visual.highlightPaths.filter((path, index) => {
        if (run.refs.isShowable(path)) return true;
        run.fix(
          `${vp}.highlightPaths[${index}]`,
          `dropped "${path}" because it is not a changed file that can be shown${run.pathHint(path)}`,
        );
        return false;
      });
      break;
    }
    case 'screenshot': {
      if (!run.screenshots.has(visual.screenshotId)) {
        const known = [...run.screenshots.keys()];
        run.error(
          `${vp}.screenshotId`,
          'screenshot-unknown',
          `"${visual.screenshotId}" is not a supplied screenshot; ${known.length ? `use one of ${known.join(', ')}` : 'no screenshots were supplied, so use another visual'}`,
        );
      }
      visual.highlights = checkHighlights(visual.highlights, `${vp}.highlights`, run);
      checkFocus(visual, `${vp}.focus`, run);
      break;
    }
    case 'recording': {
      const recording = run.recordings.get(visual.recordingId);
      if (!recording) {
        const known = [...run.recordings.keys()];
        run.error(
          `${vp}.recordingId`,
          'recording-unknown',
          `"${visual.recordingId}" is not a supplied recording; ${known.length ? `use one of ${known.join(', ')}` : 'no recordings were supplied, so use another visual'}`,
        );
        break;
      }
      checkRecordingWindow(visual, recording.durationSec, vp, run);
      visual.highlights = checkHighlights(visual.highlights, `${vp}.highlights`, run);
      checkFocus(visual, `${vp}.focus`, run);
      break;
    }
    case 'repro':
      checkReproSteps(visual, vp, run);
      break;
    case 'before-after': {
      let empty = false;
      for (const name of ['before', 'after'] as const) {
        const panel = visual[name];
        const panelPath = `${vp}.${name}`;
        if (
          panel.kind === 'screenshot' &&
          (panel.screenshotId === null || !run.screenshots.has(panel.screenshotId))
        ) {
          run.warn(
            `${panelPath}.screenshotId`,
            'screenshot-unknown',
            `"${panel.screenshotId ?? ''}" is not a supplied screenshot; the panel shows its bullets instead`,
          );
          run.fix(panelPath, 'changed the screenshot panel to a bullets panel');
          panel.kind = 'bullets';
          panel.screenshotId = null;
        }
        if (
          panel.kind === 'recording' &&
          (panel.recordingId === null || !run.recordings.has(panel.recordingId))
        ) {
          run.warn(
            `${panelPath}.recordingId`,
            'recording-unknown',
            `"${panel.recordingId ?? ''}" is not a supplied recording; the panel shows its bullets instead`,
          );
          run.fix(panelPath, 'changed the recording panel to a bullets panel');
          panel.kind = 'bullets';
          panel.recordingId = null;
        }
        if (panel.kind !== 'screenshot' && panel.highlights.length > 0) {
          run.fix(panelPath, 'removed the highlights of a panel that does not show a screenshot');
          panel.highlights = [];
        } else panel.highlights = checkHighlights(panel.highlights, `${panelPath}.highlights`, run);
        if (panel.kind === 'bullets' && panel.bullets.length === 0) empty = true;
        if (panel.kind === 'terminal' && panel.terminal.length === 0) empty = true;
      }
      if (empty) fallbackToFiles(scene, vp, 'a before and after panel has nothing to show', run);
      break;
    }
    case 'browser': {
      const normalized = normalizeBrowserUrl(visual.url);
      if (normalized !== visual.url) {
        run.fix(
          `${vp}.url`,
          `changed "${visual.url}" to the path "${normalized}" (browser addresses show a path, never a host)`,
        );
        visual.url = normalized;
      }
      // The path is on screen too: a web address, a claim or an invented name in it goes the way it goes in other text.
      const cleaned = cleaner.clean(visual.url, `${vp}.url`);
      if (cleaned !== visual.url) visual.url = cleaned.trim() ? cleaned : '/';
      if (visual.blocks.length === 0) fallbackToFiles(scene, vp, 'the browser mock-up has no content', run);
      break;
    }
    case 'terminal':
      if (visual.lines.length === 0) fallbackToFiles(scene, vp, 'the terminal has no lines', run);
      break;
    case 'checklist':
      if (visual.items.length === 0) fallbackToFiles(scene, vp, 'the checklist has no items', run);
      break;
    case 'bullets':
      if (visual.items.length === 0) fallbackToFiles(scene, vp, 'the bullet list is empty', run);
      break;
    case 'summary':
      if (visual.points.length === 0) fallbackToFiles(scene, vp, 'the summary has no points', run);
      break;
    case 'title':
    case 'mission':
    case 'code':
    case 'log':
      break;
    default:
      exhaustive(visual);
  }
}
