/**
 * The GitHub source: explain a pull request from the GitHub API. Nothing is cloned.
 *
 * The base of the change is the merge base of the pull request, not the tip of the base branch:
 * the patches GitHub returns are relative to it, and file contents at "base" are read at it.
 */

import { isLikelyBinaryPath } from '../core/binary-paths.ts';
import type { RunContext } from '../core/context.ts';
import { isMergeStoryError, MergeStoryError } from '../core/errors.ts';
import type { LoadedSource, SourceInput, SourceProvider } from '../core/providers.ts';
import type { FileStatus, RepoInfo } from '../core/types.ts';
import { GitHubClient } from '../github/client.ts';
import { findLinkedIssues } from '../github/linked-issues.ts';
import type { GitHubIssue, GitHubPrFile, GitHubPullRequest, GitHubRepo } from '../github/model.ts';
import { parsePullRequestUrl } from '../github/pr-url.ts';
import { assembleChangeSet, fileId, type RawChange, type RawFile } from './assemble.ts';
import { parsePatchHunks } from './diff-parser.ts';
import { DEFAULT_SOURCE_LIMITS, MAX_LINKED_ISSUES, MAX_READ_BYTES, type SourceLimits } from './limits.ts';

export interface GitHubSourceOptions {
  /** Override the default size limits (mainly useful in tests). */
  limits?: Partial<SourceLimits>;
}

function mapStatus(status: string): FileStatus {
  switch (status) {
    case 'added':
      return 'added';
    case 'removed':
      return 'deleted';
    case 'renamed':
      return 'renamed';
    case 'copied':
      return 'copied';
    default:
      return 'modified';
  }
}

/** True when GitHub could not compute the comparison, so the pull request's own base is used instead. */
function isComparisonUnavailable(error: unknown): boolean {
  if (!isMergeStoryError(error)) return false;
  const status = error.details?.status;
  return status === 404 || status === 409 || status === 422;
}

function repoInfo(repo: GitHubRepo, webHost: string): RepoInfo {
  let webUrl = `https://${webHost}/${repo.owner}/${repo.name}`;
  if (repo.htmlUrl) {
    try {
      const url = new URL(repo.htmlUrl);
      if ((url.protocol === 'https:' || url.protocol === 'http:') && url.host.toLowerCase() === webHost) {
        webUrl = url.origin + url.pathname.replace(/\/+$/, '');
      }
    } catch {
      // Keep the address built from the host and name.
    }
  }
  return {
    host: webHost,
    owner: repo.owner,
    name: repo.name,
    isPrivate: repo.isPrivate,
    defaultBranch: repo.defaultBranch,
    webUrl,
  };
}

async function loadTree(client: GitHubClient, sha: string): Promise<{ paths: string[]; truncated: boolean }> {
  const full = await client.getTree(sha, { recursive: true });
  if (!full.truncated) {
    return { paths: full.entries.filter((e) => e.type !== 'tree').map((e) => e.path), truncated: false };
  }
  // The full listing was cut off, so only the top level can be trusted.
  const top = await client.getTree(sha);
  return { paths: top.entries.map((e) => (e.type === 'tree' ? `${e.path}/` : e.path)), truncated: true };
}

/**
 * Patches are relative to the merge base, so that commit is the base of the change. When GitHub
 * cannot work it out, the base of the pull request is used.
 */
async function mergeBaseOf(client: GitHubClient, pr: GitHubPullRequest, ctx: RunContext): Promise<string> {
  try {
    return (await client.compare(pr.baseSha, pr.headSha)).mergeBaseSha;
  } catch (error) {
    if (!isComparisonUnavailable(error)) throw error;
    ctx.progress({
      stage: 'source',
      status: 'warn',
      message:
        'GitHub could not work out the merge base; the base commit of the pull request is used instead.',
    });
    return pr.baseSha;
  }
}

function rawFile(file: GitHubPrFile): RawFile {
  return {
    path: file.filename,
    oldPath: file.previousFilename,
    status: mapStatus(file.status),
    additions: file.additions,
    deletions: file.deletions,
    binary:
      file.patch === null &&
      !file.suspect &&
      file.changes === 0 &&
      file.additions === 0 &&
      file.deletions === 0 &&
      isLikelyBinaryPath(file.filename),
    unreadable: file.suspect,
    hasHunks: file.patch !== null,
  };
}

