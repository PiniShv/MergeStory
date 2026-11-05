import { describe, expect, it } from 'vitest';
import type { FileRole } from '../core/types.ts';
import { buildChange } from '../testing/change.ts';
import { detectRole } from './roles.ts';
import { classifyTrivial } from './trivial.ts';

describe('detectRole', () => {
  const cases: [string, FileRole][] = [
    ['src/app.ts', 'source'],
    ['src/components/Button.tsx', 'source'],
    ['lib/main.py', 'source'],
    ['cmd/server/main.go', 'source'],
    ['src/build/index.ts', 'source'],
    ['src/retry.test.ts', 'test'],
    ['src/retry.spec.js', 'test'],
    ['src/__tests__/retry.ts', 'test'],
    ['tests/test_retry.py', 'test'],
    ['pkg/retry_test.go', 'test'],
    ['spec/models/user_spec.rb', 'test'],
    ['test/fixtures/data.json', 'test'],
    ['README.md', 'docs'],
    ['docs/guide.md', 'docs'],
    ['docs/conf.py', 'docs'],
    ['CHANGELOG', 'docs'],
    ['notes.txt', 'docs'],
    ['.eslintrc.json', 'config'],
    ['tsconfig.json', 'config'],
    ['biome.json', 'config'],
    ['vitest.config.ts', 'config'],
    ['settings.yaml', 'config'],
    ['pyproject.toml', 'dependency-manifest'],
    ['.gitignore', 'config'],
    ['Dockerfile', 'build'],
    ['Makefile', 'build'],
    ['vite.config.ts', 'build'],
    ['webpack.config.js', 'build'],
    ['app/build.gradle', 'build'],
    ['.github/workflows/ci.yml', 'ci'],
    ['.gitlab-ci.yml', 'ci'],
    ['.circleci/config.yml', 'ci'],
    ['Jenkinsfile', 'ci'],
    ['package.json', 'dependency-manifest'],
    ['packages/api/package.json', 'dependency-manifest'],
    ['requirements.txt', 'dependency-manifest'],
    ['requirements-dev.txt', 'dependency-manifest'],
    ['go.mod', 'dependency-manifest'],
    ['Cargo.toml', 'dependency-manifest'],
    ['Gemfile', 'dependency-manifest'],
    ['pom.xml', 'dependency-manifest'],
    ['composer.json', 'dependency-manifest'],
    ['package-lock.json', 'lockfile'],
    ['pnpm-lock.yaml', 'lockfile'],
    ['yarn.lock', 'lockfile'],
    ['bun.lockb', 'lockfile'],
    ['Cargo.lock', 'lockfile'],
    ['poetry.lock', 'lockfile'],
    ['uv.lock', 'lockfile'],
    ['go.sum', 'lockfile'],
    ['Gemfile.lock', 'lockfile'],
    ['composer.lock', 'lockfile'],
    ['dist/bundle.js', 'generated'],
    ['build/output.js', 'generated'],
    ['public/app.min.js', 'generated'],
    ['src/schema.generated.ts', 'generated'],
    ['src/__generated__/types.ts', 'generated'],
    ['api/service.pb.go', 'generated'],
    ['proto/service_pb2.py', 'generated'],
    ['src/__snapshots__/a.test.ts.snap', 'generated'],
    ['assets/logo.png', 'asset'],
    ['fonts/Inter.woff2', 'asset'],
    ['media/demo.mp4', 'asset'],
    ['db/migrations/0001_init.sql', 'migration'],
    ['alembic/versions/abc_add_users.py', 'migration'],
    ['prisma/migrations/20240101_init/migration.sql', 'migration'],
    ['db/migrate/20240101_add_users.rb', 'migration'],
    ['LICENSE', 'docs'],
    ['data/blob.bin', 'other'],
  ];
  it.each(cases)('%s -> %s', (path, role) => {
    expect(detectRole(path)).toBe(role);
  });

  it('treats a .sql file as a migration only when it changes the schema', () => {
    expect(detectRole('sql/report.sql', 'ALTER TABLE users ADD COLUMN age int;')).toBe('migration');
    expect(detectRole('sql/report.sql', 'SELECT * FROM users')).toBe('source');
  });
});

