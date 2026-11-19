/**
 * The words that say which repository, which change and which commit a run is about, and the link
 * to a line of code. Every text that prints them (the closing card, the watch page, what publishers
 * get) goes through these functions. A run with one source gets the same strings it always got; a
 * change that was joined from several sources names every source.
 */
import type { ChangeSet, ChangeSetPart, CodeRef, RepoInfo } from './types.ts';

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

/** The sources of a change: one for an ordinary change, one for each source of a joined change. */
function partsOf(changeSet: ChangeSet): readonly Pick<ChangeSetPart, 'repo' | 'pr' | 'head'>[] {
  return changeSet.parts ?? [changeSet];
}

/** "owner/name" of the repository, or of each repository joined with " + ". */
export function repoLabelOf(changeSet: ChangeSet): string {
  return changeSet.parts
    ? changeSet.parts.map((p) => repoLabelFor(p.repo)).join(SOURCE_SEPARATOR)
    : repoLabelFor(changeSet.repo);
}

/** "PR #42" or the head branch; for several sources "<name> #<n>" or "<name> <head ref>" of each. */
export function changeLabelOf(changeSet: Pick<ChangeSet, 'pr' | 'head' | 'parts'>): string {
  if (!changeSet.parts) return changeLabelFor(changeSet);
  return changeSet.parts
    .map((p) => `${lastSegment(p.repo.name) || 'repository'} ${p.pr ? `#${p.pr.number}` : changeLabelFor(p)}`)
    .join(SOURCE_SEPARATOR);
}

/** The short head commit, or the short head commits of the sources. */
export function commitTextOf(changeSet: ChangeSet): string {
  return partsOf(changeSet)
    .map((p) => p.head.sha.slice(0, 7))
    .join(COMMIT_SEPARATOR);
}

/**
 * Link to a line range at the exact commit, when the repository has a known web URL. For a joined
 * change the first folder of the path says which source the code is in; the link uses that source's
 * web address and commit and a path without the folder.
 */
export function codeRefUrl(changeSet: ChangeSet, ref: CodeRef): string | null {
  let repo = changeSet.repo;
  let head = changeSet.head;
  let base = changeSet.base;
  let path = ref.path;
  if (changeSet.parts) {
    const part = changeSet.parts.find((p) => path.startsWith(`${p.folder}/`));
    if (!part) return null;
    ({ repo, head, base } = part);
    path = path.slice(part.folder.length + 1);
  }
  if (!repo.webUrl) return null;
  const sha = ref.side === 'head' ? head.sha : base.sha;
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `${repo.webUrl}/blob/${sha}/${encoded}#L${ref.startLine}-L${ref.endLine}`;
}
