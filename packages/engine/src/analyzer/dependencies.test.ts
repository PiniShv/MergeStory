import { describe, expect, it } from 'vitest';
import { buildChange } from '../testing/change.ts';
import { diffManifest } from './dependencies.ts';

function diff(path: string, base: string | null, head: string | null) {
  const file = buildChange([{ path, base, head }]).changeSet.files[0]!;
  return diffManifest(file, base, head).map(({ fileId: _f, ...rest }) => rest);
}

const pkg = (value: object) => `${JSON.stringify(value, null, 2)}\n`;

describe('diffManifest', () => {
  it('diffs package.json dependency sections', () => {
    const base = pkg({
      name: 'x',
      dependencies: { a: '^1.0.0', b: '^2.0.0' },
      devDependencies: { vitest: '1.0.0' },
      peerDependencies: { react: '>=18' },
    });
    const head = pkg({
      name: 'x',
      dependencies: { a: '^1.1.0', c: '^3.0.0' },
      devDependencies: { vitest: '2.0.0', tsx: '^4.0.0' },
      peerDependencies: { react: '>=18' },
    });
    expect(diff('package.json', base, head)).toEqual([
      { ecosystem: 'npm', name: 'a', change: 'updated', from: '^1.0.0', to: '^1.1.0', dev: false },
      { ecosystem: 'npm', name: 'b', change: 'removed', from: '^2.0.0', to: null, dev: false },
      { ecosystem: 'npm', name: 'c', change: 'added', from: null, to: '^3.0.0', dev: false },
      { ecosystem: 'npm', name: 'tsx', change: 'added', from: null, to: '^4.0.0', dev: true },
      { ecosystem: 'npm', name: 'vitest', change: 'updated', from: '1.0.0', to: '2.0.0', dev: true },
    ]);
  });

  it('ignores a dependency that only moves between dev and prod', () => {
    const base = pkg({ dependencies: {}, devDependencies: { zod: '^4.0.0' } });
    const head = pkg({ dependencies: { zod: '^4.0.0' }, devDependencies: {} });
    expect(diff('package.json', base, head)).toEqual([]);
  });

  it('treats a new manifest as all additions and a deleted one as all removals', () => {
    const content = pkg({ dependencies: { a: '1.0.0' } });
    expect(diff('package.json', null, content).map((d) => d.change)).toEqual(['added']);
    expect(diff('package.json', content, null).map((d) => d.change)).toEqual(['removed']);
  });

  it('survives invalid JSON', () => {
    expect(diff('package.json', '{ not json', '{ nope')).toEqual([]);
  });

  it('diffs requirements.txt', () => {
    const base = 'requests==2.0.0\nflask>=2.0\n# comment\n-r other.txt\n';
    const head = 'requests==2.31.0\nflask>=2.0\nnumpy\nPyYAML[extra]~=6.0\n';
    expect(diff('requirements.txt', base, head)).toEqual([
      { ecosystem: 'pypi', name: 'numpy', change: 'added', from: null, to: '*', dev: false },
      { ecosystem: 'pypi', name: 'pyyaml', change: 'added', from: null, to: '~=6.0', dev: false },
      { ecosystem: 'pypi', name: 'requests', change: 'updated', from: '2.0.0', to: '2.31.0', dev: false },
    ]);
    expect(diff('requirements-dev.txt', null, 'pytest==8.0\n')[0]).toMatchObject({
      name: 'pytest',
      dev: true,
    });
    expect(diff('requirements/test.txt', null, 'pytest==8.0\n')[0]).toMatchObject({ dev: true });
  });

  it('does not call a requirements file dev because of a folder name', () => {
    expect(diff('services/latest-api/requirements.txt', null, 'requests==2.0\n')[0]).toMatchObject({
      name: 'requests',
      dev: false,
    });
  });

  it('diffs go.mod require lines and skips indirect ones', () => {
    const base =
      'module x\n\ngo 1.22\n\nrequire (\n\tgithub.com/a/b v1.0.0\n\tgithub.com/c/d v0.1.0 // indirect\n)\n';
    const head =
      'module x\n\ngo 1.22\n\nrequire (\n\tgithub.com/a/b v1.2.0\n\tgithub.com/c/d v0.2.0 // indirect\n)\n\nrequire github.com/e/f v2.0.0\n';
    expect(diff('go.mod', base, head)).toEqual([
      {
        ecosystem: 'go',
        name: 'github.com/a/b',
        change: 'updated',
        from: 'v1.0.0',
        to: 'v1.2.0',
        dev: false,
      },
      { ecosystem: 'go', name: 'github.com/e/f', change: 'added', from: null, to: 'v2.0.0', dev: false },
    ]);
  });

  it('diffs Cargo.toml tables', () => {
    const base =
      '[package]\nname = "x"\n\n[dependencies]\nserde = "1.0"\n\n[dev-dependencies]\ntempfile = "3"\n';
    const head =
      '[package]\nname = "x"\n\n[dependencies]\nserde = { version = "1.0.200", features = ["derive"] }\ntokio = { version = "1", features = ["full"] }\nlocal = { path = "../local" }\n\n[dev-dependencies]\ntempfile = "3"\n';
    expect(diff('Cargo.toml', base, head)).toEqual([
      { ecosystem: 'cargo', name: 'local', change: 'added', from: null, to: 'path', dev: false },
      { ecosystem: 'cargo', name: 'serde', change: 'updated', from: '1.0', to: '1.0.200', dev: false },
      { ecosystem: 'cargo', name: 'tokio', change: 'added', from: null, to: '1', dev: false },
    ]);
  });

  it('diffs pyproject.toml project and poetry dependencies', () => {
    const base =
      '[project]\nname = "x"\ndependencies = [\n  "httpx>=0.25",\n]\n\n[tool.poetry.group.dev.dependencies]\npytest = "^7.0"\n';
    const head =
      '[project]\nname = "x"\ndependencies = [\n  "httpx>=0.27",\n  "pydantic>=2",\n]\n\n[tool.poetry.group.dev.dependencies]\npytest = "^8.0"\n';
    expect(diff('pyproject.toml', base, head)).toEqual([
      { ecosystem: 'pypi', name: 'httpx', change: 'updated', from: '>=0.25', to: '>=0.27', dev: false },
      { ecosystem: 'pypi', name: 'pydantic', change: 'added', from: null, to: '>=2', dev: false },
      { ecosystem: 'pypi', name: 'pytest', change: 'updated', from: '^7.0', to: '^8.0', dev: true },
    ]);
  });

  it('diffs a Gemfile and a pom.xml', () => {
    const gemBase = "gem 'rails', '~> 7.0'\ngroup :test do\n  gem 'rspec'\nend\n";
    const gemHead = "gem 'rails', '~> 7.1'\ngem 'puma'\ngroup :test do\n  gem 'rspec'\nend\n";
    expect(diff('Gemfile', gemBase, gemHead).map((d) => [d.name, d.change])).toEqual([
      ['puma', 'added'],
      ['rails', 'updated'],
    ]);
    const pom = (v: string) =>
      `<project><dependencies><dependency><groupId>org.x</groupId><artifactId>lib</artifactId><version>${v}</version><scope>test</scope></dependency></dependencies></project>`;
    expect(diff('pom.xml', pom('1.0'), pom('2.0'))).toEqual([
      { ecosystem: 'maven', name: 'org.x:lib', change: 'updated', from: '1.0', to: '2.0', dev: true },
    ]);
  });

  it('returns nothing for files that are not manifests', () => {
    expect(diff('src/a.ts', 'a', 'b')).toEqual([]);
  });
});
