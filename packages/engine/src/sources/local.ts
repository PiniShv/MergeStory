/**
 * The local git source: explain the committed changes of a repository on this machine.
 *
 * Only git's object database is read (diff, log, cat-file, ls-tree). Nothing is written to the
 * repository and its working tree is never touched.
 */
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { mapLimit } from '../core/concurrency.ts';
import type { RunContext } from '../core/context.ts';
import { MergeStoryError } from '../core/errors.ts';
import { isInside } from '../core/posix.ts';
import type { LoadedSource, SourceInput, SourceProvider } from '../core/providers.ts';
import { decodeTextBlob } from '../core/text.ts';
import type { DiffHunk, FileStatus, RepoInfo } from '../core/types.ts';
import { webHostFromApiUrl } from '../github/pr-url.ts';
import { assembleChangeSet, fileId, type RawChange, type RawCommit } from './assemble.ts';
import { parsePatchHunks } from './diff-parser.ts';
import { GitOutputTooLargeError, GitRunner, MAX_PARALLEL_GIT } from './git.ts';
import { DEFAULT_SOURCE_LIMITS, MAX_READ_BYTES, type SourceLimits } from './limits.ts';
import { parseGitHubRemote } from './remote.ts';

/** Flags shared by every diff, so output does not depend on the user's git configuration. */
const DIFF_FLAGS = [
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--find-renames',
  '--ignore-submodules=none',
  '--submodule=short',
  '--src-prefix=a/',
  '--dst-prefix=b/',
];

const MAX_PATCH_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_TREE_OUTPUT_BYTES = 16 * 1024 * 1024;
const STATUS_TIMEOUT_MS = 8000;

export interface LocalGitSourceOptions {
  /** Override the default size limits (mainly useful in tests). */
  limits?: Partial<SourceLimits>;
}

