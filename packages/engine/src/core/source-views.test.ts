/** One shape for the sources of a change: an ordinary change is one source with nothing in front. */
import { describe, expect, it } from 'vitest';
import { joinSources } from '../sources/join.ts';
import { orders, store } from '../testing/joined.ts';
import { sampleChangeSet } from '../testing/sample-change.ts';
import { isJoined, sameSourceError, sourcesOf } from './source-views.ts';

describe('the sources of an ordinary change', () => {
  it('are one source that holds the facts of the change, with no letter and no folder', () => {
    const changeSet = sampleChangeSet();
    expect(isJoined(changeSet)).toBe(false);
    expect(sourcesOf(changeSet)).toEqual([
      {
        label: '',
        folder: '',
        idPrefix: '',
        pathPrefix: '',
        source: changeSet.source,
        repo: changeSet.repo,
        base: changeSet.base,
        head: changeSet.head,
        pr: changeSet.pr,
        stats: changeSet.stats,
        readmeExcerpt: changeSet.repoContext.readmeExcerpt,
      },
    ]);
  });
});

describe('the sources of a joined change', () => {
  it('are its parts, each with its letter for ids and its folder for paths', async () => {
    const { changeSet } = joinSources([await orders(), await store()]);
    expect(isJoined(changeSet)).toBe(true);
    const sources = sourcesOf(changeSet);
    expect(sources.map((s) => [s.label, s.idPrefix, s.folder, s.pathPrefix])).toEqual([
      ['A', 'A.', 'orders-api', 'orders-api/'],
      ['B', 'B.', 'storefront', 'storefront/'],
    ]);
    // Every id and path of the change belongs to exactly one source.
    for (const file of changeSet.files) {
      const owners = sources.filter(
        (s) => file.id.startsWith(s.idPrefix) && file.path.startsWith(s.pathPrefix),
      );
      expect(owners).toHaveLength(1);
    }
    expect(sources.map((s) => s.repo)).toEqual(changeSet.parts?.map((p) => p.repo));
  });
});

describe('a source that was given twice', () => {
  it('is a usage error', () => {
    expect(sameSourceError()).toMatchObject({
      code: 'USAGE',
      message: expect.stringContaining('more than once'),
    });
  });
});
