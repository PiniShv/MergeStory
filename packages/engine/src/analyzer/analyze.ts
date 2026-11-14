/** The analysis pipeline: from a change set to the facts a storyboard may cite. */
import { mapLimit } from '../core/concurrency.ts';
import type { RunContext } from '../core/context.ts';
import { languageInfo } from '../core/languages.ts';
import { compileGlobs, isProtectedFile, isShowable } from '../core/path-policy.ts';
import { extname } from '../core/posix.ts';
import { trimTrailingSlashes } from '../core/text.ts';
import type {
  Analysis,
  ChangedFile,
  ChangeSet,
  ChangeSize,
  ContextInputs,
  DependencyChange,
  FileInsight,
  FileRole,
  RepoReader,
  RiskSignal,
  Side,
  SymbolChange,
  SymbolKind,
} from '../core/types.ts';
import { groupComponents } from './components.ts';
import { diffManifest, manifestKind } from './dependencies.ts';
import { buildEvidenceIndex } from './evidence.ts';
import { rankKeyHunks } from './hunks.ts';
import { ImportResolver, importLang, loadResolverOptions } from './imports.ts';
import { hasImports, hasSymbols } from './languages/index.ts';
import type { ImportLang } from './languages/types.ts';
import { buildRelationships } from './relationships.ts';
import { detectRisks, type IdentifiedSymbol } from './risks.ts';
import { detectRole, ROLE_WEIGHT } from './roles.ts';
import { architectureSignals } from './signals.ts';
import { type ChangedSymbol, classifySymbols } from './symbol-changes.ts';
import { classifyTrivial } from './trivial.ts';
import { round } from './util.ts';

const MAX_CONTENT_FILES = 150;
const MAX_SYMBOLS = 80;
const READ_CONCURRENCY = 6;
const CONTENT_ROLES: readonly FileRole[] = ['source', 'test', 'migration', 'build', 'other'];

interface FileState {
  index: number;
  file: ChangedFile;
  role: FileRole;
  hidden: boolean;
  trivial: boolean;
  trivialReason: string | null;
  commentOnly: boolean;
}

const KIND_WEIGHT: Record<SymbolKind, number> = {
  route: 1,
  class: 0.9,
  component: 0.9,
  function: 0.8,
  interface: 0.8,
  type: 0.6,
  method: 0.6,
  constant: 0.4,
  other: 0.3,
};
const CHANGE_WEIGHT = { added: 1, removed: 0.9, modified: 0.6 } as const;

function sizeOf(lines: number): ChangeSize {
  if (lines <= 20) return 'xs';
  if (lines <= 120) return 's';
  if (lines <= 400) return 'm';
  if (lines <= 1200) return 'l';
  return 'xl';
}

const DURATION: Record<ChangeSize, number> = { xs: 45, s: 70, m: 100, l: 130, xl: 160 };

function changedText(file: ChangedFile): string {
  return file.hunks.flatMap((h) => h.lines.filter((l) => l.kind !== 'ctx').map((l) => l.text)).join('\n');
}

/** Gives every changed file its role and its verdicts: protected, trivial, comment-only. */
function classifyFiles(files: readonly ChangedFile[]): FileState[] {
  return files.map((file, index) => {
    const hidden = isProtectedFile(file);
    const role = detectRole(file.path, !hidden && extname(file.path) === '.sql' ? changedText(file) : '');
    const verdict = hidden
      ? { trivial: false, reason: null, commentOnly: false }
      : classifyTrivial(file, role);
    return {
      index,
      file,
      role,
      hidden,
      trivial: verdict.trivial,
      trivialReason: verdict.reason,
      commentOnly: verdict.commentOnly,
    };
  });
}

/** A file whose content may be inspected and that counts as work: not protected, binary or trivial. */
function isContent(s: FileState): boolean {
  return isShowable(s.file) && !s.trivial && CONTENT_ROLES.includes(s.role);
}

/** The files worth reading, biggest first: those that can yield symbols or imports. */
function selectContentFiles(states: readonly FileState[]): FileState[] {
  return states
    .filter((s) => isContent(s) && (hasSymbols(s.file.path) || hasImports(s.file.path)))
    .sort(
      (a, b) =>
        b.file.additions + b.file.deletions - (a.file.additions + a.file.deletions) || a.index - b.index,
    )
    .slice(0, MAX_CONTENT_FILES);
}

/** Reads of repository files for one run: cached, and a failed read is a missing file unless the run was cancelled. */
function createFileReader(reader: RepoReader, ctx: RunContext) {
  const cache = new Map<string, Promise<string | null>>();
  const read = (path: string, side: Side): Promise<string | null> => {
    const key = `${side}:${path}`;
    let hit = cache.get(key);
    if (!hit) {
      hit = reader.readFile(path, side).catch((err: unknown) => {
        if (ctx.signal.aborted) throw err;
        ctx.logger.debug('analyzer: could not read a file', { side });
        return null;
      });
      cache.set(key, hit);
    }
    return hit;
  };
  return {
    read,
    head: (s: FileState): Promise<string | null> =>
      s.file.status === 'deleted' ? Promise.resolve(null) : read(s.file.path, 'head'),
    base: (s: FileState): Promise<string | null> =>
      s.file.status === 'added' || s.file.status === 'copied'
        ? Promise.resolve(null)
        : read(s.file.oldPath ?? s.file.path, 'base'),
  };
}

