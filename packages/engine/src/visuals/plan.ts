/**
 * Render plan builder: turns a validated storyboard, the timeline and the repository into a
 * self-contained RenderPlan. Code is read from the repository here, never taken from the storyboard,
 * and every string that reaches the screen is masked first.
 */
import { type Config, QUALITY_PRESETS } from '../core/config.ts';
import type { RunContext } from '../core/context.ts';
import { assertNotAborted, MergeStoryError } from '../core/errors.ts';
import type {
  BadgeKind,
  BeforeAfterResolved,
  ChecklistResolved,
  CodeResolved,
  FilesResolved,
  PlannedScene,
  RenderPlan,
  ResolvedCode,
  ResolvedImage,
  ResolvedPanel,
  ResolvedVisual,
} from '../core/render-plan.ts';
import { maskPrivateReport } from '../core/secrets.ts';
import { BACKING_EVIDENCE_KINDS } from '../core/storyboard-facts.ts';
import {
  type CodeRefInput,
  type Panel,
  type Scene,
  STORYBOARD_LIMITS,
  type Storyboard,
  type Visual,
} from '../core/storyboard-schema.ts';
import { collapseLineRange } from '../core/text.ts';
import type {
  Analysis,
  CaptionCue,
  ChangeSet,
  ContextInputs,
  EvidenceItem,
  RepoInfo,
  RepoReader,
  Timeline,
  TimelineScene,
} from '../core/types.ts';
import { ENGINE_VERSION } from '../version.ts';
import { CodeResolver, type FocusRange } from './code.ts';
import { loadScreenshot } from './image.ts';
import { layoutArchitecture } from './layout.ts';

export interface BuildPlanInput {
  storyboard: Storyboard;
  timeline: Timeline;
  cues: CaptionCue[];
  changeSet: ChangeSet;
  analysis: Analysis;
  inputs: ContextInputs;
  reader: RepoReader;
  config: Config;
}

/** Rows shown in the changed-files visual; the rest is summarised as a count. */
export const MAX_FILE_ROWS = 16;
const MAX_REFS = 3;

export const OUTRO_TAGLINE = 'Every change has a story.';
export const OUTRO_DISCLAIMER = 'This video explains the change. It does not replace code review.';

// ---------------------------------------------------------------------------
// Masking of on-screen text
// ---------------------------------------------------------------------------

interface Scrubber {
  text(value: string): string;
  maybe(value: string | null): string | null;
  /** How many things were masked so far. */
  count(): number;
}

/** Secrets are always masked; e-mail addresses too unless privacy.maskEmails is off. */
function createScrubber(maskEmail: boolean): Scrubber {
  let masked = 0;
  const text = (value: string): string => {
    const report = maskPrivateReport(value, { maskEmails: maskEmail });
    masked += report.secrets + (report.emailsChanged ? 1 : 0);
    return report.text;
  };
  return { text, maybe: (value) => (value === null ? null : text(value)), count: () => masked };
}

const beatIndex = (value: number): number => (Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0);

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

