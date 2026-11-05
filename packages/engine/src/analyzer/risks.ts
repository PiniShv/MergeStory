/**
 * Review risk signals. Each one is a question for the reviewer, never a claim that something is
 * broken: titles start with "Check" or "Confirm".
 */

import type {
  ChangedFile,
  ContextInputs,
  DependencyChange,
  DiffLine,
  FileRole,
  RiskCategory,
  RiskSeverity,
  RiskSignal,
  Side,
  SymbolChange,
} from '../core/types.ts';
import { hunkPath, hunkRange } from './hunks.ts';
import {
  ALTER_MIGRATION,
  CLI_COMMAND,
  CODE_AND_CONFIG_ROLES,
  CODE_ROLES,
  DESTRUCTIVE_MIGRATION,
  ENV_READ,
  LINE_RULES,
  NUMERIC_SETTING,
  RISK_KINDS,
  type RiskKind,
  type RiskKindId,
  SECURITY_PATH,
  SECURITY_WORDS,
} from './risk-rules.ts';
import { isCommentText } from './trivial.ts';

export interface RiskFile {
  file: ChangedFile;
  role: FileRole;
  trivial: boolean;
  commentOnly: boolean;
  /** Sensitive or excluded: never inspected. */
  hidden: boolean;
}

export interface IdentifiedSymbol extends SymbolChange {
  signatureChanged: boolean;
}

export interface RiskInputs {
  files: readonly RiskFile[];
  symbols: readonly IdentifiedSymbol[];
  dependencies: readonly DependencyChange[];
  inputs: ContextInputs;
  meaningfulLines: number;
}

export interface CodeSite {
  name: string;
  fileId: string;
  path: string;
  line: number;
}

export interface RiskResult {
  risks: RiskSignal[];
  /** Environment variables read for the first time by the change. */
  envVars: CodeSite[];
  cliCommands: CodeSite[];
}

interface Loc {
  fileId: string;
  hunkId: string | null;
  path: string;
  side: Side;
  line: number;
  symbolId: string | null;
}

type Site = Omit<Loc, 'symbolId'>;

/** Where a whole file is reported: its first hunk, on a side where that line exists. Without hunks, line 1. */
function fileSite(file: ChangedFile): Site {
  const first = file.hunks[0];
  if (!first) {
    const side: Side = file.status === 'deleted' ? 'base' : 'head';
    return {
      fileId: file.id,
      hunkId: null,
      path: hunkPath(file, { side, startLine: 1, endLine: 1 }),
      side,
      line: 1,
    };
  }
  const range = hunkRange(first);
  return {
    fileId: file.id,
    hunkId: first.id,
    path: hunkPath(file, range),
    side: range.side,
    line: range.startLine,
  };
}

interface Finding {
  key: string;
  category: RiskCategory;
  severity: RiskSeverity;
  title: string;
  verb: string;
  what: string;
  locs: Loc[];
  /** Extra sentences for the detail, without a trailing period. */
  extras: string[];
  extraEvidence: string[];
}

interface RecordOptions {
  /** Findings with the same key merge. Defaults to the kind id. */
  key?: string;
  /** Replaces the severity of the kind. */
  severity?: RiskSeverity;
  /** The number a counting `what` of the kind reports. */
  count?: number;
  /** One extra sentence for the detail. */
  extra?: string;
  extraEvidence?: readonly string[];
}

type Recorder = (kind: RiskKindId, site: Site, options?: RecordOptions) => void;

interface Sites {
  envVars: Map<string, CodeSite>;
  cliCommands: Map<string, CodeSite>;
}

/** What scanning the changed lines of one file leaves for the verdicts about the whole file. */
interface LineScan {
  firstChangedLine: Site | null;
  securityWordLines: number;
}

