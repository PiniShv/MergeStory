/**
 * Several sources, one video. Every source is loaded and analysed on its own, exactly as a single
 * source is. This module then joins them into ONE change set, ONE reader and ONE analysis that look
 * like one change in a repository with one top folder for each source. Every later stage keeps
 * working on one change set.
 *
 * Ids that a repository made get the letter of the source in front ("A.F1", "A.F1.H2", "A.PR");
 * paths get its folder in front ("orders-api/src/total.js"). Ids that the caller supplied (TASK,
 * NOTES, T<n>, REPRO, REPRO.<n>, SS<n>, RC<n>, L<n>) are taken once and keep their ids.
 *
 * The evidence pack cuts lists by position, so a list that a source ranks (key hunks, risks, components,
 * relationships) is ranked across the sources with the comparison of the analyzer, and equal items keep the
 * order of the letters. A list with no rank (symbols, dependencies, architecture signals) is taken in turns.
 */
import { isMeaningfulFile, paceOf, sortLanguages } from '../analyzer/analyze.ts';
import { compareChurn } from '../analyzer/components.ts';
import { compareScores } from '../analyzer/hunks.ts';
import { compareRelationships } from '../analyzer/relationships.ts';
import { compareRiskClass } from '../analyzer/risks.ts';
import { MergeStoryError } from '../core/errors.ts';
import type {
  Analysis,
  ChangedFile,
  ChangeSet,
  ChangeSetPart,
  CodeRef,
  EvidenceItem,
  RepoInfo,
  RepoReader,
  Side,
} from '../core/types.ts';
import { README_MAX_CHARS } from './limits.ts';

/** The letters of the sources, in order. */
const LETTERS = 'ABCD';

/** Where an evidence item comes from. A new kind does not compile until it is placed here. */
const EVIDENCE_ORIGIN: Record<EvidenceItem['kind'], 'source' | 'run'> = {
  pr: 'source',
  task: 'run',
  notes: 'run',
  test: 'run',
  issue: 'source',
  commit: 'source',
  file: 'source',
  hunk: 'source',
  symbol: 'source',
  component: 'source',
  risk: 'source',
  dependency: 'source',
  screenshot: 'run',
  recording: 'run',
  repro: 'run',
  log: 'run',
  repo: 'source',
};

export interface LoadedSource {
  changeSet: ChangeSet;
  reader: RepoReader;
  analysis: Analysis;
}

/** Host, owner and name of the repository, then the pull request number, then the head and base commits. */
function compareSources(a: ChangeSet, b: ChangeSet): number {
  const key = (cs: ChangeSet): [string, string, string, number, string, string] => [
    cs.repo.host,
    cs.repo.owner ?? '',
    cs.repo.name,
    cs.pr?.number ?? 0,
    cs.head.sha,
    cs.base.sha,
  ];
  const [x, y] = [key(a), key(b)];
  for (let i = 0; i < x.length; i++) {
    if (x[i] === y[i]) continue;
    return (x[i] as string | number) < (y[i] as string | number) ? -1 : 1;
  }
  return 0;
}

/** The folder of each repository: its name made safe, and `-2`, `-3` when a name is taken. */
export function folderNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    let base = name.replace(/[^A-Za-z0-9._-]/g, '-');
    if (base === '' || base === '.' || base === '..') base = 'repo';
    let folder = base;
    for (let n = 2; used.has(folder); n++) folder = `${base}-${n}`;
    used.add(folder);
    return folder;
  });
}

/** `true` when any repository is private, else `null` when any is unknown, else `false`. */
export function joinedPrivacy(repos: readonly Pick<RepoInfo, 'isPrivate'>[]): boolean | null {
  if (repos.some((r) => r.isPrivate === true)) return true;
  return repos.some((r) => r.isPrivate === null) ? null : false;
}

const withLetter = (letter: string) => (id: string) => `${letter}.${id}`;
const inFolder = (folder: string) => (path: string) => (path === '.' ? folder : `${folder}/${path}`);

function renameFile(file: ChangedFile, id: (s: string) => string, at: (s: string) => string): ChangedFile {
  return {
    ...file,
    id: id(file.id),
    path: at(file.path),
    oldPath: file.oldPath === null ? null : at(file.oldPath),
    hunks: file.hunks.map((h) => ({ ...h, id: id(h.id) })),
  };
}

