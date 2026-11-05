import { describe, expect, it } from 'vitest';
import { buildChange, type FixtureFile } from '../testing/change.ts';
import { groupComponents } from './components.ts';
import { detectRole } from './roles.ts';

function group(files: FixtureFile[]) {
  const { changeSet } = buildChange(files);
  const inputs = changeSet.files.map((file) => ({ file, role: detectRole(file.path), trivial: false }));
  return { ...groupComponents(inputs), changeSet };
}

const add = (path: string, lines = 3): FixtureFile => ({
  path,
  base: null,
  head: Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n') + '\n',
});

function byPath(result: ReturnType<typeof group>) {
  return Object.fromEntries(result.components.map((m) => [m.path, m]));
}

describe('groupComponents', () => {
  it('groups monorepo packages by their directory', () => {
    const result = group([
      add('packages/api/src/a.ts'),
      add('packages/web/src/b.tsx'),
      add('services/forecast/main.go'),
      add('libs/util/y.ts'),
      add('crates/core/src/lib.rs'),
      add('apps/site/page.tsx'),
      add('modules/auth/z.ts'),
      add('cmd/tool/main.go'),
    ]);
    const m = byPath(result);
    expect(Object.keys(m).sort()).toEqual([
      'apps/site',
      'cmd/tool',
      'crates/core',
      'libs/util',
      'modules/auth',
      'packages/api',
      'packages/web',
      'services/forecast',
    ]);
    expect(m['packages/web']).toMatchObject({ name: 'web', kind: 'package' });
    expect(m['services/forecast']).toMatchObject({ name: 'forecast', kind: 'service' });
    expect(m['cmd/tool']?.kind).toBe('cli');
    expect(m['packages/api']?.kind).toBe('api');
  });

  it('groups by the first meaningful directory under a source root', () => {
    const result = group([
      add('src/retry/index.ts'),
      add('src/retry/backoff.ts'),
      add('src/http/client.ts'),
      add('lib/util/str.ts'),
      add('internal/auth/token.go'),
      add('app/models/user.rb'),
      add('src/index.ts'),
      add('src/main/java/com/acme/forecast/Report.java'),
      add('src/features/dashboard/widget.ts'),
    ]);
    const m = byPath(result);
    expect(m['src/retry']).toMatchObject({ name: 'retry', fileIds: ['F1', 'F2'] });
    expect(m['src/http']?.name).toBe('http');
    expect(m['lib/util']?.name).toBe('util');
    expect(m['internal/auth']?.name).toBe('auth');
    expect(m['app/models']).toMatchObject({ name: 'models', kind: 'data' });
    expect(m.src?.name).toBe('src');
    expect(m['src/main/java/com/acme/forecast']).toMatchObject({ name: 'forecast', fileIds: ['F8'] });
    expect(m['src/features/dashboard']).toMatchObject({ name: 'dashboard', fileIds: ['F9'] });
  });

  it('puts root files in "Project root"', () => {
    const result = group([
      add('README.md'),
      add('package.json'),
      add('.gitignore'),
      add('package-lock.json'),
    ]);
    expect(result.components).toHaveLength(1);
    expect(result.components[0]).toMatchObject({ name: 'Project root', path: '.', kind: 'config' });
  });

  it('infers kinds from directory names', () => {
    const result = group([
      add('src/routes/users.ts'),
      add('src/components/Button.tsx'),
      add('src/db/pool.ts'),
      add('src/cli/main.ts'),
      add('infra/main.tf'),
      add('modules/vpc/main.tf'),
      add('src/worker/run.ts'),
    ]);
    const kinds = Object.fromEntries(result.components.map((m) => [m.name, m.kind]));
    expect(kinds).toMatchObject({
      routes: 'api',
      components: 'ui',
      db: 'data',
      cli: 'cli',
      infra: 'infra',
      vpc: 'infra',
      worker: 'module',
    });
  });

  it('treats a directory of images or fonts as UI', () => {
    const result = group([add('assets/logo.png'), add('assets/fonts/inter.woff2')]);
    expect(result.components).toEqual([expect.objectContaining({ name: 'assets', kind: 'ui' })]);
  });

  it('folds tests into the component they mirror', () => {
    const result = group([
      add('src/retry/index.ts'),
      add('tests/retry/index.test.ts'),
      add('src/format.ts'),
      add('tests/format.test.ts'),
      add('src/retry/retry.test.ts'),
      add('tests/unrelated.test.ts'),
    ]);
    const owner = (id: string) => result.components.find((m) => m.fileIds.includes(id));
    expect(owner('F2')?.path).toBe('src/retry');
    expect(owner('F5')?.path).toBe('src/retry');
    expect(owner('F4')?.path).toBe('src');
    expect(owner('F6')).toMatchObject({ path: 'tests', kind: 'tests' });
  });

  it('does not fold a test into the project root just because root files changed', () => {
    const result = group([
      add('package.json'),
      add('src/http/client.ts'),
      add('tests/client.test.ts'),
      add('tests/other.test.ts'),
    ]);
    const owner = (id: string) => result.components.find((m) => m.fileIds.includes(id));
    expect(owner('F3')?.path).toBe('src/http');
    expect(owner('F4')).toMatchObject({ path: 'tests', kind: 'tests' });
    expect(owner('F1')?.path).toBe('.');
  });

  it('folds docs into the component they mirror and keeps the rest in a docs component', () => {
    const result = group([add('src/retry/index.ts'), add('docs/retry.md'), add('docs/guide.md')]);
    const owner = (id: string) => result.components.find((m) => m.fileIds.includes(id));
    expect(owner('F2')?.path).toBe('src/retry');
    expect(owner('F3')).toMatchObject({ path: 'docs', kind: 'docs' });
  });

  it('reports added, removed and modified components', () => {
    const result = group([
      add('src/new/a.ts'),
      { path: 'src/old/a.ts', base: 'x\n', head: null },
      { path: 'src/same/a.ts', base: 'a\n', head: 'b\n' },
      { path: 'src/mixed/a.ts', base: null, head: 'a\n' },
      { path: 'src/mixed/b.ts', base: 'a\n', head: 'b\n' },
    ]);
    const m = byPath(result);
    expect(m['src/new']?.status).toBe('added');
    expect(m['src/old']?.status).toBe('removed');
    expect(m['src/same']?.status).toBe('modified');
    expect(m['src/mixed']?.status).toBe('modified');
  });

  it('keeps CI files together and orders components by meaningful churn', () => {
    const result = group([
      add('.github/workflows/ci.yml', 2),
      add('.github/workflows/release.yml', 2),
      add('src/small/a.ts', 2),
      add('src/big/a.ts', 30),
    ]);
    expect(result.components[0]?.path).toBe('src/big');
    const ci = result.components.find((m) => m.name === 'CI');
    expect(ci).toMatchObject({ kind: 'infra', fileIds: ['F1', 'F2'] });
    expect(result.components.map((m) => m.id)).toEqual(['M1', 'M2', 'M3']);
  });

  it('uses full paths when two components share a name', () => {
    const result = group([add('packages/api/a.ts'), add('services/api/b.ts')]);
    expect(result.components.map((m) => m.name).sort()).toEqual(['packages/api', 'services/api']);
  });

  it('maps unchanged paths to a changed component', () => {
    const result = group([add('src/retry/index.ts'), add('packages/web/src/a.ts')]);
    expect(result.componentForPath('src/retry/other.ts')).toBe(result.byFile.get('F1'));
    expect(result.componentForPath('packages/web/src/zzz.ts')).toBe(result.byFile.get('F2'));
    expect(result.componentForPath('src/elsewhere/x.ts')).toBeNull();
  });
});