function lastSegment(value: string): string {
  const parts = value.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/** "owner/name", or the repository name. Never a filesystem path. */
export function repoLabelFor(repo: RepoInfo): string {
  const name = lastSegment(repo.name) || 'repository';
  const owner = repo.owner ? lastSegment(repo.owner) : '';
  return owner ? `${owner}/${name}` : name;
}

/** "PR #42", or the head branch for a local run. */
export function changeLabelFor(changeSet: ChangeSet): string {
  if (changeSet.pr) return `PR #${changeSet.pr.number}`;
  const ref = changeSet.head.ref.trim().replace(/^refs\/(?:heads|remotes\/[^/]+)\//, '');
  if (/^[0-9a-f]{40}$/i.test(ref)) return ref.slice(0, 7);
  return ref || 'working changes';
}

/** "src/a.ts:8-12" for a code reference. A path is on-screen text too, so it is masked. */
const codeLabel = (ref: CodeRefInput, scrub: Scrubber): string =>
  scrub.text(collapseLineRange(`${ref.path}:${ref.startLine}-${ref.endLine}`));

// ---------------------------------------------------------------------------
// Visual resolution
// ---------------------------------------------------------------------------

interface Environment {
  config: Config;
  changeSet: ChangeSet;
  analysis: Analysis;
  inputs: ContextInputs;
  resolver: CodeResolver;
  images: Map<string, Promise<ResolvedImage>>;
}

interface ResolvedScene {
  visual: ResolvedVisual;
  /** Code in this scene had secrets masked. */
  codeMasked: boolean;
  /** Labels of the scene's own code references, shown before cited evidence. */
  codeLabels: string[];
  simulated: string | null;
  actual: boolean;
}

function screenshotFor(env: Environment, id: string): Promise<ResolvedImage> {
  let pending = env.images.get(id);
  if (!pending) {
    const input = env.inputs.screenshots.find((s) => s.id === id);
    if (!input) {
      throw new MergeStoryError('STORYBOARD_INVALID', `The storyboard uses an unknown screenshot id: ${id}`, {
        hint: 'Screenshots must be passed with the run context; ids look like SS1.',
      });
    }
    pending = loadScreenshot(input.path);
    env.images.set(id, pending);
  }
  return pending;
}

type FilesVisual = Extract<Visual, { type: 'files' }>;

function resolveFiles(visual: FilesVisual, env: Environment, scrub: Scrubber): FilesResolved {
  const { changeSet, analysis } = env;
  const insights = new Map(analysis.files.map((f) => [f.fileId, f]));
  const components = new Map<string, string>();
  for (const component of analysis.components) {
    for (const fileId of component.fileIds) components.set(fileId, component.name);
  }
  const highlight = new Set(visual.highlightPaths);
  const entries = changeSet.files.map((file) => {
    const insight = insights.get(file.id);
    return {
      file,
      component: components.get(file.id) ?? 'Other',
      highlighted: highlight.has(file.path) || (file.oldPath !== null && highlight.has(file.oldPath)),
      trivial: insight?.trivial ?? false,
      importance: insight?.importance ?? 0,
    };
  });
  entries.sort(
    (a, b) =>
      Number(b.highlighted) - Number(a.highlighted) ||
      Number(a.trivial) - Number(b.trivial) ||
      b.importance - a.importance ||
      b.file.additions + b.file.deletions - (a.file.additions + a.file.deletions) ||
      a.file.path.localeCompare(b.file.path),
  );
  const shown = entries.slice(0, MAX_FILE_ROWS);

  // Groups appear in the order of their best-ranked file; "Other" is always last.
  const groups = new Map<string, FilesResolved['groups'][number]['files']>();
  for (const entry of shown) {
    const rows = groups.get(entry.component) ?? [];
    rows.push({
      path: scrub.text(entry.file.path),
      status: entry.file.status,
      additions: entry.file.additions,
      deletions: entry.file.deletions,
      highlighted: entry.highlighted,
      trivial: entry.trivial,
    });
    groups.set(entry.component, rows);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => Number(a === 'Other') - Number(b === 'Other'));
  const totals = { ...changeSet.stats };
  return {
    type: 'files',
    caption: scrub.maybe(visual.caption),
    totals,
    groups: ordered.map(([component, files]) => ({ component: scrub.text(component), files })),
    hiddenCount: Math.max(0, totals.files - shown.length),
  };
}

function checklistRef(ref: CodeRefInput | null, scrub: Scrubber): string | null {
  return ref ? codeLabel(ref, scrub) : null;
}

/** Read the lines a code reference points at. The path in the header of the code view is masked too. */
async function resolveCodeRef(
  ref: CodeRefInput,
  mode: 'snippet' | 'diff',
  focus: readonly FocusRange[],
  env: Environment,
  scrub: Scrubber,
): Promise<ResolvedCode> {
  const code = await env.resolver.resolve(ref, mode, focus);
  return { ...code, path: scrub.text(code.path) };
}

/** Keep focus ranges that fall on lines that are actually shown, clamped to those lines. */
function clampFocus(focus: CodeResolved['focus'], code: CodeResolved['code']): CodeResolved['focus'] {
  const numbers = code.lines
    .map((line) => (code.side === 'head' ? line.newNumber : line.oldNumber))
    .filter((n): n is number => n !== null);
  if (numbers.length === 0) return [];
  const low = Math.min(...numbers);
  const high = Math.max(...numbers);
  const out: CodeResolved['focus'] = [];
  for (const range of focus) {
    const startLine = Math.max(range.startLine, low);
    const endLine = Math.min(range.endLine, high);
    if (startLine > endLine) continue;
    out.push({ ...range, startLine, endLine });
  }
  return out;
}

async function resolvePanel(
  panel: Panel,
  env: Environment,
  scrub: Scrubber,
): Promise<{ panel: ResolvedPanel; masked: boolean }> {
  const label = scrub.text(panel.label);
  switch (panel.kind) {
    case 'code': {
      if (!panel.codeRef) {
        throw new MergeStoryError(
          'STORYBOARD_INVALID',
          `The "${panel.label}" panel is a code panel without a code reference.`,
          {
            hint: 'Give the panel a codeRef, or change its kind.',
          },
        );
      }
      const code = await resolveCodeRef(panel.codeRef, 'snippet', [], env, scrub);
      return { panel: { label, kind: 'code', code }, masked: code.masked };
    }
    case 'bullets':
      return {
        panel: { label, kind: 'bullets', bullets: panel.bullets.map((b) => scrub.text(b)) },
        masked: false,
      };
    case 'terminal':
      return {
        panel: {
          label,
          kind: 'terminal',
          terminal: panel.terminal.map((l) => ({
            kind: l.kind,
            text: scrub.text(l.text),
            beat: beatIndex(l.beat),
          })),
        },
        masked: false,
      };
    case 'screenshot': {
      if (!panel.screenshotId) {
        throw new MergeStoryError(
          'STORYBOARD_INVALID',
          `The "${panel.label}" panel is a screenshot panel without a screenshot id.`,
          {
            hint: 'Give the panel a screenshotId (for example SS1), or change its kind.',
          },
        );
      }
      const image = await screenshotFor(env, panel.screenshotId);
      return { panel: { label, kind: 'screenshot', image }, masked: false };
    }
    default:
      panel.kind satisfies never;
      throw new MergeStoryError('INTERNAL', 'A panel has an unknown kind.');
  }
}

async function resolveVisual(visual: Visual, env: Environment, scrub: Scrubber): Promise<ResolvedScene> {
  const base = {
    codeMasked: false,
    codeLabels: [] as string[],
    simulated: null as string | null,
    actual: false,
  };
  switch (visual.type) {
    case 'title':
      return {
        ...base,
        visual: {
          type: 'title',
          kicker: scrub.maybe(visual.kicker),
          heading: scrub.text(visual.heading),
          subheading: scrub.maybe(visual.subheading),
          chips: visual.chips.slice(0, STORYBOARD_LIMITS.maxChips).map((c) => scrub.text(c)),
        },
      };
    case 'mission':
      return {
        ...base,
        visual: {
          type: 'mission',
          problem: scrub.text(visual.problem),
          goal: scrub.text(visual.goal),
          points: visual.points.map((p) => ({ text: scrub.text(p.text), beat: beatIndex(p.beat) })),
        },
      };
    case 'files':
      return { ...base, visual: resolveFiles(visual, env, scrub) };
    case 'architecture': {
      const clean = {
        ...visual,
        nodes: visual.nodes.map((n) => ({
          ...n,
          label: scrub.text(n.label),
          detail: scrub.maybe(n.detail),
          beat: beatIndex(n.beat),
        })),
        edges: visual.edges.map((e) => ({ ...e, label: scrub.maybe(e.label), beat: beatIndex(e.beat) })),
      };
      return {
        ...base,
        visual: { type: 'architecture', ...layoutArchitecture(clean) },
      };
    }
    case 'flow':
      return {
        ...base,
        visual: {
          type: 'flow',
          actors: visual.actors.map((a) => ({ id: a.id, label: scrub.text(a.label), kind: a.kind })),
          steps: visual.steps.map((s) => ({
            from: s.from,
            to: s.to,
            label: scrub.text(s.label),
            detail: scrub.maybe(s.detail),
            kind: s.kind,
            beat: beatIndex(s.beat),
          })),
        },
      };
    case 'code': {
      const focusIn = visual.focus.map((f) => ({ startLine: f.startLine, endLine: f.endLine }));
      const code = await resolveCodeRef(visual.ref, visual.mode, focusIn, env, scrub);
      const resolvedFocus = clampFocus(
        visual.focus.map((f) => ({
          startLine: f.startLine,
          endLine: f.endLine,
          note: scrub.maybe(f.note),
          beat: beatIndex(f.beat),
        })),
        code,
      );
      const hasChanges = code.lines.some((l) => l.kind !== 'ctx');
      return {
        ...base,
        codeMasked: code.masked,
        codeLabels: [codeLabel(visual.ref, scrub)],
        visual: {
          type: 'code',
          mode: visual.mode === 'diff' && hasChanges ? 'diff' : 'snippet',
          code,
          focus: resolvedFocus,
          caption: scrub.maybe(visual.caption),
        },
      };
    }
    case 'before-after': {
      const before = await resolvePanel(visual.before, env, scrub);
      const after = await resolvePanel(visual.after, env, scrub);
      const panels = [after, before];
      const resolved: BeforeAfterResolved = {
        type: 'before-after',
        before: before.panel,
        after: after.panel,
        caption: scrub.maybe(visual.caption),
      };
      return {
        ...base,
        visual: resolved,
        codeMasked: panels.some((p) => p.masked),
        codeLabels: [visual.after, visual.before].flatMap((p) =>
          p.kind === 'code' && p.codeRef ? [codeLabel(p.codeRef, scrub)] : [],
        ),
        simulated: panels.some((p) => p.panel.kind === 'terminal') ? 'Simulated output' : null,
        actual: panels.some((p) => p.panel.kind === 'screenshot'),
      };
    }
    case 'terminal':
      return {
        ...base,
        simulated: 'Simulated output',
        visual: {
          type: 'terminal',
          title: scrub.text(visual.title),
          lines: visual.lines.map((l) => ({
            kind: l.kind,
            text: scrub.text(l.text),
            beat: beatIndex(l.beat),
          })),
        },
      };
    case 'browser':
      return {
        ...base,
        simulated: 'Simulated screen',
        visual: {
          type: 'browser',
          url: scrub.text(visual.url),
          pageTitle: scrub.text(visual.pageTitle),
          blocks: visual.blocks.map((b) => ({
            kind: b.kind,
            text: scrub.text(b.text),
            items: b.items.map((i) => scrub.text(i)),
            emphasis: b.emphasis,
            beat: beatIndex(b.beat),
          })),
        },
      };
    case 'checklist': {
      const resolved: ChecklistResolved = {
        type: 'checklist',
        items: visual.items.map((item) => ({
          title: scrub.text(item.title),
          detail: scrub.text(item.detail),
          severity: item.severity,
          refLabel: checklistRef(item.ref, scrub),
          beat: beatIndex(item.beat),
        })),
      };
      return { ...base, visual: resolved };
    }
    case 'bullets':
      return {
        ...base,
        visual: {
          type: 'bullets',
          heading: scrub.maybe(visual.heading),
          items: visual.items.map((i) => ({ text: scrub.text(i.text), beat: beatIndex(i.beat) })),
        },
      };
    case 'screenshot':
      return {
        ...base,
        actual: true,
        visual: {
          type: 'screenshot',
          image: await screenshotFor(env, visual.screenshotId),
          caption: scrub.maybe(visual.caption),
        },
      };
    case 'summary':
      return {
        ...base,
        visual: {
          type: 'summary',
          points: visual.points.map((p) => ({ text: scrub.text(p.text), beat: beatIndex(p.beat) })),
          closing: scrub.maybe(visual.closing),
        },
      };
    default:
      visual satisfies never;
      throw new MergeStoryError('INTERNAL', 'A scene has an unknown visual type.');
  }
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

/** Evidence ids cited by a scene: narration first, then the ids attached to visual elements. */
function citedEvidence(scene: Scene): string[] {
  const ids = scene.narration.flatMap((line) => line.evidence);
  const visual = scene.visual;
  if (visual.type === 'architecture') ids.push(...visual.nodes.flatMap((n) => n.evidence));
  else if (visual.type === 'flow') ids.push(...visual.steps.flatMap((s) => s.evidence));
  else if (visual.type === 'checklist') ids.push(...visual.items.flatMap((i) => i.evidence));
  return ids;
}

function sceneRefs(scene: Scene, codeLabels: string[], evidence: Map<string, EvidenceItem>): string[] {
  const refs: string[] = [];
  const add = (label: string): void => {
    if (refs.length < MAX_REFS && label && !refs.includes(label)) refs.push(label);
  };
  for (const label of codeLabels) add(label);
  for (const id of citedEvidence(scene)) {
    const item = evidence.get(id);
    if (item && BACKING_EVIDENCE_KINDS.includes(item.kind)) add(collapseLineRange(item.label));
  }
  return refs;
}

function sceneBadges(scene: Scene, resolved: ResolvedScene, masked: boolean): PlannedScene['badges'] {
  const badges: { kind: BadgeKind; text: string }[] = [];
  if (resolved.simulated) badges.push({ kind: 'simulated', text: resolved.simulated });
  if (resolved.actual) badges.push({ kind: 'actual', text: 'Actual screenshot' });
  if (masked) badges.push({ kind: 'masked', text: 'Sensitive data masked' });
  if (scene.narration.some((line) => line.evidence.some((id) => /^T\d+$/.test(id)))) {
    badges.push({ kind: 'reported', text: 'Reported results' });
  }
  return badges;
}

async function planScene(
  scene: Scene,
  timing: TimelineScene,
  env: Environment,
  evidence: Map<string, EvidenceItem>,
): Promise<PlannedScene> {
  const scrub = createScrubber(env.config.privacy.maskEmails);
  const resolved = await resolveVisual(scene.visual, env, scrub);
  const beats = timing.beats.map((beat) => ({
    index: beat.index,
    startSec: beat.startSec,
    durationSec: beat.durationSec,
    text: scrub.text(scene.narration[beat.index]?.text ?? ''),
  }));
  const masked = resolved.codeMasked || scrub.count() > 0;
  return {
    id: scene.id,
    role: scene.role,
    title: scrub.text(scene.title),
    startSec: timing.startSec,
    durationSec: timing.durationSec,
    transitionIn: {
      type: timing.transitionSec > 0 ? scene.transition : 'none',
      durationSec: timing.transitionSec,
    },
    beats,
    visual: resolved.visual,
    refs: sceneRefs(scene, resolved.codeLabels, evidence),
    badges: sceneBadges(scene, resolved, masked),
  };
}

/**
 * Build the render plan: quality preset, theme, labels, captions, chapters, one planned scene per
 * storyboard scene (code, diagrams and screenshots resolved) and the end card.
 */
export async function buildRenderPlan(input: BuildPlanInput, ctx: RunContext): Promise<RenderPlan> {
  const { storyboard, timeline, changeSet, analysis, inputs, reader, config } = input;
  const preset = QUALITY_PRESETS[config.quality];
  const env: Environment = {
    config,
    changeSet,
    analysis,
    inputs,
    resolver: new CodeResolver({ reader, changeSet, config, logger: ctx.logger }),
    images: new Map(),
  };
  const evidence = new Map(analysis.evidence.map((item) => [item.id, item]));
  const metaScrub = createScrubber(config.privacy.maskEmails);

  const scenes: PlannedScene[] = [];
  for (const [index, scene] of storyboard.scenes.entries()) {
    assertNotAborted(ctx.signal);
    const timing = timeline.scenes.find((t) => t.sceneId === scene.id) ?? timeline.scenes[index];
    if (!timing) {
      throw new MergeStoryError('INTERNAL', `The timeline has no entry for scene "${scene.id}".`, {
        hint: 'Build the timeline from the same storyboard that is used for the plan.',
      });
    }
    scenes.push(await planScene(scene, timing, env, evidence));
  }

  const repoLabel = metaScrub.text(repoLabelFor(changeSet.repo));
  const changeLabel = metaScrub.text(changeLabelFor(changeSet));
  const headShort = changeSet.head.sha.slice(0, 7);
  const plan: RenderPlan = {
    version: 1,
    width: preset.width,
    height: preset.height,
    fps: preset.fps,
    durationSec: timeline.durationSec,
    theme: config.theme,
    meta: {
      title: metaScrub.text(storyboard.title),
      repoLabel,
      changeLabel,
      headShort,
      stats: { ...changeSet.stats },
      engineVersion: ENGINE_VERSION,
    },
    captions: {
      enabled: config.captions,
      cues: input.cues
        .filter((cue) => cue.endSec > cue.startSec && cue.text.trim() !== '')
        .map((cue) => ({ startSec: cue.startSec, endSec: cue.endSec, text: metaScrub.text(cue.text) })),
    },
    chapters: scenes.map((scene) => ({ title: scene.title, startSec: scene.startSec })),
    scenes,
    outro: {
      startSec: timeline.outro.startSec,
      durationSec: timeline.outro.durationSec,
      tagline: OUTRO_TAGLINE,
      lines: [`${repoLabel} · ${changeLabel}`, `Commit ${headShort}`, OUTRO_DISCLAIMER],
    },
  };
  ctx.logger.debug('Render plan built', {
    scenes: scenes.length,
    durationSec: plan.durationSec,
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
  });
  return plan;
}
