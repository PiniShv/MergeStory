/**
 * The grounding validator. Every storyboard passes through it, whoever wrote it: the model, a
 * person or the offline generator. It checks the storyboard against what the change really
 * contains, repairs what it safely can, and reports what it cannot as short, actionable errors.
 *
 * Steps, in order: schema, secrets and personal data, language and titles, limits, evidence ids,
 * code references, narration, on-screen text, visual consistency, beat indexes.
 */
import { findEvidence } from '../analyzer/evidence.ts';
import { changedLinesAt, diffViewSpan, fitDiffRange, overlapsAnyHunk } from '../core/diff-view.ts';
import { maskPrivateReport } from '../core/secrets.ts';
import { beatHolders, groundedLines, isSimulated } from '../core/storyboard-facts.ts';
import {
  type CodeRefInput,
  STORYBOARD_LIMITS as LIMITS,
  type Scene,
  type Storyboard,
  StoryboardSchema,
  type Visual,
} from '../core/storyboard-schema.ts';
import { countWords, stripInvisible } from '../core/text.ts';
import type { ChangedFile } from '../core/types.ts';
import type { RefOutcome } from './coderef.ts';
import { addCorpusText } from './identifiers.ts';
import { Run, TextCleaner } from './run.ts';
import { joinSentences, truncateText } from './text.ts';
import type { ValidationDeps, ValidationIssue, ValidationResult } from './types.ts';
import {
  applyVisualLimits,
  checkVisualIntegrity,
  cleanVisualText,
  exhaustive,
  fallbackToFiles,
  filterVisualEvidence,
} from './visuals.ts';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

interface RawIssue {
  code: string;
  path: readonly PropertyKey[];
  message: string;
}

function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const part of path) {
    if (typeof part === 'number') out += `[${part}]`;
    else out += out ? `.${String(part)}` : String(part);
  }
  return out || 'storyboard';
}

function describeIssue(issue: RawIssue): string {
  if (issue.code === 'invalid_type' && /received undefined$/.test(issue.message)) {
    return 'is required (every field must be present; use null or [] when there is nothing to say)';
  }
  return issue.message.replace(/^Invalid input: /, '');
}

const MAX_SCHEMA_ISSUES = 40;

function reportSchemaIssues(issues: readonly RawIssue[], run: Run): void {
  for (const issue of issues.slice(0, MAX_SCHEMA_ISSUES))
    run.error(formatPath(issue.path), 'schema', describeIssue(issue));
  if (issues.length > MAX_SCHEMA_ISSUES) {
    run.error(
      'storyboard',
      'schema',
      `${issues.length - MAX_SCHEMA_ISSUES} more schema problems are not listed; fix the ones above first`,
    );
  }
}

// ---------------------------------------------------------------------------
// Secrets and personal data
// ---------------------------------------------------------------------------

/** Keys that hold ids, enum values or paths. They are matched exactly elsewhere and never masked. */
const MASK_SKIP_KEYS = new Set([
  'id',
  'type',
  'kind',
  'status',
  'role',
  'style',
  'side',
  'mode',
  'language',
  'path',
  'highlightPaths',
  'from',
  'to',
  'evidence',
  'screenshotId',
  'recordingId',
  'logId',
  'severity',
  'direction',
  'transition',
  'version',
]);

interface MaskCounters {
  secrets: number;
  emails: number;
  hidden: number;
}

function maskDeep(node: unknown, counters: MaskCounters, emails: boolean): unknown {
  if (typeof node === 'string') {
    const visible = stripInvisible(node);
    if (visible !== node) counters.hidden += 1;
    const report = maskPrivateReport(visible, { maskEmails: emails });
    // Text that is already masked matches the secret rules again. Only a real change counts.
    if (report.secretsChanged) counters.secrets += 1;
    if (report.emailsChanged) counters.emails += 1;
    return report.text;
  }
  if (Array.isArray(node)) return node.map((item) => maskDeep(item, counters, emails));
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      out[key] = MASK_SKIP_KEYS.has(key) ? value : maskDeep(value, counters, emails);
    }
    return out;
  }
  return node;
}