interface FileEntry {
  path: string;
  oldPath: string | null;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

// ---------------------------------------------------------------------------
// Parsing of git's machine-readable output
// ---------------------------------------------------------------------------

function splitNul(output: string): string[] {
  const tokens = output.split('\0');
  if (tokens.length > 0 && tokens[tokens.length - 1] === '') tokens.pop();
  return tokens;
}

const STATUS_BY_LETTER: Record<string, FileStatus> = {
  A: 'added',
  D: 'deleted',
  M: 'modified',
  T: 'modified',
};

/** Parse `git diff --name-status -z`. For renames and copies `path` is the new path. */
export function parseNameStatus(
  output: string,
): { path: string; oldPath: string | null; status: FileStatus }[] {
  const tokens = splitNul(output);
  const entries: { path: string; oldPath: string | null; status: FileStatus }[] = [];
  for (let i = 0; i < tokens.length; ) {
    const letter = tokens[i]!.charAt(0);
    if (letter === 'R' || letter === 'C') {
      const oldPath = tokens[i + 1];
      const path = tokens[i + 2];
      if (oldPath === undefined || path === undefined) break;
      entries.push({ path, oldPath, status: letter === 'R' ? 'renamed' : 'copied' });
      i += 3;
    } else {
      const path = tokens[i + 1];
      if (path === undefined) break;
      entries.push({ path, oldPath: null, status: STATUS_BY_LETTER[letter] ?? 'modified' });
      i += 2;
    }
  }
  return entries;
}

/** Parse `git diff --numstat -z` into counts keyed by the (new) path. Binary files show "-". */
export function parseNumstat(
  output: string,
): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const tokens = splitNul(output);
  const counts = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (let i = 0; i < tokens.length; ) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(tokens[i]!);
    if (!match) {
      i++;
      continue;
    }
    const binary = match[1] === '-' || match[2] === '-';
    const value = {
      additions: binary ? 0 : Number(match[1]),
      deletions: binary ? 0 : Number(match[2]),
      binary,
    };
    if (match[3] === '') {
      // A rename or copy: the old and new paths follow as separate tokens.
      const path = tokens[i + 2];
      if (path !== undefined) counts.set(path, value);
      i += 3;
    } else {
      counts.set(match[3]!, value);
      i += 1;
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

function invalidRef(ref: string): MergeStoryError {
  return new MergeStoryError('SOURCE_INVALID', `Not a usable git ref: ${JSON.stringify(ref.slice(0, 80))}.`, {
    hint: 'Pass a branch name, a tag or a commit id.',
  });
}

/** Refs that look like options, or hold control characters, are never passed to git. */
function assertSafeRef(ref: string | null): void {
  if (ref === null) return;
  if (ref === '' || ref.startsWith('-') || /[\0\r\n]/.test(ref)) throw invalidRef(ref);
}

async function resolveCommit(git: GitRunner, ref: string): Promise<string | null> {
  const result = await git.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (result.code !== 0) return null;
  const sha = result.stdout.trim().toLowerCase();
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

/**
 * A commit by name. A branch that exists only as origin/<name> is found there: a CI checkout
 * (actions/checkout) creates no local branch for the base, so `--base main` has to mean origin/main.
 */
async function requireCommit(git: GitRunner, ref: string, ctx: RunContext): Promise<string> {
  const sha = await resolveCommit(git, ref);
  if (sha) return sha;
  const remote = await resolveCommit(git, `refs/remotes/origin/${ref}`);
  if (remote) {
    ctx.progress({
      stage: 'source',
      status: 'progress',
      message: `There is no local "${ref}", so origin/${ref} is used.`,
    });
    return remote;
  }
  throw new MergeStoryError('SOURCE_NOT_FOUND', `Could not find "${ref}" in this repository.`, {
    hint:
      ref === 'HEAD'
        ? 'The repository has no commits yet. Commit something first.'
        : 'Check the name with "git branch -a" or "git tag". If it only exists on the remote, fetch it first (for example: git fetch origin <branch>). In CI, check out the whole history (actions/checkout with fetch-depth: 0).',
  });
}

/** The branch changes are compared against: origin/HEAD, else main, else master. */
async function discoverDefaultBranch(git: GitRunner): Promise<{ sha: string; label: string } | null> {
  // The remote branch comes before the local one: it is usually newer than a local copy of it.
  const fixed = ['main', 'master'].flatMap((name) => [
    { ref: `refs/remotes/origin/${name}`, label: name },
    { ref: `refs/heads/${name}`, label: name },
  ]);
  const [symbolic, ...resolved] = await Promise.all([
    git.run(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']),
    ...fixed.map((candidate) => resolveCommit(git, candidate.ref)),
  ]);
  const originHead = symbolic.code === 0 ? symbolic.stdout.trim() : '';
  if (originHead) {
    const sha = await resolveCommit(git, originHead);
    if (sha) return { sha, label: originHead.replace(/^refs\/remotes\/[^/]+\//, '') };
  }
  for (const [index, candidate] of fixed.entries()) {
    const sha = resolved[index];
    if (sha) return { sha, label: candidate.label };
  }
  return null;
}

async function currentBranch(git: GitRunner): Promise<string | null> {
  const result = await git.run(['symbolic-ref', '--short', '--quiet', 'HEAD']);
  const name = result.stdout.trim();
  return result.code === 0 && name ? name : null;
}

interface Range {
  baseLabel: string;
  headLabel: string;
  /** The merge base, which is what the diff is taken against. */
  baseSha: string;
  headSha: string;
  defaultBranch: string | null;
  headIsCheckedOut: boolean;
}

async function resolveRange(
  git: GitRunner,
  input: Extract<SourceInput, { kind: 'local' }>,
  ctx: RunContext,
): Promise<Range> {
  const baseInput = input.base?.trim() || null;
  const headInput = input.head?.trim() || null;
  assertSafeRef(baseInput);
  assertSafeRef(headInput);

  // These lookups do not depend on each other; errors are reported in a fixed order.
  const [headResult, branchResult, defaultResult, baseResult] = await Promise.allSettled([
    requireCommit(git, headInput ?? 'HEAD', ctx),
    currentBranch(git),
    discoverDefaultBranch(git),
    baseInput ? requireCommit(git, baseInput, ctx) : Promise.resolve(null),
  ]);
  if (headResult.status === 'rejected') throw headResult.reason;
  if (baseResult.status === 'rejected') throw baseResult.reason;
  if (branchResult.status === 'rejected') throw branchResult.reason;
  if (defaultResult.status === 'rejected') throw defaultResult.reason;
  const headSha = headResult.value;
  const headLabel = headInput && headInput !== 'HEAD' ? headInput : (branchResult.value ?? 'HEAD');
  const defaultBranch = defaultResult.value;

  let baseTip: { sha: string; label: string };
  if (baseInput && baseResult.value) {
    baseTip = { sha: baseResult.value, label: baseInput };
  } else if (defaultBranch) {
    baseTip = defaultBranch;
  } else {
    throw new MergeStoryError(
      'SOURCE_INVALID',
      'Could not tell which branch to compare against (no origin/HEAD, main or master).',
      {
        hint: 'Pass --base <branch-or-commit>. In CI, fetch the history first (for example actions/checkout with fetch-depth: 0).',
      },
    );
  }

  // The diff of a pull request starts at the merge base, so changes made on the base branch
  // after the branch was cut do not show up as if the branch had made them.
  const mergeBase = await git.run(['merge-base', baseTip.sha, headSha]);
  let baseSha = mergeBase.stdout.trim().toLowerCase();
  if (mergeBase.code !== 0 || !/^[0-9a-f]{40,64}$/.test(baseSha)) {
    ctx.progress({
      stage: 'source',
      status: 'warn',
      message:
        'No common ancestor was found for the base and head (is this a shallow clone?). Comparing with the base directly.',
    });
    baseSha = baseTip.sha;
  }
  if (baseSha === headSha) {
    throw new MergeStoryError(
      'SOURCE_INVALID',
      `There are no committed changes to explain: ${headLabel} has nothing that ${baseTip.label} lacks.`,
      {
        hint: 'Commit your work first (uncommitted changes are not included), or choose another range with --base and --head.',
      },
    );
  }
  return {
    baseLabel: baseTip.label,
    headLabel,
    baseSha,
    headSha,
    defaultBranch: defaultBranch?.label ?? null,
    headIsCheckedOut: headInput === null || headInput === 'HEAD',
  };
}

// ---------------------------------------------------------------------------
// Files and hunks
// ---------------------------------------------------------------------------

async function listEntries(git: GitRunner, range: Range): Promise<FileEntry[]> {
  const common = ['diff', ...DIFF_FLAGS, '-z'];
  const target = [range.baseSha, range.headSha, '--'];
  const [nameStatus, numstat] = await Promise.all([
    git.ok([...common, '--name-status', ...target]),
    git.ok([...common, '--numstat', ...target]),
  ]);
  const counts = parseNumstat(numstat);
  return parseNameStatus(nameStatus).map((entry) => {
    const count = counts.get(entry.path);
    return {
      path: entry.path,
      oldPath: entry.oldPath,
      status: entry.status,
      additions: count?.additions ?? 0,
      deletions: count?.deletions ?? 0,
      binary: count?.binary ?? false,
    };
  });
}

/** The hunks of one file, or null when they cannot be read or do not match git's counts. */
async function readHunks(
  git: GitRunner,
  range: Range,
  entry: FileEntry,
  id: string,
  ctx: RunContext,
): Promise<DiffHunk[] | null> {
  // Both names of a rename are given, so git still sees it as a rename and diffs the two files.
  const paths =
    entry.oldPath !== null && entry.oldPath !== entry.path ? [entry.oldPath, entry.path] : [entry.path];
  try {
    const output = await git.ok(
      ['diff', ...DIFF_FLAGS, '-U3', range.baseSha, range.headSha, '--', ...paths],
      { literalPathspecs: true, maxOutputBytes: MAX_PATCH_OUTPUT_BYTES },
    );
    // A file that changed type (for example a file replaced by a symlink) comes as two sections.
    const hunks = (output.match(/^diff --git /gm)?.length ?? 0) === 1 ? parsePatchHunks(output, id) : [];
    let additions = 0;
    let deletions = 0;
    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        if (line.kind === 'add') additions++;
        else if (line.kind === 'del') deletions++;
      }
    }
    if (hunks.length === 0 || additions !== entry.additions || deletions !== entry.deletions) {
      ctx.logger.debug('Diff of a file did not match its counts; leaving its hunks out', { file: id });
      return null;
    }
    return hunks;
  } catch (error) {
    if (error instanceof GitOutputTooLargeError) return null;
    if (error instanceof MergeStoryError && error.code === 'GIT_FAILED') {
      ctx.logger.warn('Could not read the diff of one file; leaving its hunks out', { file: id });
      return null;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Commits, tree and repository info
// ---------------------------------------------------------------------------

async function readCommits(
  git: GitRunner,
  range: Range,
  limits: SourceLimits,
): Promise<{ commits: RawCommit[]; total: number }> {
  const spec = `${range.baseSha}..${range.headSha}`;
  const total = Number((await git.ok(['rev-list', '--count', spec, '--'])).trim());
  const count = Number.isFinite(total) ? total : 0;
  // Keep the oldest commits, as GitHub does: skip the newest ones, then print oldest first.
  const skip = Math.max(0, count - limits.maxCommits);
  const output = await git.ok([
    'log',
    '--encoding=UTF-8',
    '--reverse',
    `--skip=${skip}`,
    `--max-count=${limits.maxCommits}`,
    '-z',
    '--format=%H%x1f%B',
    spec,
    '--',
  ]);
  const commits: RawCommit[] = [];
  // A commit message cannot hold a NUL byte, so no message can add a record of its own.
  for (const record of splitNul(output)) {
    const trimmed = record.replace(/^\n+/, '');
    const separator = trimmed.indexOf('\x1f');
    if (separator < 0) continue;
    const sha = trimmed.slice(0, separator).trim().toLowerCase();
    if (!/^[0-9a-f]{40,64}$/.test(sha)) continue;
    commits.push({ sha, message: trimmed.slice(separator + 1) });
  }
  return { commits, total: count };
}

async function readTreePaths(
  git: GitRunner,
  headSha: string,
): Promise<{ paths: string[]; truncated: boolean }> {
  try {
    const output = await git.ok(['ls-tree', '-r', '--name-only', '-z', headSha], {
      maxOutputBytes: MAX_TREE_OUTPUT_BYTES,
    });
    return { paths: splitNul(output), truncated: false };
  } catch (error) {
    if (!(error instanceof GitOutputTooLargeError)) throw error;
  }
  // Too many files to list: fall back to the top level only.
  const output = await git.ok(['ls-tree', '-z', headSha], { maxOutputBytes: MAX_TREE_OUTPUT_BYTES });
  const paths: string[] = [];
  for (const line of splitNul(output)) {
    const match = /^\d+ (\w+) [0-9a-f]+\t([\s\S]*)$/.exec(line);
    if (match) paths.push(match[1] === 'tree' ? `${match[2]}/` : match[2]!);
  }
  return { paths, truncated: true };
}

async function readRepoInfo(
  git: GitRunner,
  toplevel: string,
  defaultBranch: string | null,
  ctx: RunContext,
): Promise<RepoInfo> {
  const trusted = new Set<string>(['github.com']);
  const configured = webHostFromApiUrl(ctx.config.github.apiUrl);
  if (configured) trusted.add(configured);

  const remote = await git.run(['remote', 'get-url', 'origin']);
  // The URL may hold a token; only owner and name are taken from it, and it is never logged.
  const parsed = remote.code === 0 ? parseGitHubRemote(remote.stdout, trusted) : null;
  if (parsed) {
    return {
      host: parsed.host,
      owner: parsed.owner,
      name: parsed.name,
      isPrivate: null,
      defaultBranch,
      webUrl: `https://${parsed.host}/${parsed.owner}/${parsed.name}`,
    };
  }
  return {
    host: 'local',
    owner: null,
    name: basename(toplevel),
    isPrivate: null,
    defaultBranch,
    webUrl: null,
  };
}

/** Warn when the working tree has changes that are not committed. Never fails: it is a courtesy. */
async function warnAboutUncommittedChanges(git: GitRunner, ctx: RunContext): Promise<void> {
  try {
    const result = await git.run(['status', '--porcelain=v1', '-z', '--untracked-files=normal'], {
      timeoutMs: STATUS_TIMEOUT_MS,
      maxOutputBytes: 1024 * 1024,
    });
    const count = result.code === 0 ? splitNul(result.stdout).length : 0;
    if (count > 0) {
      ctx.progress({
        stage: 'source',
        status: 'warn',
        message: `${count} uncommitted change${count === 1 ? ' is' : 's are'} in the working tree and not included: only committed changes are explained.`,
      });
    }
  } catch {
    // A slow or failing status check must not stop the run. A cancelled run stops at its next step.
  }
}

/**
 * Read one file at a commit. `cat-file` prints the stored bytes as they are (`git show` may run
 * text conversion programs named in configuration). Anything that is not a small text blob
 * (a directory, a submodule, a binary or oversized file, a missing path) reads as null.
 */
async function readBlob(git: GitRunner, sha: string, path: string): Promise<string | null> {
  const spec = `${sha}:${path}`;
  const size = await git.run(['cat-file', '-s', spec]);
  const bytes = Number(size.stdout.trim());
  if (size.code !== 0 || !Number.isFinite(bytes) || bytes > MAX_READ_BYTES) return null;
  try {
    const blob = await git.run(['cat-file', 'blob', spec], { maxOutputBytes: MAX_READ_BYTES + 1024 });
    // Directories and submodules are not blobs and fail here.
    return blob.code === 0 ? decodeTextBlob(blob.stdoutBuffer) : null;
  } catch (error) {
    if (error instanceof GitOutputTooLargeError) return null;
    throw error;
  }
}

async function assertDirectory(path: string, shown: string): Promise<void> {
  try {
    const info = await stat(path);
    if (info.isDirectory()) return;
  } catch {
    throw new MergeStoryError('SOURCE_NOT_FOUND', `The path "${shown}" does not exist.`, {
      hint: 'Pass the path of a git repository, or a pull request URL.',
    });
  }
  throw new MergeStoryError('SOURCE_INVALID', `The path "${shown}" is not a directory.`, {
    hint: 'Pass the path of a git repository, or a pull request URL.',
  });
}

async function findToplevel(repoPath: string, shown: string, ctx: RunContext): Promise<string> {
  const git = new GitRunner(repoPath, ctx);
  const result = await git.run(['rev-parse', '--show-toplevel']);
  const toplevel = result.stdout.trim();
  if (result.code === 0 && toplevel) return toplevel;
  if (/dubious ownership/i.test(result.stderr)) throw git.failure('rev-parse', result);
  throw new MergeStoryError('SOURCE_INVALID', `"${shown}" is not inside a git work tree.`, {
    hint: 'Run MergeStory inside a git repository, pass the path of one, or give a pull request URL.',
  });
}

/** A path with its links resolved. The part that does not exist yet is kept as it is. */
async function resolvedLocation(path: string): Promise<string> {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(await realpath(current), ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      missing.push(basename(current));
      current = parent;
    }
  }
}

/**
 * MergeStory never writes into the repository it explains. The run folder comes from --out, the
 * config file or MERGESTORY_HOME, so the check is made here, where the top of the work tree is known,
 * and not only on the flag.
 */
async function assertRunFolderOutside(toplevel: string, runDir: string): Promise<void> {
  const [root, folder] = await Promise.all([resolvedLocation(toplevel), resolvedLocation(runDir)]);
  if (isInside(root, folder)) {
    throw new MergeStoryError('USAGE', 'The run folder is inside the repository being explained.', {
      hint: 'MergeStory never writes into the repository. Choose a folder outside it with --out, or move MERGESTORY_HOME out of the repository.',
    });
  }
}

// ---------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------

/**
 * Reads a change from a local repository: the commits between the merge base of the base and
 * head refs and the head ref. Base defaults to the merge base of HEAD with the default branch
 * (origin/HEAD, else main, else master); head defaults to HEAD.
 *
 * Only committed state is read. Uncommitted and untracked changes are never included, and the
 * working tree is never touched (a warning says when there are uncommitted changes).
 */
export class LocalGitSource implements SourceProvider {
  readonly id = 'local' as const;
  private readonly limits: SourceLimits;

  constructor(options: LocalGitSourceOptions = {}) {
    this.limits = { ...DEFAULT_SOURCE_LIMITS, ...options.limits };
  }

  async load(input: SourceInput, ctx: RunContext): Promise<LoadedSource> {
    if (input.kind !== 'local') {
      throw new MergeStoryError('USAGE', 'The local source needs a repository path.', {
        hint: 'Pass a path, or use the GitHub source for a pull request URL.',
      });
    }
    const repoPath = resolve(input.repoPath);
    await assertDirectory(repoPath, input.repoPath);
    const toplevel = await findToplevel(repoPath, input.repoPath, ctx);
    await assertRunFolderOutside(toplevel, ctx.runDir);
    const git = new GitRunner(toplevel, ctx);

    const range = await resolveRange(git, input, ctx);
    // The check only produces a warning, so it runs alongside the real work and is awaited at the end.
    const dirtyCheck = range.headIsCheckedOut ? warnAboutUncommittedChanges(git, ctx) : Promise.resolve();
    const entries = await listEntries(git, range);
    if (entries.length === 0) {
      throw new MergeStoryError(
        'SOURCE_INVALID',
        `There are no file changes between ${range.baseLabel} and ${range.headLabel}.`,
        {
          hint: 'Choose another range with --base and --head.',
        },
      );
    }
    const listed = entries.slice(0, this.limits.maxFiles);
    const [{ commits, total }, tree, repo] = await Promise.all([
      readCommits(git, range, this.limits),
      readTreePaths(git, range.headSha),
      readRepoInfo(git, toplevel, range.defaultBranch, ctx),
    ]);

    const raw: RawChange = {
      source: 'local',
      repo,
      base: { ref: range.baseLabel, sha: range.baseSha },
      head: { ref: range.headLabel, sha: range.headSha },
      pr: null,
      issues: [],
      files: entries.map((entry) => ({ ...entry, unreadable: false, hasHunks: true })),
      filesCapped: false,
      totals: null,
      commits: { items: commits, total, capped: false },
      tree,
      loadHunks: async (selected) => {
        const hunks = new Map<number, DiffHunk[]>();
        await mapLimit(selected, MAX_PARALLEL_GIT, async (index) => {
          const found = await readHunks(git, range, listed[index]!, fileId(index), ctx);
          if (found) hunks.set(index, found);
        });
        return hunks;
      },
      loadFile: (path, side) => readBlob(git, side === 'base' ? range.baseSha : range.headSha, path),
      notes: {
        filesCapped: (shown, count) => `Only the first ${shown} of ${count} changed files are listed.`,
        commitsCapped: (shown, count) => `Only the oldest ${shown} of ${count} commits are listed.`,
      },
    };
    const loaded = await assembleChangeSet(raw, ctx, this.limits);
    await dirtyCheck;
    ctx.logger.debug('local source loaded', {
      files: loaded.changeSet.files.length,
      commits: loaded.changeSet.commits.length,
      hunkFiles: loaded.changeSet.files.filter((file) => file.hunks.length > 0).length,
    });
    return loaded;
  }
}
