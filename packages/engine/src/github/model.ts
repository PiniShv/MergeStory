/** What the GitHub client hands out, and the readers that turn API responses into those shapes. */
import { isLikelyBinaryPath } from '../core/binary-paths.ts';
import { asArray, asNumber, asString, isRecord } from '../core/json.ts';
import { unexpectedResponse } from './errors.ts';
import type { PullRequestRef } from './pr-url.ts';

export interface GitHubRepo {
  owner: string;
  name: string;
  isPrivate: boolean | null;
  defaultBranch: string | null;
  htmlUrl: string | null;
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  body: string;
  htmlUrl: string;
  author: string | null;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  labels: string[];
  draft: boolean;
  state: 'open' | 'closed' | 'merged';
  changedFiles: number;
  additions: number;
  deletions: number;
  commits: number;
}

export interface GitHubComparison {
  mergeBaseSha: string;
  status: string;
  aheadBy: number;
  behindBy: number;
}

export interface GitHubPrFile {
  filename: string;
  /** GitHub's own status word: added, removed, modified, renamed, copied, changed or unchanged. */
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  /** null when GitHub left the patch out (binary, too large, or over the response budget). */
  patch: string | null;
  previousFilename: string | null;
  /**
   * True when the entry has no patch and zero counts although it is a modified text file. GitHub
   * does this when a page of files is too large, so the counts cannot be trusted.
   */
  suspect: boolean;
}

export interface GitHubPrCommit {
  sha: string;
  /** The full commit message. */
  message: string;
}

export interface GitHubTreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit';
}

export interface GitHubTree {
  entries: GitHubTreeEntry[];
  /** True when GitHub cut the listing short. */
  truncated: boolean;
}

export interface GitHubIssue {
  number: number;
  title: string;
  /** The whole body. Not cut here: the source masks secrets in all of it first, then caps it. */
  body: string;
  url: string;
}

export interface GitHubComment {
  id: number;
  url: string;
  body: string;
  authorLogin: string | null;
  authorType: string | null;
}

/** A number from the API; `fallback` when the field is missing or not a finite number. */
function numberOr(value: unknown, fallback = 0): number {
  return asNumber(value) ?? fallback;
}

export function toRepo(data: unknown, ref: PullRequestRef): GitHubRepo {
  if (!isRecord(data)) throw unexpectedResponse('repository');
  const owner = isRecord(data.owner) ? asString(data.owner.login) : null;
  const visibility = asString(data.visibility);
  let isPrivate: boolean | null = null;
  if (typeof data.private === 'boolean') isPrivate = data.private;
  if (visibility !== null && visibility !== 'public') isPrivate = true;
  return {
    owner: owner ?? ref.owner,
    name: asString(data.name) ?? ref.repo,
    isPrivate,
    defaultBranch: asString(data.default_branch),
    htmlUrl: asString(data.html_url),
  };
}

export function toPullRequest(data: unknown): GitHubPullRequest {
  if (!isRecord(data)) throw unexpectedResponse('pull request');
  const base = isRecord(data.base) ? data.base : {};
  const head = isRecord(data.head) ? data.head : {};
  const baseSha = asString(base.sha);
  const headSha = asString(head.sha);
  if (!baseSha || !headSha) throw unexpectedResponse('pull request');
  const merged = data.merged === true || asString(data.merged_at) !== null;
  return {
    number: numberOr(data.number),
    title: asString(data.title) ?? '',
    body: asString(data.body) ?? '',
    htmlUrl: asString(data.html_url) ?? '',
    author: isRecord(data.user) ? asString(data.user.login) : null,
    baseRef: asString(base.ref) ?? '',
    baseSha,
    headRef: asString(head.ref) ?? '',
    headSha,
    labels: asArray(data.labels)
      .map((label) => (isRecord(label) ? asString(label.name) : null))
      .filter((name): name is string => name !== null),
    draft: data.draft === true,
    state: merged ? 'merged' : data.state === 'closed' ? 'closed' : 'open',
    changedFiles: numberOr(data.changed_files),
    additions: numberOr(data.additions),
    deletions: numberOr(data.deletions),
    commits: numberOr(data.commits),
  };
}

export function toPrFile(data: unknown): GitHubPrFile | null {
  if (!isRecord(data)) return null;
  const filename = asString(data.filename);
  if (!filename) return null;
  const status = asString(data.status) ?? 'modified';
  const additions = numberOr(data.additions);
  const deletions = numberOr(data.deletions);
  const changes = numberOr(data.changes, additions + deletions);
  const patch = asString(data.patch);
  const suspect =
    patch === null &&
    status === 'modified' &&
    changes === 0 &&
    additions === 0 &&
    deletions === 0 &&
    !isLikelyBinaryPath(filename);
  return {
    filename,
    status,
    additions,
    deletions,
    changes,
    patch: patch === '' ? null : patch,
    previousFilename: asString(data.previous_filename),
    suspect,
  };
}

export function toComment(data: unknown): GitHubComment | null {
  if (!isRecord(data)) return null;
  const id = numberOr(data.id, -1);
  if (id < 0) return null;
  const user = isRecord(data.user) ? data.user : {};
  return {
    id,
    url: asString(data.html_url) ?? '',
    body: asString(data.body) ?? '',
    authorLogin: asString(user.login),
    authorType: asString(user.type),
  };
}

export function toIssue(data: unknown): GitHubIssue | null {
  if (!isRecord(data)) return null;
  const number = numberOr(data.number, -1);
  if (number < 1) return null;
  return {
    number,
    title: asString(data.title) ?? '',
    body: asString(data.body) ?? '',
    url: asString(data.html_url) ?? asString(data.url) ?? '',
  };
}
