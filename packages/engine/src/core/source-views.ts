/**
 * The sources of a change, in one shape for every stage. An ordinary change is one source with no
 * letter and no folder. A change that was joined from several repositories has one source for each,
 * with its letter in front of every evidence id and its folder in front of every path. Code that
 * works source by source reads `sourcesOf` and needs no second mode; `isJoined` is for the texts
 * and the rules that really differ between the two kinds of change.
 */
import { MergeStoryError } from './errors.ts';
import type { ChangeSet, ChangeSetPart } from './types.ts';

/** The most sources one video may join. */
export const MAX_SOURCES = 4;

export interface SourceView extends ChangeSetPart {
  /** What every evidence id of this source starts with: "A." in a joined change, "" in an ordinary one. */
  idPrefix: string;
  /** What every path of this source starts with: "orders-api/" in a joined change, "" in an ordinary one. */
  pathPrefix: string;
}

/** True for a change that was joined from several sources. */
export function isJoined(changeSet: Pick<ChangeSet, 'parts'>): boolean {
  return changeSet.parts !== undefined;
}

/** Every source of a change, in the order of the letters. An ordinary change has exactly one. */
export function sourcesOf(changeSet: ChangeSet): SourceView[] {
  if (changeSet.parts) {
    return changeSet.parts.map((part) => ({
      ...part,
      idPrefix: `${part.label}.`,
      pathPrefix: `${part.folder}/`,
    }));
  }
  const { source, repo, base, head, pr, stats, repoContext } = changeSet;
  return [
    {
      label: '',
      folder: '',
      source,
      repo,
      base,
      head,
      pr,
      stats,
      readmeExcerpt: repoContext.readmeExcerpt,
      idPrefix: '',
      pathPrefix: '',
    },
  ];
}

/** The usage error for a source that was given twice: as the same text, or as the same change once it is loaded. */
export function sameSourceError(): MergeStoryError {
  return new MergeStoryError('USAGE', 'The same source was given more than once.', {
    hint: 'Give each repository or pull request once.',
  });
}