const SEVERITY_RANK: Record<RiskSeverity, number> = { high: 3, medium: 2, low: 1, info: 0 };
const CATEGORY_ORDER: RiskCategory[] = [
  'security',
  'data',
  'migration',
  'public-api',
  'concurrency',
  'error-handling',
  'dependency',
  'config',
  'tests',
  'complexity',
  'performance',
];
const MAX_RISKS = 10;
const MAX_LOCS = 8;
/** Longer lines are minified or generated text; patterns are not run on them. */
const MAX_ANALYZED_LINE = 2000;
const LOOP_START = /^\s*(?:for\s*\(|for\s+(?:await\s+)?[\w[({]|while\b)/;

function newFinding(kind: RiskKindId, options: RecordOptions = {}): Finding {
  const spec: RiskKind = RISK_KINDS[kind];
  return {
    key: options.key ?? kind,
    category: spec.category,
    severity: options.severity ?? spec.severity,
    title: spec.title,
    verb: spec.verb,
    what: typeof spec.what === 'function' ? spec.what(options.count ?? 0) : spec.what,
    locs: [],
    extras: [],
    extraEvidence: [],
  };
}

/** Finds the innermost symbol that holds a line, so a risk can cite it. */
function symbolFinder(
  symbols: readonly IdentifiedSymbol[],
): (fileId: string, side: Side, line: number) => string | null {
  const byFile = new Map<string, IdentifiedSymbol[]>();
  for (const s of symbols) byFile.set(s.fileId, [...(byFile.get(s.fileId) ?? []), s]);
  return (fileId, side, line) => {
    let best: IdentifiedSymbol | null = null;
    for (const s of byFile.get(fileId) ?? []) {
      if (s.side !== side || line < s.startLine || line > s.endLine) continue;
      if (!best || s.endLine - s.startLine < best.endLine - best.startLine) best = s;
    }
    return best?.id ?? null;
  };
}

function createRecorder(
  findings: Map<string, Finding>,
  symbolAt: (fileId: string, side: Side, line: number) => string | null,
): Recorder {
  return (kind, site, options = {}) => {
    const key = options.key ?? kind;
    let finding = findings.get(key);
    if (!finding) {
      finding = newFinding(kind, options);
      findings.set(key, finding);
    }
    const seen = finding.locs.some(
      (x) => x.fileId === site.fileId && x.side === site.side && x.line === site.line,
    );
    if (!seen && finding.locs.length < MAX_LOCS)
      finding.locs.push({ ...site, symbolId: symbolAt(site.fileId, site.side, site.line) });
    const { extra } = options;
    if (extra && finding.extras.length < 3 && !finding.extras.includes(extra)) finding.extras.push(extra);
    for (const id of options.extraEvidence ?? [])
      if (!finding.extraEvidence.includes(id)) finding.extraEvidence.push(id);
  };
}

/** Environment variables and CLI commands that a file removes, so re-adding one is not "new". */
function removedNamesOf(file: ChangedFile): Set<string> {
  const names = new Set<string>();
  for (const hunk of file.hunks) {
    for (const l of hunk.lines) {
      if (l.kind !== 'del' || l.text.length > MAX_ANALYZED_LINE) continue;
      for (const m of l.text.matchAll(ENV_READ)) names.add(m.slice(1).find(Boolean) as string);
      for (const m of l.text.matchAll(CLI_COMMAND)) names.add(`cmd:${m.slice(1).find(Boolean)}`);
    }
  }
  return names;
}

/** The numeric settings a hunk removes, by lower-cased name, to tell a changed value from a new one. */
function settingsBefore(lines: readonly DiffLine[]): Map<string, string> {
  const before = new Map<string, string>();
  for (const l of lines) {
    if (l.kind !== 'del' || l.text.length > MAX_ANALYZED_LINE) continue;
    for (const m of l.text.matchAll(NUMERIC_SETTING))
      before.set((m[1] as string).toLowerCase(), (m[2] as string).replace(/\s+/g, ''));
  }
  return before;
}

/** Whether the added line at `k` is an await in a loop body (looking six lines back) or an async forEach callback. */
function isAsyncInLoop(lines: readonly DiffLine[], k: number): boolean {
  const text = lines[k]!.text;
  if (/\.forEach\(\s*async\b/.test(text)) return true;
  if (!/\bawait\b/.test(text)) return false;
  const indent = (/^\s*/.exec(text) as RegExpExecArray)[0].length;
  for (let back = k - 1; back >= Math.max(0, k - 6); back--) {
    const prev = lines[back]!;
    if (
      prev.kind !== 'del' &&
      LOOP_START.test(prev.text) &&
      (/^\s*/.exec(prev.text) as RegExpExecArray)[0].length < indent
    )
      return true;
  }
  return false;
}

/**
 * Walks the changed lines of one file: line rules, async loops, numeric settings, and the
 * environment variables and CLI commands that are new. Leaves what the file-level verdicts need.
 */
function scanLines(rf: RiskFile, record: Recorder, sites: Sites): LineScan {
  const { file, role } = rf;
  const rules = LINE_RULES.filter((r) => r.roles.has(role));
  const removedNames = removedNamesOf(file);
  const removedHits = new Map<RiskKindId, { count: number; site: Site }>();
  const addedHits = new Map<RiskKindId, number>();
  const scan: LineScan = { firstChangedLine: null, securityWordLines: 0 };

  for (const hunk of file.hunks) {
    const lines = hunk.lines;
    const before = settingsBefore(lines);
    for (let k = 0; k < lines.length; k++) {
      const l = lines[k]!;
      if (l.kind === 'ctx') continue;
      const side: Side = l.kind === 'add' ? 'head' : 'base';
      const lineNo = (l.kind === 'add' ? l.newLine : l.oldLine) ?? 0;
      const path = hunkPath(file, { side, startLine: lineNo, endLine: lineNo });
      const site: Site = { fileId: file.id, hunkId: hunk.id, path, side, line: lineNo };
      scan.firstChangedLine ??= site;
      if (l.text.length > MAX_ANALYZED_LINE) continue;
      const isComment = isCommentText(file.path, l.text);
      if (SECURITY_WORDS.test(l.text) && !isComment) scan.securityWordLines++;

      for (const rule of rules) {
        if (isComment && !rule.includeComments) continue;
        if (!rule.pattern.test(l.text)) continue;
        if (rule.on === 'added') {
          if (l.kind === 'add') record(rule.key, site);
        } else if (l.kind === 'del') {
          const hit = removedHits.get(rule.key) ?? { count: 0, site };
          hit.count++;
          removedHits.set(rule.key, hit);
        } else {
          addedHits.set(rule.key, (addedHits.get(rule.key) ?? 0) + 1);
        }
      }

      if (l.kind !== 'add') continue;
      const next = lines[k + 1];
      for (const rule of rules) {
        if (
          next?.kind === 'add' &&
          rule.span?.some(([open, close]) => open.test(l.text) && close.test(next.text))
        )
          record(rule.key, site);
      }
      if (!isComment && CODE_ROLES.has(role)) {
        if (isAsyncInLoop(lines, k)) record('async-loop', site);
        for (const m of l.text.matchAll(ENV_READ)) {
          const name = m.slice(1).find(Boolean) as string;
          if (!removedNames.has(name) && !sites.envVars.has(name))
            sites.envVars.set(name, { name, fileId: file.id, path: file.path, line: lineNo });
        }
        for (const m of l.text.matchAll(CLI_COMMAND)) {
          const name = m.slice(1).find(Boolean) as string;
          if (!removedNames.has(`cmd:${name}`) && !sites.cliCommands.has(name))
            sites.cliCommands.set(name, { name, fileId: file.id, path: file.path, line: lineNo });
        }
      }
      if (!isComment && CODE_AND_CONFIG_ROLES.has(role)) {
        for (const m of l.text.matchAll(NUMERIC_SETTING)) {
          const name = m[1] as string;
          const value = (m[2] as string).replace(/\s+/g, '');
          const was = before.get(name.toLowerCase());
          if (was !== value)
            record('numeric-setting', site, {
              extra: was !== undefined ? `${name}: ${was} to ${value}` : `${name}: new value ${value}`,
            });
        }
      }
    }
  }

  // A removed pattern counts only when the file loses more of it than it gains.
  for (const rule of rules) {
    if (rule.on !== 'removed') continue;
    const hit = removedHits.get(rule.key);
    if (hit && hit.count > (addedHits.get(rule.key) ?? 0)) record(rule.key, hit.site);
  }
  return scan;
}

/** Verdicts about a whole file: security-sensitive code and the kind of migration. */
function fileVerdicts(rf: RiskFile, scan: LineScan, record: Recorder): void {
  const { file, role } = rf;
  const { firstChangedLine, securityWordLines } = scan;
  if (
    (role === 'source' || role === 'other') &&
    file.additions + file.deletions > 0 &&
    !rf.commentOnly &&
    firstChangedLine
  ) {
    if (SECURITY_PATH.test(file.path)) record('security-path', firstChangedLine);
    else if (securityWordLines >= 3) record('security-words', firstChangedLine);
  }
  if (role !== 'migration') return;

  const added = file.hunks.flatMap((h) => h.lines.filter((l) => l.kind === 'add').map((l) => ({ l, h })));
  const destructive = added.find(({ l }) => DESTRUCTIVE_MIGRATION.test(l.text));
  const alter = added.find(({ l }) => ALTER_MIGRATION.test(l.text));
  const at = (hit: { l: { newLine: number | null }; h: { id: string } } | undefined): Site =>
    hit?.l.newLine != null
      ? { fileId: file.id, hunkId: hit.h.id, path: file.path, side: 'head', line: hit.l.newLine }
      : fileSite(file);
  if (file.status === 'deleted') record('migration-deleted', at(undefined));
  else if (destructive) record('migration-destructive', at(destructive));
  else if (file.status !== 'added') record('migration-edited', at(alter));
  else if (alter) record('migration-alter', at(alter));
  else record('migration-new', at(undefined));
}

function envVarFinding(envList: readonly CodeSite[], symbolAt: ReturnType<typeof symbolFinder>): Finding {
  const names = envList
    .slice(0, 6)
    .map((e) => e.name)
    .join(', ');
  const more = envList.length > 6 ? ` and ${envList.length - 6} more` : '';
  const finding = newFinding('env-vars');
  finding.what = `${finding.what} (${names}${more})`;
  finding.locs = envList.slice(0, MAX_LOCS).map((e) => ({
    fileId: e.fileId,
    hunkId: null,
    path: e.path,
    side: 'head' as const,
    line: e.line,
    symbolId: symbolAt(e.fileId, 'head', e.line),
  }));
  finding.extras = ['Confirm they are documented and have safe defaults'];
  return finding;
}

export function detectRisks(input: RiskInputs): RiskResult {
  const findings = new Map<string, Finding>();
  const sites: Sites = { envVars: new Map(), cliCommands: new Map() };
  const symbolAt = symbolFinder(input.symbols);
  const record = createRecorder(findings, symbolAt);
  const roleOf = new Map(input.files.map((f) => [f.file.id, f.role]));

  for (const rf of input.files) {
    if (rf.hidden || rf.trivial || rf.file.binary) continue;
    fileVerdicts(rf, scanLines(rf, record, sites), record);
  }
  publicApiFindings(input, roleOf, record);
  dependencyFindings(input, record);
  testFindings(input, record);
  complexityFindings(input, roleOf, record);

  const envList = [...sites.envVars.values()].filter((e) => e.name.length > 1);
  if (envList.length > 0) findings.set('env-vars', envVarFinding(envList, symbolAt));

  const risks = [...findings.values()]
    .sort(
      (a, b) =>
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) ||
        b.locs.length - a.locs.length ||
        a.key.localeCompare(b.key),
    )
    .slice(0, MAX_RISKS)
    .map((f, i) => toSignal(f, i + 1));
  return { risks, envVars: envList, cliCommands: [...sites.cliCommands.values()] };
}

function publicApiFindings(input: RiskInputs, roleOf: Map<string, FileRole>, record: Recorder): void {
  const relevant = input.symbols.filter((s) => s.exported && roleOf.get(s.fileId) === 'source');
  const removed = relevant.filter((s) => s.change === 'removed');
  const changed = relevant.filter((s) => s.change === 'modified' && s.signatureChanged);
  const emit = (list: IdentifiedSymbol[], kind: 'api-removed' | 'api-signature'): void => {
    const names =
      list
        .slice(0, 4)
        .map((x) => x.name)
        .join(', ') + (list.length > 4 ? ` and ${list.length - 4} more` : '');
    for (const s of list) {
      record(
        kind,
        { fileId: s.fileId, hunkId: null, path: s.path, side: s.side, line: s.startLine },
        { count: list.length, extra: `Affected: ${names}.`, extraEvidence: [s.id] },
      );
    }
  };
  emit(removed, 'api-removed');
  emit(changed, 'api-signature');
}

function majorOf(version: string | null): number | null {
  const m = /(\d+)\.\d+/.exec(version ?? '') ?? /^[^\d]*(\d+)$/.exec(version ?? '');
  return m ? Number(m[1]) : null;
}

function dependencyFindings(input: RiskInputs, record: Recorder): void {
  const byFile = new Map<string, DependencyChange[]>();
  for (const d of input.dependencies) byFile.set(d.fileId, [...(byFile.get(d.fileId) ?? []), d]);
  const fileOf = new Map(input.files.map((f) => [f.file.id, f]));
  const locate = (dep: DependencyChange, removed: boolean): Site => {
    const rf = fileOf.get(dep.fileId);
    const wanted = removed ? 'del' : 'add';
    const needles = [dep.name.toLowerCase(), dep.name.toLowerCase().replace(/-/g, '_')];
    for (const hunk of rf?.file.hunks ?? []) {
      for (const l of hunk.lines) {
        if (l.kind === wanted && needles.some((n) => l.text.toLowerCase().includes(n))) {
          const side: Side = removed ? 'base' : 'head';
          const line = (removed ? l.oldLine : l.newLine) ?? 1;
          return {
            fileId: dep.fileId,
            hunkId: hunk.id,
            path: hunkPath(rf!.file, { side, startLine: line, endLine: line }),
            side,
            line,
          };
        }
      }
    }
    return rf ? fileSite(rf.file) : { fileId: dep.fileId, hunkId: null, path: '', side: 'head', line: 1 };
  };
  const list = (items: DependencyChange[]): string =>
    items
      .slice(0, 5)
      .map((d) => d.name)
      .join(', ') + (items.length > 5 ? ` and ${items.length - 5} more` : '');
  for (const [fileId, deps] of byFile) {
    const added = deps.filter((d) => d.change === 'added');
    const removed = deps.filter((d) => d.change === 'removed');
    const major = deps.filter((d) => {
      const a = majorOf(d.from);
      const b = majorOf(d.to);
      return d.change === 'updated' && a !== null && b !== null && b > a;
    });
    if (added.length > 0) {
      record('dep-added', locate(added[0] as DependencyChange, false), {
        key: `dep-added:${fileId}`,
        severity: added.length >= 5 ? 'medium' : 'low',
        count: added.length,
        extra: `New: ${list(added)}.`,
        extraEvidence: added.map((d) => d.id),
      });
    }
    if (major.length > 0) {
      record('dep-major', locate(major[0] as DependencyChange, false), {
        key: `dep-major:${fileId}`,
        count: major.length,
        extra: `Upgraded: ${list(major)}.`,
        extraEvidence: major.map((d) => d.id),
      });
    }
    if (removed.length > 0) {
      record('dep-removed', locate(removed[0] as DependencyChange, true), {
        key: `dep-removed:${fileId}`,
        count: removed.length,
        extra: `Removed: ${list(removed)}.`,
        extraEvidence: removed.map((d) => d.id),
      });
    }
  }
}

function testFindings(input: RiskInputs, record: Recorder): void {
  const live = input.files.filter((f) => !f.hidden);
  const sources = live.filter(
    (f) =>
      (f.role === 'source' || f.role === 'migration') &&
      !f.trivial &&
      f.file.status !== 'deleted' &&
      f.file.additions + f.file.deletions > 0,
  );
  const testsTouched = live.some((f) => f.role === 'test' && f.file.status !== 'deleted');
  if (sources.length > 0 && !testsTouched) {
    const passing = input.inputs.tests.length > 0 && input.inputs.tests.every((t) => t.passed);
    for (const f of sources.slice(0, 5)) {
      record('no-tests', fileSite(f.file), {
        severity: input.meaningfulLines >= 50 ? 'medium' : 'low',
        extra: passing ? 'The caller reported passing test runs; they are not verified here.' : undefined,
      });
    }
  }
  for (const f of live.filter((x) => x.role === 'test' && x.file.status === 'deleted')) {
    record('tests-deleted', fileSite(f.file));
  }
}

function complexityFindings(input: RiskInputs, roleOf: Map<string, FileRole>, record: Recorder): void {
  const big: { rf: RiskFile; hunkId: string; size: number; line: number; side: Side }[] = [];
  for (const rf of input.files) {
    if (rf.hidden || rf.trivial || !['source', 'migration', 'other'].includes(rf.role)) continue;
    let best: (typeof big)[number] | null = null;
    for (const h of rf.file.hunks) {
      const adds = h.lines.some((l) => l.kind === 'add');
      if (h.lines.length > 80 && (!best || h.lines.length > best.size)) {
        best = {
          rf,
          hunkId: h.id,
          size: h.lines.length,
          line: adds ? h.newStart : h.oldStart,
          side: adds ? 'head' : 'base',
        };
      }
    }
    if (best) big.push(best);
  }
  for (const b of big.sort((x, y) => y.size - x.size).slice(0, 3)) {
    record(
      'large-hunk',
      {
        fileId: b.rf.file.id,
        hunkId: b.hunkId,
        path: hunkPath(b.rf.file, { side: b.side, startLine: b.line, endLine: b.line }),
        side: b.side,
        line: b.line,
      },
      { extra: `Largest block: ${b.size} lines.` },
    );
  }
  const longFns = input.symbols
    .filter(
      (s) =>
        s.change !== 'removed' &&
        ['function', 'method', 'component'].includes(s.kind) &&
        s.endLine - s.startLine + 1 > 120 &&
        roleOf.get(s.fileId) === 'source',
    )
    .sort((a, b) => b.endLine - b.startLine - (a.endLine - a.startLine))
    .slice(0, 3);
  for (const s of longFns) {
    record(
      'large-function',
      { fileId: s.fileId, hunkId: null, path: s.path, side: s.side, line: s.startLine },
      { extra: `${s.name} spans ${s.endLine - s.startLine + 1} lines.`, extraEvidence: [s.id] },
    );
  }
}

function toSignal(f: Finding, index: number): RiskSignal {
  const shown = f.locs.slice(0, 3).map((l) => `${l.path}:${l.line}`);
  const more = f.locs.length > 3 ? ` and ${f.locs.length - 3} more` : '';
  const where = shown.length > 0 ? ` at ${shown.join(', ')}${more}` : '';
  const evidence: string[] = [];
  for (const l of f.locs.slice(0, 6)) {
    for (const id of [l.fileId, l.hunkId, l.symbolId]) if (id && !evidence.includes(id)) evidence.push(id);
  }
  for (const id of f.extraEvidence) if (!evidence.includes(id)) evidence.push(id);
  const first = f.locs[0];
  return {
    id: `R${index}`,
    severity: f.severity,
    category: f.category,
    title: f.title,
    detail: `${f.verb} ${f.what}${where}.${f.extras.length > 0 ? ` ${f.extras.map((e) => e.replace(/\.$/, '')).join('; ')}.` : ''}`,
    evidence: evidence.slice(0, 14),
    ref: first ? { path: first.path, side: first.side, startLine: first.line, endLine: first.line } : null,
  };
}