// ---------------------------------------------------------------------------
// Storyboard-level fixes
// ---------------------------------------------------------------------------

function trimTitle(title: string, path: string, run: Run): string {
  if (title.length <= LIMITS.maxTitleLength) return title;
  const shortened = truncateText(title, LIMITS.maxTitleLength);
  run.fix(
    path,
    `shortened from ${title.length} to ${shortened.length} characters (the limit is ${LIMITS.maxTitleLength})`,
  );
  return shortened;
}

function limitScenes(storyboard: Storyboard, run: Run): void {
  const max = LIMITS.maxScenes;
  if (storyboard.scenes.length > max) {
    // Keep the opening scenes and the closing one. The scenes in between are the easiest to lose.
    const dropped = storyboard.scenes.slice(max - 1, -1).map((scene) => scene.id);
    storyboard.scenes = [
      ...storyboard.scenes.slice(0, max - 1),
      storyboard.scenes[storyboard.scenes.length - 1]!,
    ];
    run.fix(
      'scenes',
      `dropped ${dropped.length} scene${dropped.length > 1 ? 's' : ''} (${dropped.join(', ')}) because the limit is ${max} scenes`,
    );
  }
  if (storyboard.scenes.length < LIMITS.minScenes) {
    run.error(
      'scenes',
      'too-few-scenes',
      `the storyboard has ${storyboard.scenes.length} scene${storyboard.scenes.length === 1 ? '' : 's'}; at least ${LIMITS.minScenes} are needed (for example a mission scene and a conclusion)`,
    );
  }
}

function makeSceneIdsUnique(storyboard: Storyboard, run: Run): void {
  const original = new Set(storyboard.scenes.map((scene) => scene.id.trim()).filter(Boolean));
  const used = new Set<string>();
  storyboard.scenes.forEach((scene, index) => {
    let id = scene.id.trim();
    if (!id) {
      id = `s${index + 1}`;
      while (used.has(id) || original.has(id)) id = `${id}-x`;
      run.fix(`scenes[${index}].id`, `empty id replaced with "${id}"`);
    } else if (used.has(id)) {
      let n = 2;
      while (used.has(`${id}-${n}`) || original.has(`${id}-${n}`)) n++;
      run.fix(`scenes[${index}].id`, `duplicate id "${id}" renamed to "${id}-${n}"`);
      id = `${id}-${n}`;
    }
    used.add(id);
    scene.id = id;
  });
}

// ---------------------------------------------------------------------------
// Narration
// ---------------------------------------------------------------------------

/** Remove one narration line and move the beats that pointed at it or after it. */
function removeNarrationLine(scene: Scene, index: number): void {
  scene.narration.splice(index, 1);
  const last = scene.narration.length - 1;
  for (const holder of beatHolders(scene.visual)) {
    if (holder.beat > index) holder.beat -= 1;
    else if (holder.beat === index) holder.beat = Math.max(0, Math.min(index, last));
  }
}

/** Evidence ids, uncited lines and the line limit, before any text is looked at. */
function prepareScene(scene: Scene, p: string, run: Run): void {
  const title = trimTitle(scene.title, `${p}.title`, run);
  scene.title = title;

  if (scene.narration.length === 0) {
    run.error(
      `${p}.narration`,
      'no-narration',
      'a scene needs at least one narration line that cites evidence',
    );
  }
  scene.narration.forEach((line, index) => {
    line.evidence = run.validEvidence(line.evidence, `${p}.narration[${index}].evidence`);
  });
  const uncited = scene.narration.flatMap((line, index) => (line.evidence.length === 0 ? [index] : []));
  if (scene.narration.length > 0 && uncited.length === scene.narration.length) {
    run.error(
      `${p}.narration`,
      'uncited-line',
      'no narration line cites evidence; add ids from the evidence pack (for example F1 or S2) to every line',
    );
  } else {
    for (const index of [...uncited].reverse()) {
      removeNarrationLine(scene, index);
      run.fix(`${p}.narration[${index}]`, 'removed the line because it cited no valid evidence');
      run.warn(
        `${p}.narration[${index}]`,
        'uncited-line',
        'the line cited no valid evidence id and was removed',
      );
    }
  }
  if (scene.narration.length > LIMITS.maxNarrationLinesPerScene) {
    run.fix(
      `${p}.narration`,
      `kept the first ${LIMITS.maxNarrationLinesPerScene} of ${scene.narration.length} lines (the limit is ${LIMITS.maxNarrationLinesPerScene})`,
    );
    scene.narration.length = LIMITS.maxNarrationLinesPerScene;
  }
  applyVisualLimits(scene.visual, `${p}.visual`, run);
  filterVisualEvidence(scene.visual, `${p}.visual`, run);
}