function trivialFor(
  path: string,
  base: string | null,
  head: string | null,
  extra: Parameters<typeof buildChange>[0][number] = { path },
) {
  const { changeSet } = buildChange([{ ...extra, path, base, head }]);
  const file = changeSet.files[0]!;
  return classifyTrivial(file, detectRole(path));
}

describe('trivial detection', () => {
  it('flags whitespace-only changes', () => {
    const verdict = trivialFor('src/a.ts', 'const a = 1;\nfoo( 1,2 );\n', 'const a  =  1;\nfoo(1, 2);\n');
    expect(verdict).toMatchObject({ trivial: true, reason: 'whitespace-only change' });
  });

  it('flags re-wrapped lines as whitespace-only', () => {
    const verdict = trivialFor('src/a.ts', 'call(a, b, c);\n', 'call(\n  a,\n  b,\n  c);\n');
    expect(verdict.trivial).toBe(true);
    expect(verdict.reason).toBe('whitespace-only change');
  });

  it('does not treat a Python re-indent as whitespace-only', () => {
    const verdict = trivialFor('src/a.py', 'if x:\n    y()\n', 'if x:\n  y()\n');
    expect(verdict.trivial).toBe(false);
  });

  it('flags formatting-only changes (quotes, semicolons, trailing commas)', () => {
    const base = "const a = {\n  x: 'one',\n  y: 'two'\n}\nrun(a)\n";
    const head = 'const a = {\n  x: "one",\n  y: "two",\n};\nrun(a);\n';
    const verdict = trivialFor('src/a.ts', base, head);
    expect(verdict.trivial).toBe(true);
    expect(verdict.reason).toMatch(/^formatting-only/);
  });

  it('does not call a change inside a string whitespace-only', () => {
    expect(trivialFor('src/a.ts', 'say("Hello World");\n', 'say("HelloWorld");\n').trivial).toBe(false);
    expect(trivialFor('q.sql', "SELECT 'a b';\n", "SELECT 'ab';\n").trivial).toBe(false);
    expect(trivialFor('src/a.ts', 'say("a");\n', "say('a');\n").reason).toMatch(/^formatting-only/);
  });

  it('does not call quote or semicolon changes formatting outside JavaScript and TypeScript', () => {
    expect(trivialFor('deploy.sh', 'rm -rf "$DIR"\n', "rm -rf '$DIR'\n").trivial).toBe(false);
    expect(trivialFor('deploy.sh', 'cd build; rm -rf dist\n', 'cd build rm -rf dist\n').trivial).toBe(false);
  });

  it('still flags a whitespace-only change outside JavaScript', () => {
    expect(trivialFor('deploy.sh', 'cd  build\nrm -rf dist\n', 'cd build\nrm -rf  dist\n')).toMatchObject({
      trivial: true,
      reason: 'whitespace-only change',
    });
  });

  it('does not call a space that splits or joins words whitespace-only', () => {
    expect(
      trivialFor('install.sh', 'rm -rf "$PREFIX"/usr/lib/foo\n', 'rm -rf "$PREFIX" /usr/lib/foo\n').trivial,
    ).toBe(false);
    expect(trivialFor('deploy.sh', 'cd build\nrm -rf dist\n', 'cd build rm -rf dist\n').trivial).toBe(false);
    expect(trivialFor('q.sql', 'DROP TABLE a_b;\n', 'DROP TABLE a _b;\n').trivial).toBe(false);
    expect(trivialFor('a.rb', 'x = y - 1\n', 'x = y -1\n').trivial).toBe(false);
  });

  it('still flags re-indented blocks, trailing spaces and blank lines outside JavaScript', () => {
    expect(trivialFor('src/a.c', 'if (x) {\n    f();\n}\n', 'if (x) {\n\tf();   \n\n}\n')).toMatchObject({
      trivial: true,
      reason: 'whitespace-only change',
    });
    expect(trivialFor('src/a.go', 'func f() {\n\tg()\n}\n', 'func f() {\n    g()\n}\n\n')).toMatchObject({
      trivial: true,
      reason: 'whitespace-only change',
    });
  });

  it('flags a trailing comma added at the end of a multi-line list', () => {
    const verdict = trivialFor(
      'src/a.ts',
      'const a = {\n  x: 1,\n  y: 2\n};\n',
      'const a = {\n  x: 1,\n  y: 2,\n};\n',
    );
    expect(verdict.trivial).toBe(true);
    expect(verdict.reason).toMatch(/^formatting-only/);
  });

  it('does not flag a changed value that sits next to a comma', () => {
    expect(
      trivialFor('src/a.ts', 'const a = {\n  x: 1,\n  y: 2\n};\n', 'const a = {\n  x: 1,\n  y: 3,\n};\n')
        .trivial,
    ).toBe(false);
  });

  it('does not flag a real change', () => {
    const verdict = trivialFor('src/a.ts', 'const a = 1;\n', 'const a = 2;\n');
    expect(verdict).toEqual({ trivial: false, reason: null, commentOnly: false });
  });

  it('flags a pure rename', () => {
    const { changeSet } = buildChange([
      { path: 'src/new.ts', oldPath: 'src/old.ts', status: 'renamed', base: 'x\n', head: 'x\n' },
    ]);
    const verdict = classifyTrivial(changeSet.files[0]!, 'source');
    expect(verdict).toMatchObject({ trivial: true, reason: expect.stringContaining('pure rename') });
  });

  it('keeps a rename with edits non-trivial', () => {
    const { changeSet } = buildChange([
      { path: 'src/new.ts', oldPath: 'src/old.ts', status: 'renamed', base: 'x\n', head: 'y\n' },
    ]);
    expect(classifyTrivial(changeSet.files[0]!, 'source').trivial).toBe(false);
  });

  it('flags lockfiles and generated files without looking at lines', () => {
    expect(trivialFor('package-lock.json', '{}\n', '{"a":1}\n')).toMatchObject({
      trivial: true,
      reason: 'lockfile',
    });
    expect(trivialFor('dist/a.js', 'a\n', 'b\n')).toMatchObject({ trivial: true, reason: 'generated file' });
  });

  it('marks comment-only changes as such without making them trivial', () => {
    const verdict = trivialFor(
      'src/a.ts',
      'const a = 1;\n// old note\n',
      'const a = 1;\n// new note about retries\n',
    );
    expect(verdict).toEqual({ trivial: false, reason: null, commentOnly: true });
  });

  it.each([
    ['src/a.go', '// old note\n', '// new note\n'],
    ['src/a.py', '# old note\n', '# new note\n'],
    ['src/a.php', '# old note\n', '# new note\n'],
    ['src/a.php', '// old note\n', '// new note\n'],
    ['db/a.sql', '-- old note\n', '-- new note\n'],
    ['web/a.html', '<!-- old note -->\n', '<!-- new note -->\n'],
    ['Dockerfile', '# old note\n', '# new note\n'],
  ])('knows how a comment starts in %s', (path, base, head) => {
    expect(trivialFor(path, base, head).commentOnly).toBe(true);
  });

  it('does not take a line for a comment in a language whose comments it does not know', () => {
    expect(trivialFor('data/a.json', '// old note\n', '// new note\n').commentOnly).toBe(false);
    expect(trivialFor('src/a.py', '# old note\n', 'run()\n').commentOnly).toBe(false);
  });

  it.each(['Makefile', 'rules.mk', 'ci/a.yaml', 'a.yml', 'README.md'])(
    'does not treat re-indenting %s as whitespace-only',
    (path) => {
      expect(trivialFor(path, 'a:\n    b\n', 'a:\n  b\n').trivial).toBe(false);
    },
  );

  it.each(['src/a.ts', 'src/a.go', 'Dockerfile', 'web/a.html'])(
    'treats re-indenting %s as whitespace-only',
    (path) => {
      expect(trivialFor(path, 'a:\n    b\n', 'a:\n  b\n')).toMatchObject({
        trivial: true,
        reason: 'whitespace-only change',
      });
    },
  );
});
