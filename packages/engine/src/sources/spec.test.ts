import { describe, expect, it } from 'vitest';
import { MergeStoryError } from '../core/errors.ts';
import { MAX_SOURCES } from '../core/source-views.ts';
import { parseSourceSpec, sourceInputsOf, sourceSpecOf, splitSourceRange } from './spec.ts';

describe('splitSourceRange', () => {
  it.each([
    ['./api', './api', null, null],
    ['./api:main..fix/x', './api', 'main', 'fix/x'],
    ['./api:main..', './api', 'main', null],
    ['./api:..fix/x', './api', null, 'fix/x'],
    ['./api:..', './api', null, null],
    ['./api:v1.2..origin/main~3', './api', 'v1.2', 'origin/main~3'],
    ['/a:b/c:main..x', '/a:b/c', 'main', 'x'],
    // Of three dots in a row, the last two are the mark.
    ['./api:main...x', './api', 'main.', 'x'],
  ])('splits %s', (text, repo, base, head) => {
    expect(splitSourceRange(text)).toEqual({ repo, base, head });
  });

  it('answers at once for a very long text that is almost a range', () => {
    const text = `./api:${'.'.repeat(200_000)}!`;
    expect(splitSourceRange(text)).toEqual({ repo: text, base: null, head: null });
  });

  it.each([
    ['a URL', 'https://github.com/acme/app/pull/7'],
    ['a URL with a port', 'https://host.example:8443/acme/app/pull/7'],
    ['a Windows drive', 'C:\\work\\api'],
    ['a Windows drive with a slash', 'C:/work/api'],
    ['a Windows drive with a .. segment', 'C:/a/../b'],
    ['a Windows drive with .. in a name', 'C:/work/repo..backup'],
    ['a shorthand', 'acme/app#7'],
    ['a second range marker', './api:a..b..c'],
    ['a space in a ref', './api:main ..x'],
  ])('does not take %s for a range', (_label, text) => {
    expect(splitSourceRange(text)).toEqual({ repo: text, base: null, head: null });
  });
});

describe('parseSourceSpec', () => {
  it('turns a folder and a range into a local source, and a pull request into a github source', () => {
    expect(parseSourceSpec('api:main..x', '/work')).toEqual({
      kind: 'local',
      repoPath: '/work/api',
      base: 'main',
      head: 'x',
    });
    expect(parseSourceSpec('acme/app#7', '/work')).toEqual({
      kind: 'github',
      url: 'https://github.com/acme/app/pull/7',
    });
  });

  it('refuses a range with a pull request, an option-like text and a bad ref', () => {
    for (const text of ['acme/app#7:main..x', '-x', 'api:-a..b', '', 'api\u0000x']) {
      expect(() => parseSourceSpec(text, '/work'), text).toThrow(MergeStoryError);
    }
  });
});

describe('sourceSpecOf', () => {
  it('gives the text that parses back to the input', () => {
    const inputs = [
      { kind: 'local' as const, repoPath: '/work/api', base: null, head: null },
      { kind: 'local' as const, repoPath: '/work/api', base: 'main', head: 'fix/x' },
      { kind: 'local' as const, repoPath: '/work/api', base: null, head: 'fix/x' },
      { kind: 'github' as const, url: 'https://github.com/acme/app/pull/7' },
    ];
    for (const input of inputs) expect(parseSourceSpec(sourceSpecOf(input), '/other')).toEqual(input);
  });
});

describe('sourceInputsOf', () => {
  const local = (path: string) => ({ kind: 'local' as const, repoPath: path, base: null, head: null });

  it('returns the one source of the plain form, and the whole list of the list form', () => {
    expect(sourceInputsOf({ source: 'api', base: 'main' }, '/w')).toEqual([
      { kind: 'local', repoPath: '/w/api', base: 'main', head: null },
    ]);
    expect(sourceInputsOf({ source: local('/a'), sources: ['x', local('/b')] }, '/w')).toHaveLength(2);
  });

  it('refuses more than the limit, the same source twice, an empty list and refs', () => {
    const many = Array.from({ length: MAX_SOURCES + 1 }, (_, i) => local(`/r${i}`));
    for (const options of [
      { source: 'x', sources: many },
      { source: 'x', sources: [local('/a'), local('/a')] },
      { source: 'x', sources: [] },
      { source: 'x', sources: [local('/a'), local('/b')], base: 'main' },
    ]) {
      expect(() => sourceInputsOf(options, '/w')).toThrow(expect.objectContaining({ code: 'USAGE' }));
    }
  });
});