/** Claims, unknown names and the word limit, sentence by sentence. */
function cleanSceneNarration(scene: Scene, p: string, run: Run): void {
  const maxWords = LIMITS.maxWordsPerNarrationLine;
  const empty: number[] = [];
  scene.narration.forEach((line, index) => {
    const path = `${p}.narration[${index}]`;
    const { all: sentences, kept } = run.sentences(line.text, line.evidence, path);
    let shortened = false;
    while (kept.length > 1 && countWords(joinSentences(kept)) > maxWords) {
      const dropped = kept.pop()!;
      shortened = true;
      run.fix(path, `dropped the last sentence to stay within ${maxWords} words: "${dropped.slice(0, 60)}"`);
    }
    if (kept.length === 1 && countWords(kept[0]!) > maxWords) {
      run.warn(
        path,
        'line-too-long',
        `the line has ${countWords(kept[0]!)} words; keep lines under ${maxWords} words so captions stay readable`,
      );
    }
    if (kept.length !== sentences.length || shortened) line.text = joinSentences(kept);
    if (!line.text.trim()) empty.push(index);
  });
  if (empty.length === 0) return;
  if (empty.length === scene.narration.length) {
    run.error(
      `${p}.narration`,
      'no-narration',
      'every narration line was removed (unverified claims, names that are not in the change, or no text); write lines that state what the change shows',
    );
    return;
  }
  for (const index of [...empty].reverse()) {
    removeNarrationLine(scene, index);
    run.fix(`${p}.narration[${index}]`, 'removed the line because nothing was left of it');
  }
}

// ---------------------------------------------------------------------------
// Code references
// ---------------------------------------------------------------------------

const FAILURE_CODES = {
  'unknown-path': 'code-ref-unknown-path',
  sensitive: 'code-ref-sensitive',
  binary: 'code-ref-binary',
  unreadable: 'code-ref-unreadable',
  'out-of-range': 'code-ref-out-of-range',
} as const;

type RefFailureOutcome = Extract<RefOutcome, { ok: false }>;
type RefSuccessOutcome = Extract<RefOutcome, { ok: true }>;

/** Failures that mean "the file is real but these lines cannot be shown". The visual can degrade instead of failing. */
function isSoftFailure(outcome: RefFailureOutcome): boolean {
  return outcome.reason === 'unreadable' || outcome.reason === 'out-of-range';
}

/**
 * A file that cannot be read used to turn the scene into the changed-files overview while the
 * narration still walked through the code. An author can rewrite the scene, so it is an error for them.
 */
function mustFixUnreadable(outcome: RefFailureOutcome, run: Run): boolean {
  return run.authored && outcome.reason === 'unreadable';
}

function refFailureMessage(outcome: RefFailureOutcome, run: Run): string {
  return mustFixUnreadable(outcome, run)
    ? `${outcome.message}. Show a file that can be read, or use a visual without code and do not walk through the code of this file`
    : outcome.message;
}

/** The lines of a reference are on screen, so the names in them are known names. */
function recordShownLines(lines: readonly string[], ref: CodeRefInput, run: Run): void {
  addCorpusText(run.corpus, lines.slice(ref.startLine - 1, ref.endLine).join('\n'));
}

function recordRefFix(outcome: RefSuccessOutcome, path: string, run: Run): void {
  for (const note of outcome.notes) run.fix(path, note);
  recordShownLines(outcome.lines, outcome.ref, run);
}

