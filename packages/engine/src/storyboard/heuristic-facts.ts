/**
 * Facts for the offline narration, each taken from data the analysis already has: values in risk
 * details, dependency changes, test files, the names of changed symbols, and statements by the
 * author. Nothing here says more than the data does. Author statements are quoted and attributed.
 */

import { isShowable } from '../core/path-policy.ts';
import { basename } from '../core/posix.ts';
import { STORYBOARD_LIMITS } from '../core/storyboard-schema.ts';
import { countWords, naturalList, plural } from '../core/text.ts';
import type { RiskSignal } from '../core/types.ts';
import { compareViews, nestedIn, proseName, type SymbolView, symbolViews } from './heuristic-code.ts';
import { type Ctx, cite, isTrivial, type Line, maskText, safeText } from './heuristic-context.ts';
import { capitalise, splitSentences, stripMarkdown, truncateText } from './text.ts';

// ---------------------------------------------------------------------------
// Values in risk details
// ---------------------------------------------------------------------------

export interface NumericFact {
  name: string;
  /** The value before the change, or null when the setting is new. */
  from: string | null;
  to: string;
}

const NUMBER = String.raw`\d[\d_]*(?:\.\d+)?(?:\*\d[\d_]*(?:\.\d+)?)*`;
const END = String.raw`(?=[;.\s]|$)`;
const NEW_VALUE = new RegExp(String.raw`([A-Za-z_]\w*): new value (${NUMBER})${END}`, 'g');
const CHANGED_VALUE = new RegExp(String.raw`([A-Za-z_]\w*): (${NUMBER}) to (${NUMBER})${END}`, 'g');

/** A number as it is said: no digit separators, and "*" read as "times". */
export function formatNumber(raw: string): string {
  return raw.replace(/_/g, '').replace(/\*/g, ' times ');
}

/** The values the analysis found in a "changed timeout, retry or interval" risk. Empty for other risks. */
export function numericFacts(risk: RiskSignal): NumericFact[] {
  const found: { at: number; fact: NumericFact }[] = [];
  for (const match of risk.detail.matchAll(NEW_VALUE)) {
    found.push({ at: match.index ?? 0, fact: { name: match[1]!, from: null, to: formatNumber(match[2]!) } });
  }
  for (const match of risk.detail.matchAll(CHANGED_VALUE)) {
    found.push({
      at: match.index ?? 0,
      fact: { name: match[1]!, from: formatNumber(match[2]!), to: formatNumber(match[3]!) },
    });
  }
  return found.sort((a, b) => a.at - b.at).map((item) => item.fact);
}

/**
 * The values as sentences: "DEFAULT_RETRY sets retries to 3 and maxDelayMs to 4000." New values are
 * "set", values that were there before are "changed". `subject` is the name that holds them, or null for "It".
 */
export function numericSentences(facts: readonly NumericFact[], subject: string | null, max = 4): string[] {
  const shown = facts.slice(0, max);
  const only = shown[0];
  // A constant that holds its own value: "TOKEN_TTL_SECONDS is 3600".
  if (subject !== null && shown.length === 1 && only?.name === subject) {
    return [
      only.from === null ? `${subject} is ${only.to}.` : `${subject} goes from ${only.from} to ${only.to}.`,
    ];
  }
  const lead = subject ?? 'It';
  const out: string[] = [];
  const fresh = shown.filter((fact) => fact.from === null);
  const changed = shown.filter((fact) => fact.from !== null);
  if (fresh.length > 0) {
    out.push(`${lead} sets ${naturalList(fresh.map((fact) => `${fact.name} to ${fact.to}`))}.`);
  }
  if (changed.length > 0) {
    out.push(
      `${fresh.length > 0 ? 'It' : lead} changes ${naturalList(changed.map((fact) => `${fact.name} from ${fact.from} to ${fact.to}`))}.`,
    );
  }
  return out;
}

/** Names after "Affected:" in the detail of a public API risk. */
export function affectedNames(risk: RiskSignal): string[] {
  const at = risk.detail.indexOf('Affected: ');
  const match = at === -1 ? null : /^(.+?)\.(?:\s|$)/.exec(risk.detail.slice(at + 'Affected: '.length));
  if (!match) return [];
  return match[1]!
    .replace(/ and \d+ more$/, '')
    .split(/,\s*/)
    .map((name) => name.trim())
    .filter(Boolean);
}