/** One loaded source with the letter in front of every id and the folder in front of every path. */
function renameSource(
  { changeSet: cs, analysis: a }: LoadedSource,
  letter: string,
  folder: string,
): { changeSet: ChangeSet; analysis: Analysis } {
  const id = withLetter(letter);
  const at = inFolder(folder);
  const ref = (r: CodeRef): CodeRef => ({ ...r, path: at(r.path) });
  const changeSet: ChangeSet = {
    ...cs,
    files: cs.files.map((f) => renameFile(f, id, at)),
    commits: cs.commits.map((c) => ({ ...c, id: id(c.id) })),
    linkedIssues: cs.linkedIssues.map((i) => ({ ...i, id: id(i.id) })),
    repoContext: {
      ...cs.repoContext,
      tree: cs.repoContext.tree.map(at),
      manifests: cs.repoContext.manifests.map((m) => ({ ...m, path: at(m.path) })),
    },
  };
  const analysis: Analysis = {
    ...a,
    files: a.files.map((f) => ({
      ...f,
      fileId: id(f.fileId),
      path: at(f.path),
      componentId: id(f.componentId),
      symbolIds: f.symbolIds.map(id),
    })),
    components: a.components.map((m) => ({
      ...m,
      id: id(m.id),
      path: at(m.path),
      fileIds: m.fileIds.map(id),
    })),
    relationships: a.relationships.map((r) => ({
      ...r,
      from: id(r.from),
      to: id(r.to),
      evidence: id(r.evidence),
    })),
    symbols: a.symbols.map((s) => ({ ...s, id: id(s.id), fileId: id(s.fileId), path: at(s.path) })),
    keyHunks: a.keyHunks.map((k) => ({
      ...k,
      id: id(k.id),
      fileId: id(k.fileId),
      path: at(k.path),
      // "risk R1, R2" names ids.
      reasons: k.reasons.map((r) =>
        r.startsWith('risk ') ? `risk ${r.slice(5).split(', ').map(id).join(', ')}` : r,
      ),
    })),
    // shortcut: the title and detail of a risk may name a path, and keep the name it has inside its repository; join them with the folder if a reader gets confused.
    risks: a.risks.map((r) => ({
      ...r,
      id: id(r.id),
      evidence: r.evidence.map(id),
      ref: r.ref && ref(r.ref),
    })),
    dependencies: a.dependencies.map((d) => ({ ...d, id: id(d.id), fileId: id(d.fileId) })),
    tests: {
      added: a.tests.added.map(at),
      modified: a.tests.modified.map(at),
      removed: a.tests.removed.map(at),
    },
    architectureSignals: a.architectureSignals.map((s) => `${folder}: ${s}`),
    // shortcut: only the label of a file or a hunk gets the folder; other labels may hold a path as it is inside the repository.
    evidence: a.evidence
      .filter((e) => EVIDENCE_ORIGIN[e.kind] === 'source')
      .map((e) => ({
        ...e,
        id: id(e.id),
        label: e.kind === 'file' || e.kind === 'hunk' ? at(e.label) : e.label,
        ref: e.ref && ref(e.ref),
      })),
  };
  return { changeSet, analysis };
}

