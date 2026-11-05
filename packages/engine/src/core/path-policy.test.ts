import { describe, expect, it } from 'vitest';
import {
  compileGlobs,
  createPathPolicy,
  isProtectedFile,
  isShowable,
  matchesAnyGlob,
} from './path-policy.ts';

describe('globs for privacy.excludePaths', () => {
  it('matches a name without a slash at any depth', () => {
    const match = compileGlobs(['*.pem', 'secrets']);
    expect(match('server.pem')).toBe(true);
    expect(match('deploy/keys/server.pem')).toBe(true);
    expect(match('secrets')).toBe(true);
    expect(match('app/secrets/token.txt')).toBe(true);
    expect(match('server.pem.txt')).toBe(false);
    expect(match('not-secrets-here.txt')).toBe(false);
  });

  it('anchors a pattern with a slash to the repository root', () => {
    const match = compileGlobs(['config/*.json', '/root-only.txt']);
    expect(match('config/a.json')).toBe(true);
    expect(match('config/sub/a.json')).toBe(false);
    expect(match('src/config/a.json')).toBe(false);
    expect(match('root-only.txt')).toBe(true);
    expect(match('src/root-only.txt')).toBe(false);
  });

  it('treats ** as any number of directories', () => {
    const match = compileGlobs(['internal/**', 'src/**/generated/*.ts', '**/fixtures/**']);
    expect(match('internal/a.ts')).toBe(true);
    expect(match('internal/deep/er/a.ts')).toBe(true);
    expect(match('src/generated/a.ts')).toBe(true);
    expect(match('src/x/y/generated/a.ts')).toBe(true);
    expect(match('src/generated/sub/a.ts')).toBe(false);
    expect(match('test/fixtures/a.json')).toBe(true);
    expect(match('fixtures/a.json')).toBe(true);
    expect(match('other/a.ts')).toBe(false);
  });

  it('lets ** inside a name cross directories too', () => {
    const match = compileGlobs(['src/**.test.ts']);
    expect(match('src/b.test.ts')).toBe(true);
    expect(match('src/a/b.test.ts')).toBe(true);
    expect(match('src/a/b/c.test.ts')).toBe(true);
    expect(match('src/a/b.ts')).toBe(false);
    expect(match('lib/a/b.test.ts')).toBe(false);
  });

  it('matches a directory and everything beneath it', () => {
    const match = compileGlobs(['third_party/', 'docs/private']);
    expect(match('third_party/lib/a.js')).toBe(true);
    expect(match('pkg/third_party/a.js')).toBe(true);
    // A trailing slash means "a directory", so a file with that name is not matched.
    expect(match('third_party')).toBe(false);
    expect(match('docs/private/notes.md')).toBe(true);
    expect(match('docs/private')).toBe(true);
    expect(match('docs/public/notes.md')).toBe(false);
  });

  it('supports ? for one character, but not across a slash', () => {
    const match = compileGlobs(['file?.txt', 'a?b']);
    expect(match('file1.txt')).toBe(true);
    expect(match('file12.txt')).toBe(false);
    expect(match('a/b')).toBe(false);
    expect(match('axb')).toBe(true);
  });

  it('ignores case, so a pattern cannot be bypassed by renaming', () => {
    expect(matchesAnyGlob('Config/Secrets.JSON', ['config/secrets.json'])).toBe(true);
  });

  it('treats other characters literally', () => {
    const match = compileGlobs(['a+b(1).txt', 'x[1].md']);
    expect(match('a+b(1).txt')).toBe(true);
    expect(match('aab(1).txt')).toBe(false);
    expect(match('x[1].md')).toBe(true);
    expect(match('x1.md')).toBe(false);
  });

  it('reads an entry that starts with # as a pattern, not as a comment', () => {
    const match = compileGlobs(['#notes']);
    expect(match('#notes/plan.md')).toBe(true);
    expect(match('docs/#notes')).toBe(true);
    expect(match('notes/plan.md')).toBe(false);
  });

  it('normalises the tested path and skips empty patterns', () => {
    const match = compileGlobs(['', '  ', 'a/b.txt']);
    expect(match('./a/b.txt')).toBe(true);
    expect(match('a\\b.txt')).toBe(true);
    expect(match('c.txt')).toBe(false);
    expect(compileGlobs([])('anything')).toBe(false);
    expect(compileGlobs(['', ' ', '/'])('anything')).toBe(false);
  });

  it('does not blow up on long runs of wildcards', () => {
    const long = `${'a/'.repeat(200)}y`;
    for (const pattern of ['**/**/**/**/**/x', '***/***/***/***/***/x']) {
      const started = Date.now();
      expect(compileGlobs([pattern])(long)).toBe(false);
      expect(Date.now() - started).toBeLessThan(500);
    }
  });
});

