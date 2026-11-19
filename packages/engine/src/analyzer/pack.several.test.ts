/** The evidence pack of a change that was joined from several sources, and the same pack for one source. */
import { describe, expect, it } from 'vitest';
import { joinSources } from '../sources/join.ts';
import { JOINED_INPUTS, orders, store } from '../testing/joined.ts';
import { buildEvidencePack, type EvidencePackOptions } from './pack.ts';

const OPTIONS: EvidencePackOptions = {
  maxTokens: 24_000,
  llmContext: 'full',
  targetDurationSec: 70,
  style: 'hybrid',
  language: 'en',
};

const section = (markdown: string, heading: string): string => {
  const start = markdown.indexOf(`## ${heading}`);
  if (start < 0) return '';
  const end = markdown.indexOf('\n## ', start + 1);
  return markdown.slice(start, end < 0 ? undefined : end);
};

describe('the pack of two sources', () => {
  it('lists every source and says the two rules', async () => {
    const { changeSet, analysis } = joinSources([await orders(), await store()]);
    const { markdown } = buildEvidencePack(changeSet, analysis, JOINED_INPUTS, OPTIONS);
    const head = markdown.slice(0, markdown.indexOf('\n## '));
    expect(head).toContain('one change in 2 repositories');
    expect(head).toMatch(
      /Source A: acme\/orders-api \(github\.com\), pull request #1, .*folder orders-api\/, 4 files changed/,
    );
    expect(head).toMatch(
      /Source B: acme\/storefront \(github\.com\), pull request #7, .*folder storefront\/, 2 files changed/,
    );
    expect(head).toContain('an id of a repository starts with the letter of its source (A.F1, B.F1)');
    expect(head).toContain('A path starts with the folder of its source (orders-api/..., storefront/...)');
    expect(head).toMatch(/Stats \(all sources\): 6 files changed/);
    expect(head).not.toContain('- Repository:');
  });

  it('writes the pull request, the issues, the commits and the context once for each source', async () => {
    const { changeSet, analysis } = joinSources([await orders(), await store()]);
    changeSet.parts![0]!.pr!.title = 'Return the total in cents';
    changeSet.parts![1]!.pr!.title = 'Show the cents';
    const { markdown } = buildEvidencePack(changeSet, analysis, JOINED_INPUTS, OPTIONS);
    expect(section(markdown, 'Pull request (A.PR)')).toContain('Return the total in cents');
    expect(section(markdown, 'Pull request (B.PR)')).toContain('Show the cents');
    expect(markdown).not.toContain('## Pull request (PR)');
    expect(section(markdown, 'Linked issues (source A)')).toContain('A.IS1');
    expect(markdown).not.toContain('Linked issues (source B)');
    expect(section(markdown, 'Commits (source A)')).toContain('A.CM1');
    expect(section(markdown, 'Commits (source A)')).not.toContain('B.CM1');
    expect(section(markdown, 'Commits (source B)')).toContain('B.CM1');
    const a = section(markdown, 'Repository context (A.REPO)');
    const b = section(markdown, 'Repository context (B.REPO)');
    expect(a).toContain('orders-api/src/');
    expect(a).not.toContain('storefront/');
    expect(a).toContain('# Orders');
    expect(a).toContain('Manifest `orders-api/package.json`');
    expect(b).toContain('storefront/src/');
    expect(b).toContain('# Store');
  });

  it('works on the joined lists everywhere else, with letters and folders', async () => {
    const { changeSet, analysis } = joinSources([await orders(), await store()]);
    const { markdown, includedHunks } = buildEvidencePack(changeSet, analysis, JOINED_INPUTS, OPTIONS);
    expect(section(markdown, 'Files')).toContain('| A.F1 | orders-api/src/total.js |');
    expect(section(markdown, 'Files')).toContain('| B.F1 | storefront/src/total.js |');
    expect(markdown).toContain('### A.F1.H1 orders-api/src/total.js');
    expect(markdown).toContain('### B.F1.H1 storefront/src/total.js');
    expect(includedHunks).toEqual(expect.arrayContaining(['A.F1.H1', 'B.F1.H1']));
    expect(section(markdown, 'Evidence ids')).toContain('A.F1, A.F2, A.F3, A.F4, B.F1, B.F2');
    // The sensitive file is listed and its code is not.
    expect(section(markdown, 'Files')).toContain('sensitive: content hidden');
    expect(markdown).not.toContain('A=2');
  });

  it('is cut to the budget with ranges that keep their letters', async () => {
    const { changeSet, analysis } = joinSources([await orders(), await store()]);
    const { markdown } = buildEvidencePack(changeSet, analysis, JOINED_INPUTS, {
      ...OPTIONS,
      maxTokens: 450,
    });
    expect(section(markdown, 'Evidence ids')).toMatch(/A\.F1-A\.F4/);
    expect(section(markdown, 'Evidence ids')).toContain('Each id keeps its letter');
  });
});

describe('the pack of one source', () => {
  it('has no source lines and keeps its old headings', async () => {
    const one = await orders();
    const { markdown } = buildEvidencePack(one.changeSet, one.analysis, JOINED_INPUTS, OPTIONS);
    expect(markdown).toContain(
      '- Change: Pull request #1\n- Repository: acme/orders-api (github.com)\n- Range: base ',
    );
    expect(markdown).toContain('## Pull request (PR)');
    expect(markdown).toContain('## Linked issues\n');
    expect(markdown).toContain('## Commits\n');
    expect(markdown).toContain('## Repository context (REPO)');
    expect(markdown).not.toMatch(/Source A|Rules:|A\.F1/);
  });
});