/** A reference that may be dropped (checklist and review items). Returns the fixed reference, or null. */
async function resolveOptionalRef(ref: CodeRefInput, path: string, run: Run): Promise<CodeRefInput | null> {
  const outcome = await run.refs.resolve(ref);
  if (outcome.ok) {
    recordRefFix(outcome, path, run);
    return outcome.ref;
  }
  if (isSoftFailure(outcome)) {
    run.warn(path, FAILURE_CODES[outcome.reason], `${outcome.message}; the code reference was removed`);
    run.fix(path, 'removed the code reference');
    return null;
  }
  run.error(path, FAILURE_CODES[outcome.reason], outcome.message);
  return ref;
}

function clampFocus(
  focus: { startLine: number; endLine: number; note: string | null; beat: number }[],
  ref: Pick<CodeRefInput, 'startLine' | 'endLine'>,
  path: string,
  run: Run,
  shown = 'the code shown',
): typeof focus {
  const kept: typeof focus = [];
  focus.forEach((item, index) => {
    let start = Math.trunc(item.startLine);
    let end = Math.trunc(item.endLine);
    if (start > end) [start, end] = [end, start];
    if (end < ref.startLine || start > ref.endLine) {
      run.fix(
        `${path}[${index}]`,
        `dropped the focus range ${item.startLine}-${item.endLine} because it is outside ${shown} (${ref.startLine}-${ref.endLine})`,
      );
      return;
    }
    const clampedStart = Math.max(start, ref.startLine);
    const clampedEnd = Math.min(end, ref.endLine);
    if (clampedStart !== item.startLine || clampedEnd !== item.endLine) {
      run.fix(
        `${path}[${index}]`,
        `focus range ${item.startLine}-${item.endLine} was changed to ${clampedStart}-${clampedEnd} to fit ${shown}`,
      );
    }
    kept.push({ ...item, startLine: clampedStart, endLine: clampedEnd });
  });
  return kept;
}

type CodeVisual = Extract<Scene['visual'], { type: 'code' }>;

/** The lines a shortened range must still hold: everything that is highlighted, or else the first changed line. */
function linesToKeep(visual: CodeVisual, file: ChangedFile): [number, number] {
  const { ref, focus } = visual;
  if (focus.length > 0) {
    return [Math.min(...focus.map((f) => f.startLine)), Math.max(...focus.map((f) => f.endLine))];
  }
  const first = changedLinesAt(file, ref.side).find((n) => n >= ref.startLine && n <= ref.endLine);
  return [first ?? ref.startLine, first ?? ref.startLine];
}

/**
 * A diff view also lists the removed lines, and the screen holds at most 18 rows. A range of 18 lines
 * can need more than that. The renderer would then cut the view around the first highlight and drop
 * the others, while the narration still talks about them. So the range is shortened around the
 * highlights, or, when the highlights alone do not fit, shown as a plain snippet, which has no removed lines.
 */
function fitDiffWindow(visual: CodeVisual, file: ChangedFile, vp: string, run: Run): void {
  const { ref } = visual;
  const max = LIMITS.maxCodeLines;
  const rows = diffViewSpan(file, ref.side, ref.startLine, ref.endLine)?.length;
  if (rows === undefined || rows <= max) return;
  const keep = linesToKeep(visual, file);
  const range = `${ref.startLine}-${ref.endLine}`;
  const need = `the diff view of lines ${range} needs ${rows} rows because it shows the removed lines too, and at most ${max} fit on screen`;
  const fitted = fitDiffRange(file, ref.side, ref.startLine, ref.endLine, keep, max);
  if (run.authored) {
    // The narration was written for the range as asked. Cutting it, or dropping the removed lines,
    // leaves the voice describing code that is not on screen, so the author decides.
    run.error(
      `${vp}.ref`,
      'diff-too-tall',
      fitted
        ? `${need}. Use lines ${fitted[0]}-${fitted[1]}, which keep the highlights, and describe only lines that are on screen. Or set mode to "snippet", which shows no removed lines`
        : `${need}, and the highlights alone do not fit. Highlight fewer lines or use a shorter range. Or set mode to "snippet", which shows no removed lines, and do not describe the removed lines`,
    );
    return;
  }
  if (fitted) {
    visual.ref = { ...ref, startLine: fitted[0], endLine: fitted[1] };
    run.fix(`${vp}.ref`, `shortened the range from ${range} to ${fitted[0]}-${fitted[1]}: ${need}`);
    run.warn(
      `${vp}.ref`,
      'diff-too-tall',
      `${need}; the range was shortened so the highlights stay on screen`,
    );
    return;
  }
  visual.mode = 'snippet';
  run.fix(`${vp}.mode`, `changed "diff" to "snippet": ${need}`);
  run.warn(
    `${vp}.mode`,
    'diff-too-tall',
    `${need}; the highlights do not fit in fewer rows, so it is shown as a snippet instead`,
  );
}