describe('matching time', () => {
  it('answers a pattern with many wildcards in linear time', () => {
    const started = Date.now();
    expect(compileGlobs([`${'*a'.repeat(12)}b`])('a'.repeat(40))).toBe(false);
    expect(compileGlobs([`${'*a'.repeat(12)}b`])(`${'a'.repeat(40)}b`)).toBe(true);
    expect(compileGlobs([`${'**a'.repeat(12)}b`, `${'?*'.repeat(30)}c`])('a'.repeat(40))).toBe(false);
    expect(Date.now() - started).toBeLessThan(100);
  });
});

describe('createPathPolicy', () => {
  it('protects built-in sensitive files and the excluded paths', () => {
    const isProtected = createPathPolicy(['internal/']);
    expect(isProtected('.env')).toBe(true);
    expect(isProtected('deploy/id_rsa')).toBe(true);
    expect(isProtected('pkg/internal/a.ts')).toBe(true);
    expect(isProtected('src/a.ts')).toBe(false);
  });
});

describe('isShowable and isProtectedFile', () => {
  const file = { path: 'src/a.ts', oldPath: null };

  it('is true only for a text file that the source did not mark sensitive', () => {
    expect(isShowable({ ...file, binary: false, sensitive: false })).toBe(true);
    expect(isShowable({ ...file, binary: true, sensitive: false })).toBe(false);
    expect(isShowable({ ...file, binary: false, sensitive: true })).toBe(false);
    expect(isShowable({ ...file, binary: true, sensitive: true })).toBe(false);
  });

  it('still protects a built-in sensitive file that a hand-built change set did not mark', () => {
    // Library callers can pass their own change set; a key file must stay hidden without the flag.
    expect(isProtectedFile({ path: '.env', oldPath: null, sensitive: false })).toBe(true);
    expect(isProtectedFile({ path: 'deploy/server.pem', oldPath: null, sensitive: false })).toBe(true);
    expect(isProtectedFile({ path: 'config/settings.ts', oldPath: '.env', sensitive: false })).toBe(true);
    expect(isShowable({ path: '.env', oldPath: null, binary: false, sensitive: false })).toBe(false);
    expect(isProtectedFile({ ...file, sensitive: false })).toBe(false);
    expect(isProtectedFile({ ...file, sensitive: true })).toBe(true);
  });
});

/**
 * One verdict for each pattern and path, from the rules in the header of path-policy.ts and in the
 * privacy section of docs/configuration.md. `true` means the path is hidden.
 */