type FileReader = ReturnType<typeof createFileReader>;

interface ContentRead {
  state: FileState;
  head: string | null;
  symbols: ChangedSymbol[];
}

/** Reads head and, where deletions need it, base of each content file, and finds the symbols that changed. */
function readContent(
  states: readonly FileState[],
  files: FileReader,
  ctx: RunContext,
): Promise<ContentRead[]> {
  return mapLimit(states, READ_CONCURRENCY, async (s) => {
    ctx.signal.throwIfAborted();
    const needsBase =
      s.file.status === 'deleted' ||
      ((s.role === 'source' || s.role === 'migration') && s.file.deletions > 0 && s.file.status !== 'added');
    const [head, base] = await Promise.all([files.head(s), needsBase ? files.base(s) : null]);
    const reports = s.role === 'source' || s.role === 'migration' || s.role === 'other';
    return { state: s, head, symbols: reports ? classifySymbols(s.file, head, base) : [] };
  });
}

/** Dependency changes of the manifests in the change, numbered in file order. */
async function readDependencies(
  states: readonly FileState[],
  files: FileReader,
): Promise<DependencyChange[]> {
  const manifests = states.filter(
    (s) => !s.hidden && s.role === 'dependency-manifest' && manifestKind(s.file.path) !== null,
  );
  const diffs = await mapLimit(manifests, READ_CONCURRENCY, async (s) => {
    const [base, head] = await Promise.all([files.base(s), files.head(s)]);
    return diffManifest(s.file, base, head);
  });
  return diffs.flat().map((d, i) => ({ ...d, id: `D${i + 1}` }));
}

/** Keeps the most relevant symbols, then numbers them in file order. */
function pickSymbols(reads: readonly ContentRead[]): {
  identified: IdentifiedSymbol[];
  symbols: SymbolChange[];
} {
  const candidates = [...reads]
    .sort((a, b) => a.state.index - b.state.index)
    .flatMap(({ state, symbols }) => symbols.map((symbol) => ({ state, symbol })));
  const relevance = (c: (typeof candidates)[number]): number =>
    KIND_WEIGHT[c.symbol.kind] *
    CHANGE_WEIGHT[c.symbol.change] *
    (c.symbol.exported ? 1 : 0.6) *
    Math.max(0.1, ROLE_WEIGHT[c.state.role]);
  const kept = candidates
    .map((c, order) => ({ c, order, score: relevance(c) }))
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, MAX_SYMBOLS)
    .sort((a, b) => a.order - b.order);
  const identified: IdentifiedSymbol[] = kept.map(({ c }, i) => {
    const { signatureChanged, decl: _decl, ...rest } = c.symbol;
    return { ...rest, id: `S${i + 1}`, signatureChanged };
  });
  return { identified, symbols: identified.map(({ signatureChanged: _s, ...rest }) => rest) };
}

/** Size class, line count and suggested length of the video. */
function pacing(states: readonly FileState[], grouping: ReturnType<typeof groupComponents>) {
  let meaningfulLines = 0;
  for (const s of states) {
    if (isShowable(s.file) && !s.trivial) meaningfulLines += s.file.additions + s.file.deletions;
  }
  const size = sizeOf(meaningfulLines);
  const stateById = new Map(states.map((s) => [s.file.id, s]));
  const meaningfulComponents = grouping.components.filter((m) =>
    m.fileIds.some((id) => {
      const s = stateById.get(id);
      return (
        !!s && !s.hidden && !s.trivial && !['docs', 'test', 'asset', 'lockfile', 'generated'].includes(s.role)
      );
    }),
  ).length;
  return {
    meaningfulLines,
    size,
    suggestedDurationSec: DURATION[size] + (meaningfulComponents >= 3 ? 10 : 0),
  };
}

function insightsOf(
  states: readonly FileState[],
  symbols: readonly SymbolChange[],
  risks: readonly RiskSignal[],
  grouping: ReturnType<typeof groupComponents>,
): FileInsight[] {
  const symbolsByFile = new Map<string, SymbolChange[]>();
  for (const s of symbols) symbolsByFile.set(s.fileId, [...(symbolsByFile.get(s.fileId) ?? []), s]);
  return states.map((s) => {
    const churn = s.file.additions + s.file.deletions;
    const fileSymbols = symbolsByFile.get(s.file.id) ?? [];
    let importance = 0.1;
    if (!s.hidden) {
      if (s.trivial) importance = 0;
      else {
        importance = ROLE_WEIGHT[s.role] * (0.35 + 0.65 * Math.min(1, Math.log1p(churn) / Math.log1p(150)));
        if (s.commentOnly) importance *= 0.4;
        if (fileSymbols.some((x) => x.exported && x.change === 'added')) importance += 0.1;
        importance += Math.min(0.15, 0.05 * risks.filter((r) => r.evidence.includes(s.file.id)).length);
      }
    }
    return {
      fileId: s.file.id,
      path: s.file.path,
      role: s.role,
      componentId: grouping.byFile.get(s.file.id) ?? 'M1',
      hidden: s.hidden,
      trivial: s.trivial,
      trivialReason: s.trivialReason,
      importance: round(Math.min(1, Math.max(0, importance))),
      symbolIds: fileSymbols.map((x) => x.id),
    };
  });
}

