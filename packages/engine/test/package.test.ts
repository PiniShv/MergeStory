/** What goes into the npm package: the licence and readme travel with it, test helpers and source maps do not. */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const repositoryRoot = join(root, '..', '..');
/** A test, or a helper only tests use: none of them belongs in the package. */
const TEST_FILE = /(^|\/)(testing|test-fixtures|test-support)\.|\.test\./;
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { files: string[] };

describe('package.json "files"', () => {
  it('lists a readme, a licence and a notice that exist in the package folder', () => {
    for (const name of ['README.md', 'LICENSE', 'NOTICE']) {
      expect(pkg.files).toContain(name);
      expect(existsSync(join(root, name)), name).toBe(true);
    }
    // The build output is made by `npm run build`, so it may be missing here. A listed folder or file that
    // does not exist would be silently left out of the package, so everything else must exist.
    for (const entry of pkg.files.filter((f) => !f.startsWith('!') && !/[*?]/.test(f) && f !== 'dist')) {
      expect(existsSync(join(root, entry)), entry).toBe(true);
    }
  });

  it('carries the licence and the notice of the repository, unchanged', () => {
    const own = readFileSync(join(root, 'LICENSE'), 'utf8');
    expect(own).toContain('Apache License');
    expect(own).toContain('Version 2.0, January 2004');
    expect(pkg.license).toBe('Apache-2.0');
    const notice = readFileSync(join(root, 'NOTICE'), 'utf8');
    expect(notice).toContain('The MergeStory Authors');
    for (const [name, text] of [
      ['LICENSE', own],
      ['NOTICE', notice],
    ]) {
      const top = join(repositoryRoot, name);
      if (existsSync(top)) expect(text, name).toBe(readFileSync(top, 'utf8'));
    }
  });

  it('describes the package in the readme', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    expect(readme).toMatch(/^# mergestory/);
    expect(readme).toContain('npm install -g mergestory');
    expect(readme).toContain('mergestory generate');
  });

  it('leaves source maps out of the package', () => {
    expect(pkg.files).toContain('!dist/**/*.map');
  });
});

describe('npm pack', () => {
  const built = existsSync(join(root, 'dist', 'cli', 'main.js'));

  it('keeps the folder of test fixtures out of the build', () => {
    const build = JSON.parse(readFileSync(join(root, 'tsconfig.build.json'), 'utf8')) as {
      exclude: string[];
    };
    expect(build.exclude).toContain('src/testing/**');
  });

  it.skipIf(!built)('has no folder of test fixtures in the build output', () => {
    expect(existsSync(join(root, 'dist', 'testing'))).toBe(false);
  });

  it.skipIf(!built)('has no test helper or test file in the build output', () => {
    const files = readdirSync(join(root, 'dist'), { recursive: true, encoding: 'utf8' });
    expect(files.filter((file) => TEST_FILE.test(file))).toEqual([]);
  });

  it.skipIf(!built)(
    'contains the readme and the licence, and no test helper or source map',
    () => {
      const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: process.platform === 'win32',
        env: { ...process.env, npm_config_update_notifier: 'false', npm_config_fund: 'false' },
      });
      const [info] = JSON.parse(output) as [{ files: { path: string }[] }];
      const paths = info.files.map((file) => file.path);
      expect(paths).toContain('package.json');
      expect(paths).toContain('README.md');
      expect(paths).toContain('LICENSE');
      expect(paths).toContain('dist/cli/main.js');
      expect(paths.filter((path) => TEST_FILE.test(path))).toEqual([]);
      expect(paths.filter((path) => path.startsWith('dist/testing/'))).toEqual([]);
      expect(paths.filter((path) => path.endsWith('.map'))).toEqual([]);
      expect(paths.filter((path) => path.startsWith('src/') || path.startsWith('test/'))).toEqual([]);
    },
    60_000,
  );
});