const TABLE: [pattern: string, path: string, hidden: boolean][] = [
  // A pattern without "/" names a file or folder at any depth.
  ['secrets', 'app/secrets/token.txt', true],
  ['*.pem', 'server.pem.txt', false],
  // A "/" at the start or in the middle anchors the pattern at the root of the repository.
  ['docs/private/', 'docs/private/x.md', true],
  ['docs/private/', 'a/docs/private/x.md', false],
  ['/root-only.txt', 'root-only.txt', true],
  ['/root-only.txt', 'src/root-only.txt', false],
  ['/build/', 'build/a.js', true],
  ['/build/', 'src/build/a.js', false],
  ['config/*.json', 'config/a.json', true],
  ['config/*.json', 'src/config/a.json', false],
  ['config/*.json', 'config/sub/a.json', false],
  // A "/" at the end means "a folder" and does not anchor the pattern.
  ['internal/', 'internal/a.ts', true],
  ['internal/', 'pkg/internal/a.ts', true],
  ['secrets/', 'packages/api/secrets/token.ts', true],
  ['internal\\', 'pkg/internal/a.ts', true],
  ['*.generated/', 'x/y.generated/a.ts', true],
  ['**/build/', 'x/build/a.js', true],
  ['src/*/', 'src/a/b.ts', true],
  ['src/**/', 'src/a/b.ts', true],
  ['internal/', 'internal', false],
  ['secrets/', 'not-secrets/a.txt', false],
  ['src/**/', 'src/a.ts', false],
  // A match on a folder covers everything inside it.
  ['src/internal', 'src/internal/a.ts', true],
  ['docs/private', 'docs/private/notes.md', true],
  ['src/*', 'src/a/b.ts', true],
  ['internal/**', 'internal', false],
  ['config/prod/**', 'config/prod/db.json', true],
  // "**/" matches whole folders, zero or more of them.
  ['**/generated/**', 'src/generated/api.ts', true],
  ['**/fixtures/**', 'fixtures/a.json', true],
  ['src/**/generated/*.ts', 'src/generated/a.ts', true],
  ['src/**/generated/*.ts', 'src/x/y/generated/a.ts', true],
  ['**/**/**/x', 'a/b/x', true],
  ['**/generated/**', 'src/autogenerated/api.ts', false],
  ['**/test/**', 'src/latest/a.ts', false],
  ['src/**/generated/*.ts', 'src/xgenerated/a.ts', false],
  ['src/**/generated/*.ts', 'src/generated/sub/a.ts', false],
  // Any other "**" matches any characters, "/" included, also inside a name.
  ['src/**.test.ts', 'src/b.test.ts', true],
  ['src/**.test.ts', 'src/a/b.test.ts', true],
  ['src/a**b/c.ts', 'src/a/x/b/c.ts', true],
  ['a/**b', 'a/x/yb', true],
  ['a**/b', 'a/x/b', true],
  ['foo**bar', 'foo/x/bar', true],
  ['**.ts', 'src/a.ts', true],
  ['***', 'a/b/c', true],
  // "*" and "?" stay inside one name.
  ['file?.txt', 'file1.txt', true],
  ['config/a?.json', 'config/a1.json', true],
  ['config/a?.json', 'config/a12.json', false],
  ['a?b', 'a/b', false],
  // Case is ignored.
  ['*.pem', 'KEYS/server.PEM', true],
  ['config/secrets.json', 'Config/Secrets.JSON', true],
  // Every other character matches itself: "#" starts no comment, "!" negates nothing, "[" opens no class.
  ['#notes', '#notes/a.md', true],
  ['#notes', 'docs/#notes', true],
  ['#', 'notes/#', true],
  ['!keep.ts', '!keep.ts', true],
  ['app/[slug]/', 'app/[slug]/page.tsx', true],
  ['!keep.ts', 'keep.ts', false],
  ['x[1].md', 'x1.md', false],
  ['src/a+b.ts', 'src/a+b.ts', true],
  ['src/a+b.ts', 'src/aab.ts', false],
  // Backslashes, a leading "./" and spaces around a pattern do not change it; paths are normalised too.
  ['./internal/', 'internal/a.ts', true],
  ['  internal/  ', 'internal/a.ts', true],
  ['a/b.txt', './a/b.txt', true],
  ['a/b.txt', 'a\\b.txt', true],
  // A blank pattern, or one that is only slashes, names nothing. A long pattern counts like any other.
  ['', 'a.ts', false],
  ['/', 'a.ts', false],
  ['./', 'a.ts', false],
  ['a'.repeat(600), 'a'.repeat(600), true],
];

describe('the privacy.excludePaths rules', () => {
  it('give one verdict for every pattern and path in the table', () => {
    const wrong = TABLE.filter(([pattern, path, hidden]) => matchesAnyGlob(path, [pattern]) !== hidden);
    expect(wrong).toEqual([]);
  });
});