/** The names a dependency risk lists after "New:", "Upgraded:" and "Removed:", as sentences: "It adds zod." */
export function dependencySentences(risk: RiskSignal, say: (name: string) => string | null): string[] {
  const verbs: Record<string, string> = { New: 'adds', Upgraded: 'upgrades', Removed: 'removes' };
  const out: string[] = [];
  for (const match of risk.detail.matchAll(/\b(New|Upgraded|Removed): (.+?)\.(?:\s|$)/g)) {
    const names = match[2]!
      .replace(/ and \d+ more$/, '')
      .split(/,\s*/)
      .map((name) => say(name.trim()))
      .filter((name): name is string => name !== null && name !== '');
    if (names.length > 0) out.push(`It ${verbs[match[1]!]} ${naturalList(names.slice(0, 3))}.`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Statements by the author
// ---------------------------------------------------------------------------

export interface Statement {
  /** The sentence as the author wrote it, masked. */
  full: string;
  /** What the video says: the sentence, or its first clause when the sentence reads badly aloud. */
  spoken: string;
  source: 'NOTES' | 'PR';
  /** The words that introduce it: "The notes say". */
  lead: string;
  /** Names in the sentence that look like code: camelCase, snake_case and UPPER_CASE. */
  tokens: Set<string>;
  /** All words of four letters or more, in lower case. */
  words: Set<string>;
}

const WORD = /[A-Za-z_][A-Za-z0-9_]{3,}/g;
/** Characters that are code, not speech. A sentence with them is shortened or left out. */
const CODE_CHARS = /[*^{}|\\<>=]/;
/** A quoted statement and its lead-in must stay within the line limit. */
const MAX_QUOTE_WORDS = 30;
/** A narration line stays within the limit for a caption. */
const MAX_LINE_WORDS = STORYBOARD_LIMITS.maxWordsPerNarrationLine;

export function distinctiveTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.matchAll(WORD)) {
    const word = match[0];
    if (/[a-z][A-Z]/.test(word) || word.includes('_') || /^[A-Z0-9]{4,}$/.test(word)) out.add(word);
  }
  return out;
}

function ensureEnd(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** The sentence as it is said aloud, or null when it cannot be said well. */
function spokenForm(sentence: string): string | null {
  const flat = sentence.replace(/\s+/g, ' ').replace(/"/g, "'").trim();
  if (!CODE_CHARS.test(flat) && countWords(flat) <= MAX_QUOTE_WORDS) return ensureEnd(flat);
  const clause = (flat.split(/:\s|;\s|\s[—–-]\s/)[0] ?? '').trim();
  if (countWords(clause) >= 3 && countWords(clause) <= MAX_QUOTE_WORDS && !CODE_CHARS.test(clause)) {
    return ensureEnd(clause);
  }
  return null;
}

/** Bullets and paragraphs, each as one unit of text. */
function blocks(text: string): string[] {
  const out: string[] = [];
  let open = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      open = false;
      continue;
    }
    const bullet = /^(?:[-*+]|\d{1,3}[.)])\s+(\S.*)$/.exec(line);
    if (bullet) {
      out.push(bullet[1]!);
      open = true;
    } else if (open) {
      out[out.length - 1] += ` ${line}`;
    } else {
      out.push(line);
      open = true;
    }
  }
  return out;
}

function statementsFrom(
  ctx: Ctx,
  text: string | null | undefined,
  source: Statement['source'],
  lead: string,
): Statement[] {
  if (!text) return [];
  const out: Statement[] = [];
  for (const block of blocks(text)) {
    // Stripping Markdown removes web addresses and leaves a broken sentence behind, so such a block is left out whole.
    if (/(?:https?:\/\/|www\.)\S/i.test(block)) continue;
    for (const sentence of splitSentences(stripMarkdown(block))) {
      const full = safeText(ctx, sentence);
      if (full === null || countWords(full) < 4) continue;
      const spoken = spokenForm(full);
      if (spoken === null) continue;
      out.push({
        full,
        spoken,
        source,
        lead,
        tokens: distinctiveTokens(full),
        words: new Set([...full.matchAll(WORD)].map((match) => match[0].toLowerCase())),
      });
    }
  }
  return out;
}