/** Reads a pull request through the GitHub API. */
export class GitHubSource implements SourceProvider {
  readonly id = 'github' as const;
  private readonly limits: SourceLimits;

  constructor(options: GitHubSourceOptions = {}) {
    this.limits = { ...DEFAULT_SOURCE_LIMITS, ...options.limits };
  }

  async load(input: SourceInput, ctx: RunContext): Promise<LoadedSource> {
    if (input.kind !== 'github') {
      throw new MergeStoryError('USAGE', 'The GitHub source needs a pull request URL.', {
        hint: 'Pass https://github.com/<owner>/<repo>/pull/<number>, or use the local source for a path.',
      });
    }
    const ref = parsePullRequestUrl(input.url, ctx.config.github.apiUrl);
    const client = await GitHubClient.create(ref, ctx, { stage: 'source' });

    const [pr, repo] = await Promise.all([client.getPullRequest(), client.getRepo()]);

    /** Parts that improve the result but are not needed for it: a failure becomes a warning. */
    const optional = async <T>(what: string, task: Promise<T>, fallback: T): Promise<T> => {
      try {
        return await task;
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        ctx.progress({
          stage: 'source',
          status: 'warn',
          message: `Could not read ${what} from GitHub: ${reason}`,
        });
        return fallback;
      }
    };
    const [baseSha, filesResult, commitsResult, issues, tree] = await Promise.all([
      mergeBaseOf(client, pr, ctx),
      client.listPullRequestFiles({ maxFiles: this.limits.maxFiles }),
      client.listPullRequestCommits(this.limits.maxCommits),
      optional<GitHubIssue[]>('linked issues', findLinkedIssues(client, ctx, pr.body, MAX_LINKED_ISSUES), []),
      optional<{ paths: string[]; truncated: boolean }>('the repository tree', loadTree(client, pr.headSha), {
        paths: [],
        truncated: true,
      }),
    ]);

    const listed = filesResult.files.slice(0, this.limits.maxFiles);
    const raw: RawChange = {
      source: 'github',
      repo: repoInfo(repo, ref.webHost),
      base: { ref: pr.baseRef, sha: baseSha },
      head: { ref: pr.headRef, sha: pr.headSha },
      pr: {
        number: pr.number || ref.number,
        title: pr.title,
        body: pr.body,
        url: pr.htmlUrl || `https://${ref.webHost}/${ref.owner}/${ref.repo}/pull/${ref.number}`,
        author: pr.author,
        baseRef: pr.baseRef,
        headRef: pr.headRef,
        labels: pr.labels,
        draft: pr.draft,
        state: pr.state,
      },
      issues,
      files: listed.map(rawFile),
      filesCapped: filesResult.capped,
      totals:
        pr.changedFiles > 0
          ? { files: pr.changedFiles, additions: pr.additions, deletions: pr.deletions }
          : null,
      commits: {
        items: commitsResult.commits,
        total: pr.commits,
        capped: commitsResult.capped,
      },
      tree,
      loadHunks: async (selected) =>
        new Map(selected.map((index) => [index, parsePatchHunks(listed[index]!.patch ?? '', fileId(index))])),
      loadFile: (path, side) =>
        client.getFileContent(path, side === 'base' ? baseSha : pr.headSha, MAX_READ_BYTES),
      notes: {
        filesCapped: (shown, total) =>
          `GitHub lists at most 3000 files; ${shown} of ${total} changed files are included.`,
        withoutPatch: (count) =>
          `GitHub returned no code for ${count} changed file${count === 1 ? '' : 's'} (too large, or over its size budget).`,
        commitsCapped: (shown, total) =>
          `Only the first ${shown} of ${total} commits are listed (GitHub lists at most 250).`,
      },
    };
    const loaded = await assembleChangeSet(raw, ctx, this.limits);
    ctx.logger.debug('github source loaded', {
      files: loaded.changeSet.files.length,
      commits: loaded.changeSet.commits.length,
    });
    return loaded;
  }
}
