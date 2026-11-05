/**
 * Building the ChangeSet from what a source found. The GitHub and the local source each collect
 * neutral facts (files, commits, a tree listing, a way to read file contents); this module owns
 * everything the two have in common: the path policy and the `sensitive` flag, which files keep
 * their hunks, the file records, the guarded reader, the repository context, the limits and the
 * notes about them.
 */

import type { RunContext } from '../core/context.ts';
import { languageForPath } from '../core/languages.ts';
import { createPathPolicy } from '../core/path-policy.ts';
import type { LoadedSource } from '../core/providers.ts';
import type {
  ChangedFile,
  ChangeSet,
  CommitInfo,
  DiffHunk,
  FileStatus,
  LinkedIssue,
  PullRequestInfo,
  RepoInfo,
  Side,
} from '../core/types.ts';
import { hunkLimitNote, selectHunkFiles } from './hunk-selection.ts';
import { ISSUE_BODY_MAX_CHARS, MAX_LINKED_ISSUES, type SourceLimits } from './limits.ts';
import { createGuardedReader } from './reader.ts';
import { buildRepoContext } from './repo-context.ts';
import { cleanCommitMessage, cutText, sanitizeText } from './text.ts';

/** One changed file as the source found it. The builder adds the id, the language and the flags. */
export interface RawFile {
  path: string;
  oldPath: string | null;
  status: FileStatus;
  additions: number;
  deletions: number;
  /** The source knows this is a binary file. */
  binary: boolean;
  /**
   * The counts cannot be trusted: the source has no patch for a text file and reports no changed
   * lines (GitHub does this for a page of files over its size budget). The file still needs its hunks.
   */
  unreadable: boolean;
  /** The source can give this file's hunks. When false, a file with changed lines counts as "no code". */
  hasHunks: boolean;
}

export interface RawCommit {
  sha: string;
  /** The full message. The builder cuts it and masks secrets. */
  message: string;
}

export interface RawIssue {
  number: number;
  title: string;
  /** The whole body. The builder masks secrets in all of it before it cuts it. */
  body: string;
  url: string;
}

/** The sentences a source uses for the `limits.note` of its change set. */
export interface SourceNotes {
  /** The file list is incomplete: `shown` files of `total`. */
  filesCapped(shown: number, total: number): string;
  /** Changed files that have no code to show (`count` of them). Only for a source that can lack patches. */
  withoutPatch?(count: number): string;
  /** The commit list is incomplete: `shown` commits of `total`. */
  commitsCapped(shown: number, total: number): string;
}

export interface RawChange {
  source: ChangeSet['source'];
  repo: RepoInfo;
  base: ChangeSet['base'];
  head: ChangeSet['head'];
  /** The pull request, with its text as written (the builder masks it). Null for a local change. */
  pr: PullRequestInfo | null;
  issues: readonly RawIssue[];
  /** All changed files, in the order of the change. The builder lists the first `limits.maxFiles`. */
  files: readonly RawFile[];
  /** True when the source itself could not list every file. */
  filesCapped: boolean;
  /** Totals the source reports for the whole change, when it has them. Otherwise the files are summed. */
  totals: { files: number; additions: number; deletions: number } | null;
  commits: { items: readonly RawCommit[]; total: number; capped: boolean };
  /** File paths at head. Directory entries end with "/". */
  tree: { paths: readonly string[]; truncated: boolean };
  /** Hunks of the files at these positions (those that fit the limits). A missing entry means "not available". */
  loadHunks(selected: readonly number[]): Promise<Map<number, DiffHunk[]>>;
  /** Read one file at one side of the change; null when it is missing, binary or too large. */
  loadFile(path: string, side: Side): Promise<string | null>;
  notes: SourceNotes;
}

/** The evidence id of the file at a position in the change. */
export function fileId(index: number): string {
  return `F${index + 1}`;
}

