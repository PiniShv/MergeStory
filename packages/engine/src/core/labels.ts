/**
 * The words that say which repository, which change and which commit a run is about, and the link
 * to a line of code. Every text that prints them goes through these functions. A run with one source
 * gets the same strings it always got; a change that was joined from several sources names every source.
 *
 * Two families: the `...Of` labels are the words of the video (the closing card, the render plan):
 * never a filesystem path, and a cleaned ref. `changeLabel` and `repoLabel` are the words of the watch
 * page, the PR comment and the progress lines: owner, name and ref as they are.
 */
import { isJoined, sourcesOf } from './source-views.ts';
import type { ChangeSet, CodeRef, RepoInfo } from './types.ts';

/** The text that joins the sources of one run. */
const SOURCE_SEPARATOR = ' + ';
const COMMIT_SEPARATOR = ' · ';

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
export function changeLabelFor(changeSet: Pick<ChangeSet, 'pr' | 'head'>): string {
  if (changeSet.pr) return `PR #${changeSet.pr.number}`;
  const ref = changeSet.head.ref.trim().replace(/^refs\/(?:heads|remotes\/[^/]+)\//, '');
  if (/^[0-9a-f]{40}$/i.test(ref)) return ref.slice(0, 7);
  return ref || 'working changes';
}

/** For the video: "owner/name" of the repository, or of each repository joined with " + ". */
export function repoLabelOf(changeSet: ChangeSet): string {
  return sourcesOf(changeSet)
    .map((s) => repoLabelFor(s.repo))
    .join(SOURCE_SEPARATOR);
}

/** For the video: "PR #42" or the head branch; for several sources "<name> #<n>" or "<name> <head ref>" of each. */
export function changeLabelOf(changeSet: ChangeSet): string {
  if (!isJoined(changeSet)) return changeLabelFor(changeSet);
  return sourcesOf(changeSet)
    .map((s) => `${lastSegment(s.repo.name) || 'repository'} ${s.pr ? `#${s.pr.number}` : changeLabelFor(s)}`)
    .join(SOURCE_SEPARATOR);
}

/** For the video: the short head commit, or the short head commits of the sources. */
export function commitTextOf(changeSet: ChangeSet): string {
  return sourcesOf(changeSet)
    .map((s) => s.head.sha.slice(0, 7))
    .join(COMMIT_SEPARATOR);
}

/** For the watch page, the PR comment and progress lines: "PR #42" or the head ref as it is; a joined change names each source. */
export function changeLabel(changeSet: ChangeSet): string {
  if (isJoined(changeSet)) return changeLabelOf(changeSet);
  return changeSet.pr ? `PR #${changeSet.pr.number}` : changeSet.head.ref;
}

/** For the watch page and the PR comment: "owner/name" as it is; a joined change names each repository. */
export function repoLabel(changeSet: ChangeSet): string {
  if (isJoined(changeSet)) return repoLabelOf(changeSet);
  return changeSet.repo.owner ? `${changeSet.repo.owner}/${changeSet.repo.name}` : changeSet.repo.name;
}

/** For the summary of an author: "<repo> <change>", or the label of a joined change, which already names every repository. */
export function fullChangeLabel(changeSet: ChangeSet): string {
  return isJoined(changeSet) ? changeLabel(changeSet) : `${repoLabel(changeSet)} ${changeLabel(changeSet)}`;
}

/**
 * Link to a line range at the exact commit, when the repository has a known web URL. The folder at the
 * start of the path says which source the code is in (an ordinary change has no folder); the link uses
 * that source's web address and commit and the path without the folder.
 */
export function codeRefUrl(changeSet: ChangeSet, ref: CodeRef): string | null {
  const source = sourcesOf(changeSet).find((s) => ref.path.startsWith(s.pathPrefix));
  if (!source?.repo.webUrl) return null;
  const sha = ref.side === 'head' ? source.head.sha : source.base.sha;
  const encoded = ref.path.slice(source.pathPrefix.length).split('/').map(encodeURIComponent).join('/');
  return `${source.repo.webUrl}/blob/${sha}/${encoded}#L${ref.startLine}-L${ref.endLine}`;
}
