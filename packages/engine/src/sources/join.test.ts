import { describe, expect, it } from 'vitest';
import { paceOf } from '../analyzer/index.ts';
import type { KeyHunk, RiskCategory, RiskSeverity, RiskSignal } from '../core/types.ts';
import { joinProblems, loadSource, orders, store, TOTAL_BASE } from '../testing/joined.ts';
import { folderNames, joinedPrivacy, joinSources, type LoadedSource } from './join.ts';

describe('joinSources', () => {
  it('gives every id a letter and every path a folder, and points nowhere else', async () => {
    const { changeSet, analysis } = joinSources([await orders(), await store()]);
    expect(joinProblems(changeSet, analysis)).toEqual([]);
    expect(changeSet.files.map((f) => f.id)).toEqual(['A.F1', 'A.F2', 'A.F3', 'A.F4', 'B.F1', 'B.F2']);
    expect(changeSet.files[0]?.path).toBe('orders-api/src/total.js');
    expect(changeSet.files[0]?.hunks[0]?.id).toBe('A.F1.H1');
    expect(changeSet.commits.map((c) => c.id)).toEqual(['A.CM1', 'B.CM1']);
    expect(changeSet.linkedIssues.map((i) => i.id)).toEqual(['A.IS1']);
    expect(analysis.evidence.map((e) => e.id)).toEqual(
      expect.arrayContaining(['A.PR', 'B.PR', 'A.REPO', 'B.REPO', 'A.S1', 'B.M1']),
    );
    // Nothing in the analysis keeps the id or the path it had inside its repository.
    const text = JSON.stringify(analysis);
    expect(text).not.toMatch(/"(?:fileId|id|componentId)":"(?:F|S|M|R|D|CM|IS|PR|REPO)/);
    expect(text).not.toMatch(/"path":"(?!orders-api|storefront)/);
  });

  it('notices an id or a path that was left without its letter or folder', async () => {
    const { changeSet, analysis } = joinSources([await orders(), await store()]);
    const broken = {
      ...analysis,
      risks: analysis.risks.map((r) => ({ ...r, evidence: [...r.evidence, 'F1'] })),
    };
    expect(joinProblems(changeSet, broken).join('\n')).toMatch(/F1 is not in the evidence/);
    const moved = { ...analysis, symbols: analysis.symbols.map((s) => ({ ...s, path: 'src/total.js' })) };
    expect(joinProblems(changeSet, moved).join('\n')).toMatch(/not in a folder of a source/);
  });

  it('gives the same result whatever the order of the sources', async () => {
    const [a, b] = [await orders(), await store()];
    const one = joinSources([a, b]);
    const two = joinSources([b, a]);
    expect({ ...two, reader: null }).toEqual({ ...one, reader: null });
    expect(one.changeSet.parts?.map((p) => [p.label, p.folder])).toEqual([
      ['A', 'orders-api'],
      ['B', 'storefront'],
    ]);
  });

  it('sorts by repository, then pull request number, then head commit', async () => {
    const first = await orders({ prNumber: 3, headSha: 'b'.repeat(40) });
    const second = await orders({ prNumber: 3, headSha: 'a'.repeat(40) });
    const third = await orders({ prNumber: 2, headSha: 'c'.repeat(40) });
    const { changeSet } = joinSources([first, second, third]);
    expect(changeSet.parts?.map((p) => [p.pr?.number, p.head.sha[0]])).toEqual([
      [2, 'c'],
      [3, 'a'],
      [3, 'b'],
    ]);
    expect(changeSet.parts?.map((p) => p.folder)).toEqual(['orders-api', 'orders-api-2', 'orders-api-3']);
  });

  it('sorts by base commit when the repository and head are the same', async () => {
    const withBase = async (sha: string) => {
      const s = await orders();
      return { ...s, changeSet: { ...s.changeSet, base: { ...s.changeSet.base, sha } } };
    };
    const [b, a] = [await withBase('b'.repeat(40)), await withBase('a'.repeat(40))];
    for (const order of [
      [a, b],
      [b, a],
    ]) {
      expect(joinSources(order).changeSet.parts?.map((p) => p.base.sha[0])).toEqual(['a', 'b']);
    }
  });

  it('refuses the same repository at the same commits twice', async () => {
    await expect(async () => joinSources([await orders(), await orders()])).rejects.toMatchObject({
      code: 'USAGE',
    });
  });

  it('throws an internal error when an evidence id would exist twice', async () => {
    const twice = await orders();
    const file = twice.analysis.evidence.find((e) => e.id === 'F1');
    twice.analysis.evidence.push({ ...(file as NonNullable<typeof file>) });
    const other = await store();
    expect(() => joinSources([twice, other])).toThrow(
      expect.objectContaining({ code: 'INTERNAL', message: expect.stringContaining('A.F1') }),
    );
  });

  it('takes the caller evidence once and keeps its ids', async () => {
    const [a, b] = [await orders(), await store()];
    // Every source carries the results of the caller's tests, as each was analysed with them.
    for (const s of [a, b])
      s.analysis.evidence.push({ id: 'T1', kind: 'test', label: 'Test: npm test', ref: null, url: null });
    const { analysis } = joinSources([a, b]);
    const ids = analysis.evidence.map((e) => e.id);
    expect(ids.filter((id) => id === 'TASK')).toEqual(['TASK']);
    expect(ids.filter((id) => id.endsWith('T1'))).toEqual(['T1']);
    expect(ids.indexOf('TASK')).toBe(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('sums the stats, the lines, the languages and the pace with the functions of the analyzer', async () => {
    const [a, b] = [await orders(), await store()];
    const { changeSet, analysis } = joinSources([a, b]);
    expect(changeSet.stats.files).toBe(a.changeSet.stats.files + b.changeSet.stats.files);
    expect(changeSet.stats.additions).toBe(a.changeSet.stats.additions + b.changeSet.stats.additions);
    expect(analysis.meaningfulLines).toBe(a.analysis.meaningfulLines + b.analysis.meaningfulLines);
    expect(analysis.size).toBe(paceOf(analysis.meaningfulLines, 0).size);
    const js = (x: LoadedSource) => x.analysis.languages.find((l) => l.language === 'javascript')?.files ?? 0;
    expect(analysis.languages.find((l) => l.language === 'javascript')?.files).toBe(js(a) + js(b));
    expect(analysis.languages.map((l) => l.files)).toEqual(
      [...analysis.languages.map((l) => l.files)].sort((x, y) => y - x),
    );
    expect(analysis.architectureSignals.every((s) => /^(orders-api|storefront): /.test(s))).toBe(true);
    expect(analysis.tests.added).toEqual(['orders-api/src/total.test.js']);
  });

  it('counts the components of all sources for the length of the video', async () => {
    const many = (name: string, dirs: string[]) =>
      loadSource(
        dirs.map((d) => ({ path: `${d}/x.js`, base: 'a\n', head: 'b\n' })),
        { name },
      );
    const [a, b] = [await many('one', ['p', 'q']), await many('two', ['r', 's'])];
    expect(a.analysis.suggestedDurationSec).toBe(b.analysis.suggestedDurationSec);
    const joined = joinSources([a, b]).analysis;
    expect(joined.components).toHaveLength(4);
    expect(joined.suggestedDurationSec).toBe(paceOf(joined.meaningfulLines, 4).suggestedDurationSec);
    expect(joined.suggestedDurationSec).toBe(a.analysis.suggestedDurationSec + 10);
  });

  it('describes one change set: no pull request, the folders as the name, the joined limits and privacy', async () => {
    const { changeSet } = joinSources([
      await orders({ isPrivate: null, note: 'Only 3000 files.' }),
      await store({ isPrivate: false }),
    ]);
    expect(changeSet.pr).toBeNull();
    expect(changeSet.source).toBe('github');
    expect(changeSet.repo).toMatchObject({
      name: 'orders-api + storefront',
      owner: 'acme',
      webUrl: null,
      isPrivate: null,
    });
    expect(changeSet.base).toEqual(changeSet.parts?.[0]?.base);
    expect(changeSet.limits).toEqual({
      filesCapped: false,
      commitsCapped: false,
      note: 'orders-api: Only 3000 files.',
    });
    expect(changeSet.repoContext.tree).toContain('orders-api/src/total.js');
    expect(changeSet.repoContext.manifests[0]?.path).toBe('orders-api/package.json');
  });

  it('returns a lone source as it is: no letter, no folder, no parts', async () => {
    const lone = await orders();
    const joined = joinSources([lone]);
    expect(joined.changeSet).toBe(lone.changeSet);
    expect(joined.reader).toBe(lone.reader);
    expect(joined.analysis).toBe(lone.analysis);
  });

  it('leaves the owner empty when the repositories have different owners', async () => {
    const { changeSet } = joinSources([await orders(), await store({ owner: 'other' })]);
    expect(changeSet.repo.owner).toBe('');
  });
});

describe('the order of the joined lists', () => {
  const risk = (id: string, severity: RiskSeverity, category: RiskCategory = 'tests'): RiskSignal => ({
    id,
    severity,
    category,
    title: `Risk ${id}`,
    detail: 'detail',
    evidence: [],
    ref: null,
  });
  /** Source A has many items of low rank, source B has the best ones. */
  async function sources() {
    const [a, b] = [await orders(), await store()];
    const hunk = a.analysis.keyHunks[0] as KeyHunk;
    a.analysis.keyHunks = Array.from({ length: 8 }, (_, i) => ({ ...hunk, id: `F1.H${i + 1}`, score: 0.2 }));
    b.analysis.keyHunks.forEach((k, i) => {
      k.score = i === 0 ? 0.9 : 0.2;
    });
    a.analysis.risks = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6'].map((id) => risk(id, 'low'));
    b.analysis.risks = [risk('R1', 'high', 'security'), risk('R2', 'low')];
    a.analysis.architectureSignals = ['a1', 'a2', 'a3'];
    b.analysis.architectureSignals = ['b1', 'b2'];
    a.analysis.relationships = [
      { from: 'M1', to: 'M2', kind: 'imports', evidence: 'F1' },
      { from: 'M2', to: 'M3', kind: 'imports', evidence: 'F1' },
    ];
    b.analysis.relationships = [{ from: 'M1', to: 'M3', kind: 'imports', evidence: 'F1' }];
    return { a, b };
  }

  it('puts the key hunk with the highest score first, whatever the source, and keeps the letters for equal scores', async () => {
    const { a, b } = await sources();
    const { keyHunks } = joinSources([a, b]).analysis;
    expect(keyHunks[0]?.id).toBe(`B.${b.analysis.keyHunks[0]?.id}`);
    expect(keyHunks.map((k) => k.score)).toEqual([...keyHunks.map((k) => k.score)].sort((x, y) => y - x));
    expect(keyHunks.slice(1).map((k) => k.id[0])).toEqual([
      ...'A'.repeat(8),
      ...'B'.repeat(b.analysis.keyHunks.length - 1),
    ]);
  });

  it('puts a risk of the highest severity before a low one, and keeps it among the first four', async () => {
    const { a, b } = await sources();
    const { risks } = joinSources([a, b]).analysis;
    expect(risks.slice(0, 4).map((r) => r.id)).toEqual(['B.R1', 'A.R1', 'A.R2', 'A.R3']);
    expect(risks.map((r) => r.id).slice(-1)).toEqual(['B.R2']);
  });

  it('takes the first architecture signal of each source, then the second of each', async () => {
    const { a, b } = await sources();
    expect(joinSources([a, b]).analysis.architectureSignals).toEqual([
      'orders-api: a1',
      'storefront: b1',
      'orders-api: a2',
      'storefront: b2',
      'orders-api: a3',
    ]);
  });

  it('takes the symbols and the dependencies in turns, and the relationships by the rank of their components', async () => {
    const { a, b } = await sources();
    const { symbols, relationships } = joinSources([a, b]).analysis;
    expect(symbols.slice(0, 2).map((s) => s.id)).toEqual([
      `A.${a.analysis.symbols[0]?.id}`,
      `B.${b.analysis.symbols[0]?.id}`,
    ]);
    expect(relationships.map((r) => `${r.from}>${r.to}`)).toEqual(['A.M1>A.M2', 'B.M1>B.M3', 'A.M2>A.M3']);
  });

  it('puts the component with the most changed lines first, whatever the source', async () => {
    const lines = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => `${prefix}${i}\n`).join('');
    const small = await loadSource([{ path: 'p/x.js', base: lines('a', 1), head: lines('b', 1) }], {
      name: 'one',
    });
    const big = await loadSource([{ path: 'q/x.js', base: lines('a', 10), head: lines('b', 10) }], {
      name: 'two',
    });
    const { components } = joinSources([small, big]).analysis;
    expect(components.map((m) => m.id)).toEqual(['B.M1', 'A.M1']);
  });

  it('gives the same lists whatever the order of the sources', async () => {
    const { a, b } = await sources();
    const [one, two] = [joinSources([a, b]).analysis, joinSources([b, a]).analysis];
    for (const key of [
      'keyHunks',
      'risks',
      'architectureSignals',
      'symbols',
      'relationships',
      'components',
    ] as const)
      expect(two[key], key).toEqual(one[key]);
  });
});

describe('the joined reader', () => {
  it('reads each repository its own file, even when both have the same path', async () => {
    const { reader } = joinSources([await orders(), await store()]);
    expect(await reader.readFile('orders-api/src/total.js', 'head')).toContain('cents: order.cents');
    expect(await reader.readFile('storefront/src/total.js', 'head')).toContain('order.total.cents / 100');
    expect(await reader.readFile('storefront/src/total.js', 'base')).toBe(TOTAL_BASE);
  });

  it('reads nothing for a path without a folder, with an unknown folder, or that leaves its folder', async () => {
    const { reader } = joinSources([await orders(), await store()]);
    for (const path of [
      'src/total.js',
      'other/src/total.js',
      'orders-api/../storefront/src/total.js',
      'storefront/../orders-api/src/total.js',
      'orders-api',
      'orders-api/',
      'orders-api2/src/total.js',
    ]) {
      expect(await reader.readFile(path, 'head'), path).toBeNull();
    }
  });

  it('keeps refusing what a source refuses', async () => {
    const { reader, changeSet } = joinSources([await orders(), await store()]);
    expect(changeSet.files.find((f) => f.path === 'orders-api/.env')?.sensitive).toBe(true);
    expect(await reader.readFile('orders-api/.env', 'head')).toBeNull();
    expect(await reader.readFile('orders-api/.env', 'base')).toBeNull();
  });
});

describe('folderNames', () => {
  it('makes names safe and keeps them apart', () => {
    expect(folderNames(['api', 'api', 'api'])).toEqual(['api', 'api-2', 'api-3']);
    expect(folderNames(['my repo/x', 'a:b', 'ok_1.2-x'])).toEqual(['my-repo-x', 'a-b', 'ok_1.2-x']);
    expect(folderNames(['', '.', '..'])).toEqual(['repo', 'repo-2', 'repo-3']);
    // A name that is taken after a rename still gets its own folder.
    expect(folderNames(['a-2', 'a', 'a'])).toEqual(['a-2', 'a', 'a-3']);
  });
});

describe('joinedPrivacy', () => {
  it.each([
    [[true, false], true],
    [[null, true], true],
    [[false, null], null],
    [[false, false], false],
  ])('%j is %s', (values, expected) => {
    expect(joinedPrivacy(values.map((isPrivate) => ({ isPrivate })))).toBe(expected);
  });
});