type VisualOf<T extends Visual['type']> = Extract<Visual, { type: T }>;

async function resolveCodeRefs(scene: Scene, visual: VisualOf<'code'>, vp: string, run: Run): Promise<void> {
  const first = visual.focus[0];
  const centre = first
    ? Math.round((Math.min(first.startLine, first.endLine) + Math.max(first.startLine, first.endLine)) / 2)
    : null;
  const outcome = await run.refs.resolve(visual.ref, { focusCentre: centre });
  if (!outcome.ok) {
    if (isSoftFailure(outcome) && !mustFixUnreadable(outcome, run))
      fallbackToFiles(scene, vp, outcome.message, run, [visual.ref.path], FAILURE_CODES[outcome.reason]);
    else run.error(`${vp}.ref`, FAILURE_CODES[outcome.reason], refFailureMessage(outcome, run));
    return;
  }
  for (const note of outcome.notes) run.fix(`${vp}.ref`, note);
  visual.ref = outcome.ref;
  visual.focus = clampFocus(visual.focus, outcome.ref, `${vp}.focus`, run);
  if (
    visual.mode === 'diff' &&
    !overlapsAnyHunk(outcome.file, outcome.ref.side, outcome.ref.startLine, outcome.ref.endLine)
  ) {
    visual.mode = 'snippet';
    run.fix(
      `${vp}.mode`,
      `changed "diff" to "snippet" because lines ${outcome.ref.startLine}-${outcome.ref.endLine} of ${outcome.ref.path} are not in a changed hunk`,
    );
  }
  if (visual.mode === 'diff') fitDiffWindow(visual, outcome.file, vp, run);
  recordShownLines(outcome.lines, visual.ref, run);
}

/**
 * Put the lines of a log visual in order and inside the log, and no more than the screen holds. Every
 * repair lands on a range that passes the same check again, so a second validation changes nothing.
 */
function resolveLog(visual: VisualOf<'log'>, vp: string, run: Run): void {
  const log = run.logs.get(visual.logId);
  if (!log) {
    const known = [...run.logs.keys()];
    run.error(
      `${vp}.logId`,
      'log-unknown',
      `"${visual.logId}" is not a supplied log; ${known.length ? `use one of ${known.join(', ')}` : 'no logs were supplied, so use another visual'}`,
    );
    return;
  }
  const total = log.lines.length;
  let start = Math.trunc(visual.startLine);
  let end = Math.trunc(visual.endLine);
  if (start > end) {
    [start, end] = [end, start];
    run.fix(vp, 'put startLine and endLine in order');
  }
  const asked = `${start} to ${end}`;
  if (end < 1 || start > total) {
    run.error(
      `${vp}.startLine`,
      'log-range-out-of-range',
      `lines ${asked} are outside the log "${log.id}", which has ${total} lines; choose lines inside it`,
    );
    return;
  }
  if (start < 1 || end > total) {
    start = Math.max(start, 1);
    end = Math.min(end, total);
    run.warn(
      `${vp}.startLine`,
      'log-range-out-of-range',
      `lines ${asked} reach outside the log "${log.id}", which has ${total} lines; they were cut to fit`,
    );
    run.fix(vp, `cut the lines to ${start} to ${end}, inside the log`);
  }
  const max = LIMITS.maxLogLines;
  if (end - start + 1 > max) {
    run.warn(
      `${vp}.endLine`,
      'log-too-long',
      `a scene shows at most ${max} lines of a log; lines ${start} to ${end} were shortened`,
    );
    run.fix(
      vp,
      `shortened the lines from the end to ${start} to ${start + max - 1} (the limit is ${max} lines)`,
    );
    end = start + max - 1;
  }
  visual.startLine = start;
  visual.endLine = end;
  visual.focus = clampFocus(
    visual.focus,
    { startLine: start, endLine: end },
    `${vp}.focus`,
    run,
    'the lines shown',
  );
  // The lines are on screen, so the names in them are known names.
  addCorpusText(run.corpus, log.lines.slice(start - 1, end).join('\n'));
}

