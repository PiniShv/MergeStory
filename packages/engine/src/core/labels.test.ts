/** Which repository, which change, which commit: one source keeps its strings, several name every source. */
import { describe, expect, it } from 'vitest';
import { joinSources } from '../sources/join.ts';
import { orders, store } from '../testing/joined.ts';
import { sampleChangeSet } from '../testing/sample-change.ts';
import {
  changeLabel,
  changeLabelOf,
  codeRefUrl,
  commitTextOf,
  fullChangeLabel,
  repoLabel,
  repoLabelOf,
} from './labels.ts';

const REF = { path: 'src/total.js', side: 'head', startLine: 1, endLine: 3 } as const;

describe('labels of one source', () => {
  it('are what they always were', () => {
    const changeSet = sampleChangeSet();
    expect(repoLabelOf(changeSet)).toBe('example/weather');
    expect(changeLabelOf(changeSet)).toBe(`PR #${changeSet.pr?.number}`);
    expect(commitTextOf(changeSet)).toBe(changeSet.head.sha.slice(0, 7));
    expect(codeRefUrl(changeSet, REF)).toBe(
      `https://github.com/example/weather/blob/${changeSet.head.sha}/src/total.js#L1-L3`,
    );
    expect(fullChangeLabel(changeSet)).toBe(`example/weather PR #${changeSet.pr?.number}`);
  });

  it('keep owner, name and ref as they are on the watch page', () => {
    const changeSet = {
      ...sampleChangeSet(),
      pr: null,
      head: { ref: 'refs/heads/fix', sha: 'c'.repeat(40) },
    };
    expect(changeLabel(changeSet)).toBe('refs/heads/fix');
    expect(changeLabelOf(changeSet)).toBe('fix');
    expect(repoLabel({ ...changeSet, repo: { ...changeSet.repo, owner: '', name: '/work/weather' } })).toBe(
      '/work/weather',
    );
  });
});

describe('labels of several sources', () => {
  const load = async () =>
    joinSources([
      await orders({ webUrl: 'https://github.com/acme/orders-api', prNumber: null, headSha: 'a'.repeat(40) }),
      await store({ webUrl: 'https://github.com/acme/storefront', headSha: 'b'.repeat(40) }),
    ]).changeSet;

  it('name every repository, change and commit', async () => {
    const changeSet = await load();
    expect(repoLabelOf(changeSet)).toBe('acme/orders-api + acme/storefront');
    // A pull request is "<name> #<n>", a local change "<name> <head ref>".
    expect(changeLabelOf(changeSet)).toBe(`orders-api ${changeSet.parts?.[0]?.head.ref} + storefront #7`);
    expect(commitTextOf(changeSet)).toBe('aaaaaaa · bbbbbbb');
    // The watch page and the summary of an author use the same words for a joined change.
    expect(changeLabel(changeSet)).toBe(changeLabelOf(changeSet));
    expect(repoLabel(changeSet)).toBe(repoLabelOf(changeSet));
    expect(fullChangeLabel(changeSet)).toBe(changeLabelOf(changeSet));
  });

  it('link a line of code to the repository and commit of its own source', async () => {
    const changeSet = await load();
    const at = (path: string) => codeRefUrl(changeSet, { ...REF, path });
    expect(at('orders-api/src/total.js')).toBe(
      `https://github.com/acme/orders-api/blob/${'a'.repeat(40)}/src/total.js#L1-L3`,
    );
    expect(at('storefront/src/total.js')).toBe(
      `https://github.com/acme/storefront/blob/${'b'.repeat(40)}/src/total.js#L1-L3`,
    );
    expect(at('other/src/total.js')).toBeNull();
  });
});