function testChanges(states: readonly FileState[]): Analysis['tests'] {
  const tests = { added: [] as string[], modified: [] as string[], removed: [] as string[] };
  for (const s of states) {
    if (s.hidden || s.role !== 'test') continue;
    if (s.file.status === 'added' || s.file.status === 'copied') tests.added.push(s.file.path);
    else if (s.file.status === 'deleted') tests.removed.push(s.file.path);
    else tests.modified.push(s.file.path);
  }
  return tests;
}

function languagesOf(states: readonly FileState[]): Analysis['languages'] {
  const counts = new Map<string, number>();
  for (const s of states) {
    if (!isContent(s)) continue;
    const language = s.file.language ? languageInfo(s.file.language) : null;
    if (language?.isCode) counts.set(language.base, (counts.get(language.base) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([language, files]) => ({ language, files }))
    .sort((a, b) => b.files - a.files || a.language.localeCompare(b.language));
}

/**
 * Analyse a change set. File contents come only from `reader`, and never for a file marked
 * `sensitive` (a sensitive or excluded path: the source decides). The result is deterministic: the
 * same input gives the same ids.
 */
export async function analyze(
  changeSet: ChangeSet,
  reader: RepoReader,
  inputs: ContextInputs,
  ctx: RunContext,
): Promise<Analysis> {
  const states = classifyFiles(changeSet.files);
  ctx.signal.throwIfAborted();

  const files = createFileReader(reader, ctx);
  const contentStates = selectContentFiles(states);
  const grouping = groupComponents(states.map((s) => ({ file: s.file, role: s.role, trivial: s.trivial })));
  const languages = new Set<ImportLang>(
    contentStates.flatMap((s) => {
      const lang = importLang(s.file.path);
      return lang ? [lang] : [];
    }),
  );
  const isExcluded = compileGlobs(ctx.config.privacy.excludePaths);

  // None of these reads needs another's result.
  const [contents, dependencies, resolverOptions] = await Promise.all([
    readContent(contentStates, files, ctx),
    readDependencies(states, files),
    loadResolverOptions({
      componentPaths: grouping.components.map((m) => m.path),
      languages,
      isExcluded,
      readHead: (path) => files.read(path, 'head'),
      concurrency: READ_CONCURRENCY,
    }),
  ]);
  const { identified, symbols } = pickSymbols(contents);
  ctx.signal.throwIfAborted();

  const knownPaths = new Set<string>();
  for (const s of states) if (s.file.status !== 'deleted') knownPaths.add(s.file.path);
  for (const entry of changeSet.repoContext.tree) knownPaths.add(trimTrailingSlashes(entry));
  const relationships = buildRelationships({
    files: contents.map(({ state, head }) => ({ file: state.file, role: state.role, head })),
    grouping,
    resolver: new ImportResolver({ knownPaths, ...resolverOptions }),
  });
  ctx.signal.throwIfAborted();

  const { meaningfulLines, size, suggestedDurationSec } = pacing(states, grouping);
  const riskResult = detectRisks({
    files: states.map((s) => ({
      file: s.file,
      role: s.role,
      trivial: s.trivial,
      commentOnly: s.commentOnly,
      hidden: s.hidden,
    })),
    symbols: identified,
    dependencies,
    inputs,
    meaningfulLines,
  });
  const keyHunks = rankKeyHunks(states, symbols, riskResult.risks);
  const fileInsights = insightsOf(states, symbols, riskResult.risks, grouping);

  const stateById = new Map(states.map((s) => [s.file.id, s]));
  const signals = architectureSignals({
    components: grouping.components,
    files: fileInsights.map((f) => {
      const file = stateById.get(f.fileId)?.file;
      return { ...f, status: file?.status ?? 'modified', oldPath: file?.oldPath ?? null };
    }),
    dependencies,
    symbols,
    envVars: riskResult.envVars,
    cliCommands: riskResult.cliCommands,
  });
  const evidence = buildEvidenceIndex({
    changeSet,
    inputs,
    hiddenFileIds: new Set(states.filter((s) => s.hidden).map((s) => s.file.id)),
    components: grouping.components,
    symbols,
    risks: riskResult.risks,
    dependencies,
  });

  ctx.logger.debug('analyzer: done', {
    files: states.length,
    contentFiles: contentStates.length,
    symbols: symbols.length,
    risks: riskResult.risks.length,
    evidence: evidence.length,
  });

  return {
    version: 1,
    size,
    meaningfulLines,
    files: fileInsights,
    components: grouping.components,
    relationships,
    symbols,
    keyHunks,
    risks: riskResult.risks,
    dependencies,
    tests: testChanges(states),
    languages: languagesOf(states),
    architectureSignals: signals,
    suggestedDurationSec,
    evidence,
  };
}