async function resolveBeforeAfterRefs(
  scene: Scene,
  visual: VisualOf<'before-after'>,
  vp: string,
  run: Run,
): Promise<void> {
  let soft: RefFailureOutcome | null = null;
  const paths: string[] = [];
  for (const name of ['before', 'after'] as const) {
    const panel = visual[name];
    if (panel.kind !== 'code') continue;
    const panelPath = `${vp}.${name}`;
    if (!panel.codeRef) {
      run.error(
        `${panelPath}.codeRef`,
        'code-ref-missing',
        'a code panel needs a codeRef (path, side and line range)',
      );
      continue;
    }
    const outcome = await run.refs.resolve(panel.codeRef);
    if (!outcome.ok) {
      if (isSoftFailure(outcome) && !mustFixUnreadable(outcome, run)) {
        soft ??= outcome;
        paths.push(panel.codeRef.path);
      } else {
        run.error(`${panelPath}.codeRef`, FAILURE_CODES[outcome.reason], refFailureMessage(outcome, run));
      }
      continue;
    }
    recordRefFix(outcome, `${panelPath}.codeRef`, run);
    panel.codeRef = outcome.ref;
  }
  if (soft) fallbackToFiles(scene, vp, soft.message, run, paths, FAILURE_CODES[soft.reason]);
}

async function resolveChecklistRefs(visual: VisualOf<'checklist'>, vp: string, run: Run): Promise<void> {
  for (const [index, item] of visual.items.entries()) {
    if (item.ref) item.ref = await resolveOptionalRef(item.ref, `${vp}.items[${index}].ref`, run);
  }
}