/** A path `<folder>/<rest>` goes to the reader of that folder with `<rest>`; any other path reads as missing. */
function joinedReader(parts: readonly { folder: string; reader: RepoReader }[]): RepoReader {
  return {
    readFile(path: string, side: Side): Promise<string | null> {
      for (const part of parts) {
        if (path.startsWith(`${part.folder}/`))
          return part.reader.readFile(path.slice(part.folder.length + 1), side);
      }
      return Promise.resolve(null);
    },
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

/** The first item of each list, then the second of each, and so on: for lists that have no rank across sources. */
function inTurns<T>(lists: readonly (readonly T[])[]): T[] {
  const out: T[] = [];
  const rows = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < rows; i++) for (const list of lists) if (i < list.length) out.push(list[i] as T);
  return out;
}

/** The README excerpts of the sources under their folder names, short enough that the total is what one source may have. */
function joinedReadme(parts: readonly ChangeSetPart[]): string | null {
  const room = Math.floor(README_MAX_CHARS / parts.length);
  const texts = parts.flatMap((p) => {
    if (!p.readmeExcerpt) return [];
    const head = `[${p.folder}]\n`;
    return [head + p.readmeExcerpt.slice(0, Math.max(0, room - head.length))];
  });
  return texts.length > 0 ? texts.join('\n\n') : null;
}

/** Join two to four loaded sources into one change set, one reader and one analysis. */
export function joinSources(loaded: readonly LoadedSource[]): LoadedSource {
  const sorted = [...loaded].sort((a, b) => compareSources(a.changeSet, b.changeSet));
  const same = sorted.find((s, i) => {
    const o = sorted[i - 1]?.changeSet;
    const c = s.changeSet;
    return o !== undefined && compareSources(o, c) === 0;
  });
  if (same) {
    throw new MergeStoryError('USAGE', 'The same source was given more than once.', {
      hint: 'Give each repository or pull request once.',
    });
  }
  const folders = folderNames(sorted.map((s) => s.changeSet.repo.name));
  const renamed = sorted.map((s, i) => renameSource(s, LETTERS[i] as string, folders[i] as string));

  const parts: ChangeSetPart[] = sorted.map(({ changeSet: cs }, i) => ({
    label: LETTERS[i] as string,
    folder: folders[i] as string,
    source: cs.source,
    repo: cs.repo,
    base: cs.base,
    head: cs.head,
    pr: cs.pr,
    stats: cs.stats,
    readmeExcerpt: cs.repoContext.readmeExcerpt,
  }));
  const first = (sorted[0] as LoadedSource).changeSet;
  const owners = new Set(sorted.map((s) => s.changeSet.repo.owner));
  const notes = parts.flatMap((p, i) => {
    const note = (sorted[i] as LoadedSource).changeSet.limits.note;
    return note ? [`${p.folder}: ${note}`] : [];
  });
  const changeSets = renamed.map((r) => r.changeSet);
  const changeSet: ChangeSet = {
    source: sorted.some((s) => s.changeSet.source === 'github') ? 'github' : 'local',
    repo: {
      host: first.repo.host,
      owner: owners.size === 1 ? (first.repo.owner ?? '') : '',
      name: folders.join(' + '),
      isPrivate: joinedPrivacy(sorted.map((s) => s.changeSet.repo)),
      defaultBranch: first.repo.defaultBranch,
      webUrl: null,
    },
    base: first.base,
    head: first.head,
    pr: null,
    linkedIssues: changeSets.flatMap((c) => c.linkedIssues),
    commits: changeSets.flatMap((c) => c.commits),
    files: changeSets.flatMap((c) => c.files),
    stats: {
      files: sum(parts.map((p) => p.stats.files)),
      additions: sum(parts.map((p) => p.stats.additions)),
      deletions: sum(parts.map((p) => p.stats.deletions)),
    },
    limits: {
      filesCapped: sorted.some((s) => s.changeSet.limits.filesCapped),
      commitsCapped: sorted.some((s) => s.changeSet.limits.commitsCapped),
      note: notes.length > 0 ? notes.join(' ') : null,
    },
    repoContext: {
      tree: changeSets.flatMap((c) => c.repoContext.tree),
      treeTruncated: changeSets.some((c) => c.repoContext.treeTruncated),
      readmeExcerpt: joinedReadme(parts),
      manifests: changeSets.flatMap((c) => c.repoContext.manifests),
    },
    parts,
  };

  const analyses = renamed.map((r) => r.analysis);
  const files = analyses.flatMap((a) => a.files);
  const churn = new Map(
    renamed.flatMap(({ changeSet: cs, analysis: a }) => {
      const trivial = new Set(a.files.filter((f) => f.trivial).map((f) => f.fileId));
      const lines = new Map(cs.files.map((f) => [f.id, f.additions + f.deletions]));
      return a.components.map((m): [string, number] => [
        m.id,
        sum(m.fileIds.filter((id) => !trivial.has(id)).map((id) => lines.get(id) ?? 0)),
      ]);
    }),
  );
  const components = analyses
    .flatMap((a) => a.components)
    .sort((a, b) => compareChurn(churn.get(a.id) ?? 0, churn.get(b.id) ?? 0));
  const meaningfulLines = sum(analyses.map((a) => a.meaningfulLines));
  const insightById = new Map(files.map((f) => [f.fileId, f]));
  const meaningfulComponents = components.filter((m) =>
    m.fileIds.some((id) => {
      const f = insightById.get(id);
      return f !== undefined && isMeaningfulFile(f);
    }),
  ).length;
  const languages = new Map<string, number>();
  for (const a of analyses)
    for (const l of a.languages) languages.set(l.language, (languages.get(l.language) ?? 0) + l.files);
  const evidence = [
    ...(sorted[0] as LoadedSource).analysis.evidence.filter((e) => EVIDENCE_ORIGIN[e.kind] === 'run'),
    ...analyses.flatMap((a) => a.evidence),
  ];
  const seen = new Set<string>();
  for (const item of evidence) {
    if (seen.has(item.id))
      throw new MergeStoryError(
        'INTERNAL',
        `The evidence id ${item.id} exists twice after joining the sources.`,
      );
    seen.add(item.id);
  }
  const analysis: Analysis = {
    version: 1,
    ...paceOf(meaningfulLines, meaningfulComponents),
    meaningfulLines,
    files,
    components,
    relationships: analyses.flatMap((a) => a.relationships).sort(compareRelationships),
    symbols: inTurns(analyses.map((a) => a.symbols)),
    keyHunks: analyses.flatMap((a) => a.keyHunks).sort(compareScores),
    risks: analyses.flatMap((a) => a.risks).sort(compareRiskClass),
    dependencies: inTurns(analyses.map((a) => a.dependencies)),
    tests: {
      added: analyses.flatMap((a) => a.tests.added),
      modified: analyses.flatMap((a) => a.tests.modified),
      removed: analyses.flatMap((a) => a.tests.removed),
    },
    languages: sortLanguages(languages),
    architectureSignals: inTurns(analyses.map((a) => a.architectureSignals)),
    evidence,
  };
  return {
    changeSet,
    analysis,
    reader: joinedReader(sorted.map((s, i) => ({ folder: folders[i] as string, reader: s.reader }))),
  };
}