/** Sentences from the notes and the pull request description that may be quoted next to the code they mention. */
export function authorStatements(ctx: Ctx): Statement[] {
  return [
    ...statementsFrom(ctx, ctx.inputs.notes, 'NOTES', 'The notes say'),
    ...statementsFrom(ctx, ctx.changeSet.pr?.body, 'PR', 'The description says'),
  ].filter((statement) => ctx.evidence.has(statement.source));
}

/** What a code window shows, for matching statements to it. */
export interface WindowText {
  /** The lines on screen, joined. */
  code: string;
  /** Names of the symbols on screen, including the last part of a dotted name. */
  names: string[];
}

export interface StatementMatch {
  statement: Statement;
  /** The names that the statement and the code share. */
  shared: string[];
}

/**
 * The statement that talks about the same names as the code on screen. A symbol that is on screen
 * counts the most. At least one such name, or two names that look like code, must be shared.
 */
export function pickStatement(
  statements: readonly Statement[],
  window: WindowText,
  used: ReadonlySet<string>,
): StatementMatch | null {
  const codeTokens = distinctiveTokens(window.code);
  const names = window.names.filter((name) => name.length >= 5);
  let best: { match: StatementMatch; score: number } | null = null;
  for (const statement of statements) {
    if (used.has(statement.full)) continue;
    const shared = new Set<string>();
    let score = 0;
    for (const name of names) {
      if (statement.tokens.has(name) || statement.words.has(name.toLowerCase())) {
        shared.add(name);
        score += 3;
      }
    }
    for (const token of statement.tokens) {
      if (codeTokens.has(token) && !shared.has(token)) {
        shared.add(token);
        score += 1;
      }
    }
    if (score >= 2 && (best === null || score > best.score)) {
      best = { match: { statement, shared: [...shared] }, score };
    }
  }
  return best?.match ?? null;
}

// ---------------------------------------------------------------------------
// What the author asks reviewers to look at
// ---------------------------------------------------------------------------

export interface ReviewHint {
  /** The sentence for the narration. */
  spoken: string;
  title: string;
  detail: string;
  source: 'NOTES';
  /** Whether the author's lead-in ("Worth a careful review:") was removed. */
  stripped: boolean;
}

const REVIEW_WORDS =
  /\b(?:review|reviewer|reviewers|careful|caution|caveat|risk|risky|be aware|watch out)\b/i;
const LEAD_IN =
  /^(?:worth\s+(?:a\s+)?(?:careful\s+|close\s+)?(?:review|look)(?:ing)?|please\s+review|review|careful|caveat|risk|note)[^:]{0,24}:\s*/i;

