/** Rules that depend on the visual type: size limits, evidence ids, on-screen text and internal consistency. */
import { STORYBOARD_LIMITS as LIMITS, type Scene, type Visual } from '../core/storyboard-schema.ts';
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
    case 'files':
    case 'code':
    case 'screenshot':
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
    case 'summary':
      break;
    default:
      exhaustive(visual);
  }
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
      visual.caption = cleaner.optional(visual.caption, `${p}.caption`);
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
          `dropped "${path}" because it is not a changed file that can be shown`,
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
      break;
    }
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
      break;
    default:
      exhaustive(visual);
  }
}
