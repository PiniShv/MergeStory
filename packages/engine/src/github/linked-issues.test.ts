import { describe, expect, it } from 'vitest';
import { extractClosingReferences } from './linked-issues.ts';

const pr = { owner: 'acme', repo: 'widgets', webHost: 'github.com' };
const MAX_ISSUES = 3;

describe('extractClosingReferences', () => {
  it('reads the closing keywords GitHub knows, in any case', () => {
    const body = [
      'close #1',
      'Closes #2',
      'closed #3',
      'fix #4',
      'FIXES #5',
      'fixed: #6',
      'resolve #7',
      'resolves #8',
      'Resolved #9',
    ].join('\n');
    expect(extractClosingReferences(body, pr, 20).map((r) => r.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('reads references to other repositories and full issue links on the same host', () => {
    const body =
      'Fixes other/repo#5\nCloses https://github.com/acme/widgets/issues/9\nResolves https://ghe.example.com/x/y/issues/1';
    expect(extractClosingReferences(body, pr, MAX_ISSUES)).toEqual([
      { owner: 'other', repo: 'repo', number: 5 },
      { owner: 'acme', repo: 'widgets', number: 9 },
    ]);
  });

  it('can keep only references to the same repository, before the limit applies', () => {
    const body = [
      'Fixes other/repo#5',
      'Fixes https://github.com/other/repo/issues/6',
      'Fixes a/b#7',
      'Fixes #1',
      'Fixes ACME/Widgets#2',
    ].join('\n');
    expect(extractClosingReferences(body, pr, 3, { sameRepositoryOnly: true })).toEqual([
      { owner: 'acme', repo: 'widgets', number: 1 },
      { owner: 'ACME', repo: 'Widgets', number: 2 },
    ]);
  });

  it('needs a keyword in front of each reference, and a real word boundary', () => {
    expect(
      extractClosingReferences('See #1, related to #2. Prefix #3 and suffix: fixes', pr, MAX_ISSUES),
    ).toEqual([]);
    expect(extractClosingReferences('prefix #4', pr, MAX_ISSUES)).toEqual([]);
    expect(extractClosingReferences('fixes #1, #2', pr, MAX_ISSUES).map((r) => r.number)).toEqual([1]);
  });

  it('ignores references in code and HTML comments, like GitHub does', () => {
    const body = [
      '<!-- Fixes #1 -->',
      '`Fixes #2`',
      '```',
      'Fixes #3',
      '```',
      '~~~',
      'Fixes #4',
      '~~~',
      'Fixes #5',
    ].join('\n');
    expect(extractClosingReferences(body, pr, MAX_ISSUES).map((r) => r.number)).toEqual([5]);
  });

  it('removes duplicates (ignoring case), and keeps the first few', () => {
    expect(
      extractClosingReferences(
        'fixes #1\nfixes #1\nFixes Acme/Widgets#1\nfixes #2\nfixes #3\nfixes #4',
        pr,
        MAX_ISSUES,
      ).map((r) => r.number),
    ).toEqual([1, 2, 3]);
  });

  it('skips nonsense numbers and empty input', () => {
    expect(extractClosingReferences('fixes #0\nfixes #99999999999999999999', pr, MAX_ISSUES)).toEqual([]);
    expect(extractClosingReferences('', pr, MAX_ISSUES)).toEqual([]);
  });
});

describe('extractClosingReferences on hostile input', () => {
  const pr = { owner: 'acme', repo: 'widgets', webHost: 'github.com' };
  const quick = (text: string) => {
    const started = Date.now();
    const result = extractClosingReferences(text, pr, MAX_ISSUES);
    expect(Date.now() - started).toBeLessThan(500);
    return result;
  };

  it('stays fast with a long run of spaces after a keyword', () => {
    expect(quick(`fixes${' '.repeat(60_000)}x`)).toEqual([]);
    expect(quick(`fixes${' '.repeat(60_000)}#7`).map((r) => r.number)).toEqual([7]);
  });

  it('stays fast with many comment openers that never close', () => {
    expect(quick('<!--'.repeat(16_000))).toEqual([]);
    expect(quick('```'.repeat(1)).length).toBe(0);
    expect(quick(`${'<!-- '.repeat(10_000)}fixes #3`).map((r) => r.number)).toEqual([3]);
  });

  it('stays fast with many unpaired backticks and keywords', () => {
    expect(quick('`'.repeat(60_000))).toEqual([]);
    expect(quick('fixes '.repeat(10_000))).toEqual([]);
    expect(quick('fixes a/b'.repeat(5000))).toEqual([]);
  });

  it('keeps text after an unclosed code fence', () => {
    expect(quick('```\nfixes #4').map((r) => r.number)).toEqual([4]);
    expect(quick('<!-- fixes #5').map((r) => r.number)).toEqual([5]);
  });
});