export async function assembleChangeSet(
  raw: RawChange,
  ctx: RunContext,
  limits: SourceLimits,
): Promise<LoadedSource> {
  const privacy = ctx.config.privacy;
  const isProtected = createPathPolicy(privacy.excludePaths);

  const listed = raw.files.slice(0, limits.maxFiles);
  const sensitiveFlags = listed.map(
    (file) => isProtected(file.path) || (file.oldPath !== null && isProtected(file.oldPath)),
  );
  const selection = selectHunkFiles(
    listed.flatMap((file, index) =>
      !sensitiveFlags[index] && !file.binary && file.hasHunks && file.additions + file.deletions > 0
        ? [{ index, changedLines: file.additions + file.deletions }]
        : [],
    ),
    limits,
  );
  const hunks = await raw.loadHunks(selection.selected);

  let withoutPatch = 0;
  const files: ChangedFile[] = listed.map((file, index) => {
    const sensitive = sensitiveFlags[index] === true;
    const found = hunks.get(index) ?? [];
    const wantsHunks = !sensitive && !file.binary && (file.additions + file.deletions > 0 || file.unreadable);
    if (wantsHunks && !file.hasHunks) withoutPatch++;
    return {
      id: fileId(index),
      path: file.path,
      oldPath: file.oldPath,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      binary: file.binary,
      language: languageForPath(file.path),
      hunks: found,
      patchTruncated: wantsHunks && found.length === 0,
      sensitive,
    };
  });

  const reader = createGuardedReader({ isProtected, load: raw.loadFile });

  const pr: PullRequestInfo | null = raw.pr && {
    ...raw.pr,
    title: sanitizeText(raw.pr.title, privacy),
    body: sanitizeText(raw.pr.body, privacy),
  };
  const commits: CommitInfo[] = raw.commits.items.map((commit, index) => ({
    id: `CM${index + 1}`,
    sha: commit.sha,
    ...cleanCommitMessage(commit.message, privacy),
  }));
  const linkedIssues: LinkedIssue[] = raw.issues.slice(0, MAX_LINKED_ISSUES).map((issue, index) => ({
    id: `IS${index + 1}`,
    number: issue.number,
    title: sanitizeText(issue.title, privacy),
    body: cutText(sanitizeText(issue.body, privacy), ISSUE_BODY_MAX_CHARS),
    url: issue.url,
  }));

  const repoContext = await buildRepoContext({
    paths: raw.tree.paths,
    pathsTruncated: raw.tree.truncated,
    readHead: (path) => reader.readFile(path, 'head'),
    isProtected,
    privacy,
  });

  const stats = raw.totals
    ? {
        files: Math.max(raw.totals.files, files.length),
        additions: raw.totals.additions,
        deletions: raw.totals.deletions,
      }
    : {
        files: raw.files.length,
        additions: raw.files.reduce((sum, f) => sum + f.additions, 0),
        deletions: raw.files.reduce((sum, f) => sum + f.deletions, 0),
      };
  const totalCommits = Math.max(raw.commits.total, commits.length);
  const filesListIncomplete = stats.files > files.length || raw.filesCapped;
  const commitsCapped = totalCommits > commits.length || raw.commits.capped;

  const notes: string[] = [];
  if (filesListIncomplete) notes.push(raw.notes.filesCapped(files.length, stats.files));
  const hunkNote = hunkLimitNote(files.length, selection, limits);
  if (hunkNote) notes.push(hunkNote);
  if (withoutPatch > 0 && raw.notes.withoutPatch) notes.push(raw.notes.withoutPatch(withoutPatch));
  if (commitsCapped) notes.push(raw.notes.commitsCapped(commits.length, totalCommits));

  const changeSet: ChangeSet = {
    source: raw.source,
    repo: raw.repo,
    base: raw.base,
    head: raw.head,
    pr,
    linkedIssues,
    commits,
    files,
    stats,
    limits: {
      filesCapped: filesListIncomplete || selection.overCap.size > 0,
      commitsCapped,
      note: notes.length > 0 ? notes.join(' ') : null,
    },
    repoContext,
  };
  return { changeSet, reader };
}