async function resolveSceneRefs(scene: Scene, p: string, run: Run): Promise<void> {
  const visual = scene.visual;
  const vp = `${p}.visual`;
  switch (visual.type) {
    case 'code':
      return resolveCodeRefs(scene, visual, vp, run);
    case 'log':
      return resolveLog(visual, vp, run);
    case 'before-after':
      return resolveBeforeAfterRefs(scene, visual, vp, run);
    case 'checklist':
      return resolveChecklistRefs(visual, vp, run);
    case 'title':
    case 'mission':
    case 'files':
    case 'architecture':
    case 'flow':
    case 'terminal':
    case 'browser':
    case 'bullets':
    case 'screenshot':
    case 'recording':
    case 'repro':
    case 'summary':
      return;
    default:
      return exhaustive(visual);
  }
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

function narrationEvidence(scene: Scene): string[] {
  return [...new Set(scene.narration.flatMap((line) => line.evidence))];
}

function clampBeats(scene: Scene, p: string, run: Run): void {
  const last = scene.narration.length - 1;
  if (last < 0) return;
  let changed = 0;
  for (const holder of beatHolders(scene.visual)) {
    const clamped = Math.max(0, Math.min(last, holder.beat));
    if (clamped !== holder.beat) {
      holder.beat = clamped;
      changed += 1;
    }
  }
  if (changed > 0) {
    run.fix(
      `${p}.visual`,
      `${changed} beat index${changed > 1 ? 'es' : ''} pointed outside the ${scene.narration.length} narration line${scene.narration.length > 1 ? 's' : ''} and ${changed > 1 ? 'were' : 'was'} clamped`,
    );
  }
}

function checkSimulatedEvidence(scene: Scene, p: string, run: Run): void {
  if (!isSimulated(scene.visual)) return;
  const backed = narrationEvidence(scene).some((id) => {
    const kind = findEvidence(run.evidence, id)?.kind;
    return kind === 'file' || kind === 'hunk' || kind === 'symbol';
  });
  if (!backed) {
    run.error(
      `${p}.visual`,
      'simulated-unbacked',
      `a simulated ${scene.visual.type} needs narration that cites a file, hunk or symbol id (for example F2.H1 or S3) showing that this behaviour exists in the change`,
    );
  }
}

/** The most characters a repaired kicker may have: it is one line of small, spaced capitals. */
const MAX_KICKER_LENGTH = 60;

/**
 * A change in several repositories: the first title card must name every pull request (its
 * repository name and its number). When it does not, say so, and set the kicker to the names of
 * all the changes if they fit.
 */
function checkTitleNamesEverySource(storyboard: Storyboard, run: Run): void {
  if (!run.parts) return;
  const index = storyboard.scenes.findIndex((scene) => scene.visual.type === 'title');
  const visual = storyboard.scenes[index]?.visual;
  if (visual?.type !== 'title') return;
  const text = [visual.kicker, visual.heading, visual.subheading, ...visual.chips].join('\n').toLowerCase();
  const missing = run.parts.filter(
    (part) =>
      part.pr &&
      !(text.includes(part.repo.name.toLowerCase()) && new RegExp(`#${part.pr.number}(?!\\d)`).test(text)),
  );
  if (missing.length === 0) return;
  const path = `scenes[${index}].visual`;
  const names = missing.map((part) => `${part.repo.name} #${part.pr?.number}`).join(', ');
  run.warn(path, 'title-missing-source', `the title card does not name every pull request: ${names}`);
  if (run.changeLabel !== null && run.changeLabel.length <= MAX_KICKER_LENGTH) {
    visual.kicker = run.changeLabel;
    run.fix(`${path}.kicker`, `set to "${run.changeLabel}" so that the title names every pull request`);
  }
}

async function validateParsed(parsed: Storyboard, run: Run): Promise<Storyboard> {
  // Secrets and personal data first, so every later step sees the masked text.
  const counters: MaskCounters = { secrets: 0, emails: 0, hidden: 0 };
  const storyboard = maskDeep(parsed, counters, run.config.privacy.maskEmails) as Storyboard;
  if (counters.secrets > 0) {
    run.fix(
      'storyboard',
      `masked secret-like text in ${counters.secrets} text field${counters.secrets > 1 ? 's' : ''}`,
    );
    run.warn(
      'storyboard',
      'secret-masked',
      `${counters.secrets} text field${counters.secrets > 1 ? 's' : ''} contained text that looks like a secret and was masked`,
    );
  }
  if (counters.emails > 0) {
    run.fix(
      'storyboard',
      `masked e-mail addresses in ${counters.emails} text field${counters.emails > 1 ? 's' : ''}`,
    );
  }
  if (counters.hidden > 0) {
    run.fix(
      'storyboard',
      `removed hidden control characters from ${counters.hidden} text field${counters.hidden > 1 ? 's' : ''}`,
    );
  }

  if (storyboard.language !== run.config.language) {
    if (storyboard.language.toLowerCase() !== run.config.language.toLowerCase()) {
      run.warn(
        'language',
        'language-mismatch',
        `the storyboard says "${storyboard.language}" but the configured language is "${run.config.language}"`,
      );
    }
    run.fix('language', `set from "${storyboard.language}" to "${run.config.language}"`);
    storyboard.language = run.config.language;
  }
  if (!run.offline && !/^en(?:[-_]|$)/i.test(run.config.language)) {
    run.warn(
      'language',
      'claims-english-only',
      `MergeStory finds unprovable claims ("all tests pass", "CI is green", speed figures) only in English text, so none were checked in "${run.config.language}". Read the narration for such claims before you publish.`,
    );
  }
  storyboard.title = trimTitle(storyboard.title, 'title', run);

  limitScenes(storyboard, run);
  makeSceneIdsUnique(storyboard, run);
  for (const [index, scene] of storyboard.scenes.entries()) prepareScene(scene, `scenes[${index}]`, run);

  // Code references come before the text checks: the lines on screen count as known names.
  for (const [index, scene] of storyboard.scenes.entries())
    await resolveSceneRefs(scene, `scenes[${index}]`, run);
  if (storyboard.reviewChecklist.length > LIMITS.maxChecklistItems) {
    run.fix(
      'reviewChecklist',
      `kept the first ${LIMITS.maxChecklistItems} of ${storyboard.reviewChecklist.length} items (the limit is ${LIMITS.maxChecklistItems})`,
    );
    storyboard.reviewChecklist.length = LIMITS.maxChecklistItems;
  }
  for (const [index, item] of storyboard.reviewChecklist.entries()) {
    const path = `reviewChecklist[${index}]`;
    item.evidence = run.validEvidence(item.evidence, `${path}.evidence`);
    if (item.evidence.length === 0)
      run.warn(path, 'no-evidence', `item "${item.title}" cites no evidence (for example R1)`);
    if (item.ref) item.ref = await resolveOptionalRef(item.ref, `${path}.ref`, run);
  }

  for (const [index, scene] of storyboard.scenes.entries())
    cleanSceneNarration(scene, `scenes[${index}]`, run);

  for (const [index, scene] of storyboard.scenes.entries()) {
    const p = `scenes[${index}]`;
    const cleaner = new TextCleaner(run, narrationEvidence(scene));
    scene.title = cleaner.required(scene.title, `${p}.title`);
    // The description is not shown, so what is wrong with it is removed and nothing is demanded back.
    scene.visualDescription = cleaner.clean(scene.visualDescription, `${p}.visualDescription`);
    cleanVisualText(scene.visual, `${p}.visual`, cleaner);
    checkVisualIntegrity(scene, p, run, cleaner);
    checkSimulatedEvidence(scene, p, run);
    clampBeats(scene, p, run);
  }
  checkTitleNamesEverySource(storyboard, run);

  const everything = new TextCleaner(run, [...new Set(storyboard.scenes.flatMap(narrationEvidence))]);
  storyboard.title = everything.required(storyboard.title, 'title');
  storyboard.summary = everything.required(storyboard.summary, 'summary');
  storyboard.reviewChecklist = everything.keepTitled(
    storyboard.reviewChecklist,
    'title',
    'reviewChecklist',
    'text',
  );
  // The doubts are shown on the page next to the video, so they get the same checks as the other text.
  storyboard.uncertainties = everything.list(storyboard.uncertainties, 'uncertainties');

  return storyboard;
}

/** The result for a storyboard that could not be checked at all: only errors, nothing fixed or grounded. */
export function failedResult(errors: ValidationIssue[]): ValidationResult {
  return { storyboard: null, errors, warnings: [], fixes: [], groundedClaims: 0 };
}

/**
 * Validate a storyboard against the change. Never throws for a bad storyboard: problems come back
 * as errors, and `storyboard` is null while any error remains.
 */
export async function validateStoryboard(input: unknown, deps: ValidationDeps): Promise<ValidationResult> {
  let run: Run | null = null;
  let storyboard: Storyboard | null = null;
  try {
    run = new Run(deps);
    const parsed = StoryboardSchema.safeParse(input);
    if (parsed.success) storyboard = await validateParsed(parsed.data, run);
    else reportSchemaIssues(parsed.error.issues, run);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (run)
      run.error(
        'storyboard',
        'validator-failed',
        `the validator stopped on an unexpected problem: ${message}`,
      );
    else return failedResult([{ path: 'storyboard', code: 'validator-failed', message }]);
    storyboard = null;
  }
  const usable = run !== null && run.errors.length === 0 && storyboard !== null ? storyboard : null;
  return {
    storyboard: usable,
    errors: run?.errors ?? [],
    warnings: run?.warnings ?? [],
    fixes: run?.fixes ?? [],
    groundedClaims: usable ? groundedLines(usable) : 0,
  };
}