/** The first note that asks for a careful review, with its lead-in removed. Only the caller's notes count. */
export function reviewHint(ctx: Ctx): ReviewHint | null {
  if (!ctx.evidence.has('NOTES')) return null;
  for (const statement of statementsFrom(ctx, ctx.inputs.notes, 'NOTES', 'The notes say')) {
    if (!REVIEW_WORDS.test(statement.full)) continue;
    const rest = statement.full.replace(LEAD_IN, '');
    const stripped = rest !== statement.full;
    const spoken = spokenForm(rest);
    if (spoken === null || countWords(spoken) < 4) continue;
    const [first, ...others] = spoken.replace(/\.$/, '').split(/;\s*/);
    const title = truncateText(capitalise((first ?? spoken).trim()), 80);
    const more = others
      .join('; ')
      .replace(/^and\s+/i, '')
      .trim();
    return {
      spoken,
      title,
      detail: truncateText(capitalise(ensureEnd(more || (first ?? spoken).trim())), 160),
      source: 'NOTES',
      stripped,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dependencies, tests and the names of what changed
// ---------------------------------------------------------------------------

const PLAIN_VERSION = /^[\^~<>=v]*\d+(?:\.\d+){0,3}(?:[-+][\w.]+)?$/;

/** One line about added, updated and removed dependencies, or null. */
export function dependencyLine(ctx: Ctx): Line | null {
  const shown = ctx.analysis.dependencies.filter((dependency) => {
    const file = ctx.fileById.get(dependency.fileId);
    return file !== undefined && isShowable(file) && safeText(ctx, dependency.name) !== null;
  });
  if (shown.length === 0) return null;
  const sentences: { text: string; ids: string[] }[] = [];
  const first = (items: typeof shown) => items.slice(0, 3);
  const names = (items: typeof shown): string =>
    naturalList(first(items).map((dependency) => safeText(ctx, dependency.name)!));
  const added = shown.filter((dependency) => dependency.change === 'added');
  const updated = shown.filter((dependency) => dependency.change === 'updated');
  const removed = shown.filter((dependency) => dependency.change === 'removed');
  if (added.length > 0) {
    sentences.push({
      text: `It adds the ${added.length === 1 ? 'dependency' : 'dependencies'} ${names(added)}.`,
      ids: first(added).map((dependency) => dependency.id),
    });
  }
  if (updated.length > 0) {
    const lead = updated[0]!;
    // A version such as "git+https://host/repo" is not read out; only plain version numbers are.
    const plain = (version: string | null): version is string =>
      version !== null && PLAIN_VERSION.test(version);
    const versions = plain(lead.from) && plain(lead.to) ? ` from ${lead.from} to ${lead.to}` : '';
    const rest =
      updated.length > 1
        ? `, and ${plural(updated.length - 1, 'other dependency', 'other dependencies')}`
        : '';
    sentences.push({ text: `It updates ${safeText(ctx, lead.name)}${versions}${rest}.`, ids: [lead.id] });
  }
  if (removed.length > 0) {
    sentences.push({
      text: `It removes the ${removed.length === 1 ? 'dependency' : 'dependencies'} ${names(removed)}.`,
      ids: first(removed).map((dependency) => dependency.id),
    });
  }
  const said = sentences.slice(0, 2);
  return {
    text: said.map((sentence) => sentence.text).join(' '),
    evidence: cite(ctx, ...said.flatMap((s) => s.ids)),
  };
}

/** One line naming the test files that were added, changed or removed, or null. */
export function testsLine(ctx: Ctx): Line | null {
  const named = (paths: readonly string[]): { names: string[]; ids: string[] } => {
    const files = paths
      .map((path) => ctx.fileByPath.get(path))
      .filter((file): file is NonNullable<typeof file> => file !== undefined && isShowable(file));
    return { names: files.map((file) => basename(file.path)), ids: files.map((file) => file.id) };
  };
  const added = named(ctx.analysis.tests.added);
  const modified = named(ctx.analysis.tests.modified);
  const pick =
    added.names.length > 0
      ? { verb: 'were added in', ...added }
      : modified.names.length > 0
        ? { verb: 'were changed in', ...modified }
        : null;
  if (pick === null) return null;
  const list = naturalList(pick.names.slice(0, 3));
  const more = pick.names.length > 3 ? ` and ${pick.names.length - 3} more` : '';
  return { text: `Tests ${pick.verb} ${list}${more}.`, evidence: cite(ctx, ...pick.ids.slice(0, 3)) };
}

/** Who reported a run, as it is said in a sentence. */
const REPORTER: Record<'agent' | 'ci' | 'user', string> = {
  ci: 'CI',
  agent: 'the coding agent',
  user: 'the author',
};

/** What the caller reported about runs of tests, checks and the like: every result, said once. */
export interface ReportedRuns {
  line: Line;
  /** The same in a few words, for the closing list. */
  point: string;
  /** At least one run did not pass. Such a line is never left out to save time. */
  failed: boolean;
}

/**
 * Every result the caller reported, with the ones that did not pass first. The wording never says
 * "tests pass" about a mixed set, and never puts a number in front of "passed", which is how a
 * claim of passing tests reads. A result is only reported, never confirmed: MergeStory runs nothing.
 */
export function reportedRuns(ctx: Ctx): ReportedRuns | null {
  const runs = ctx.inputs.tests.filter((run) => ctx.evidence.has(run.id));
  if (runs.length === 0) return null;
  const failed = runs.filter((run) => !run.passed);
  const passed = runs.filter((run) => run.passed);
  const labels = naturalList([...new Set(runs.map((run) => REPORTER[run.source]))]);
  const who = capitalise(labels);
  const name = (run: (typeof runs)[number]): string => {
    const text = safeText(ctx, run.command);
    return text ? truncateText(text, 40) : `run ${runs.indexOf(run) + 1}`;
  };
  const list = (group: typeof runs, shown: number): string => {
    const names = group.slice(0, shown).map(name);
    return group.length > shown ? `${names.join(', ')} and ${group.length - shown} more` : naturalList(names);
  };
  const count = runs.length;

  // Fewer names when the line is too long to read as a caption.
  const lineWith = (shown: number): string => {
    if (count === 1)
      return `${who} reported that ${name(runs[0]!)} ${passed.length === 1 ? 'passed' : 'did not pass'}.`;
    if (failed.length === 0) {
      return `${who} reported ${count} runs, and all of them passed${shown > 0 ? `: ${list(passed, shown)}` : ''}.`;
    }
    if (passed.length === 0) {
      return `${who} reported ${count} runs, and none of them passed${shown > 0 ? `: ${list(failed, shown)}` : ''}.`;
    }
    return shown > 0
      ? `${who} reported ${count} runs. Did not pass: ${list(failed, shown)}. Passed: ${list(passed, shown)}.`
      : `${who} reported ${count} runs, and ${failed.length} of them did not pass.`;
  };
  let text = lineWith(3);
  for (const shown of [2, 1, 0]) {
    if (countWords(text) <= MAX_LINE_WORDS) break;
    text = lineWith(shown);
  }

  const verdict =
    failed.length === 0
      ? count === 1
        ? 'passed'
        : 'all passed'
      : passed.length === 0
        ? count === 1
          ? 'did not pass'
          : 'none passed'
        : `${failed.length} of ${count} did not pass`;
  return {
    line: { text, evidence: cite(ctx, ...runs.map((run) => run.id)) },
    point: `Reported ${count === 1 ? 'run' : 'runs'}: ${verdict} (${labels})`,
    failed: failed.length > 0,
  };
}

/**
 * The most important symbols of the whole change, by the same ranking that picks the anchor of a
 * code scene. A changed class gives way to the members that changed inside it, and the members of
 * a new class are left to the class.
 */
export function topSymbols(ctx: Ctx): SymbolView[] {
  const all: SymbolView[] = [];
  for (const file of ctx.changeSet.files) {
    if (!isShowable(file) || isTrivial(ctx, file)) continue;
    const role = ctx.insightByFile.get(file.id)?.role;
    if (role === 'test' || role === 'docs') continue;
    const views = [
      ...(file.status === 'deleted' ? [] : symbolViews(ctx, file, 'head')),
      ...symbolViews(ctx, file, 'base'),
    ];
    all.push(
      ...views.filter(
        (view) =>
          !(view.symbol.change === 'modified' && views.some((other) => nestedIn(other, view))) &&
          !views.some((outer) => outer.symbol.change === 'added' && nestedIn(view, outer)),
      ),
    );
  }
  return all.sort(compareViews);
}

/** What the change does to its most important symbols, by name. */
export interface Recap {
  /** "adds withRetry and backoffDelay, and modifies WeatherClient.getForecast". */
  clause: string;
  /** Evidence ids of the symbols named. */
  ids: string[];
}

/** The most important symbols that were added, changed or removed, or null when no symbol qualifies. */
export function recap(ctx: Ctx): Recap | null {
  const named = topSymbols(ctx).filter((view) => view.symbol.kind !== 'other');
  const pick = (change: 'added' | 'modified' | 'removed', max: number): SymbolView[] =>
    named.filter((view) => view.symbol.change === change).slice(0, max);
  const added = pick('added', 3);
  const modified = pick('modified', 2);
  const removed = pick('removed', 2);
  const prose = (view: SymbolView): string => proseName(view.symbol.kind, view.name);
  const parts: string[] = [];
  if (added.length > 0) parts.push(`adds ${naturalList(added.map(prose))}`);
  if (modified.length > 0) parts.push(`modifies ${naturalList(modified.map(prose))}`);
  if (removed.length > 0) parts.push(`removes ${naturalList(removed.map(prose))}`);
  if (parts.length === 0) return null;
  const clause =
    parts.length > 1 ? `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}` : parts[0]!;
  return { clause, ids: [...added, ...modified, ...removed].map((view) => view.symbol.id) };
}

/** The quoted statement as one narration line. */
export function quoteLine(ctx: Ctx, statement: Statement, ...ids: (string | null | undefined)[]): Line {
  return {
    text: `${statement.lead}: ${maskText(ctx, statement.spoken)}`,
    evidence: cite(ctx, statement.source, ...ids),
  };
}
