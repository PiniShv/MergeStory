/** Small real git repositories for tests. Not part of the public API. */
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function git(repo: string, ...args: string[]): void {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
}

/** Git ignores the user's own settings until the returned function is called. */
export function isolateGitConfig(): () => void {
  const original = {
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  };
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  return () => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/**
 * A repository in `base/name` with a `main` branch and a `fix/total` branch. Both branches have
 * `src/total.js`. `readmeMore` is added to the README after its title.
 */
export async function makeRepo(
  base: string,
  name: string,
  before: string,
  after: string,
  readmeMore = '',
): Promise<string> {
  const repo = join(base, name);
  await mkdir(join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Demo');
  git(repo, 'config', 'user.email', 'demo@example.com');
  git(repo, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(repo, 'README.md'), `# ${name}\n${readmeMore}`);
  await writeFile(join(repo, 'src', 'total.js'), before);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', `Add ${name}`);
  git(repo, 'checkout', '-q', '-b', 'fix/total');
  await writeFile(join(repo, 'src', 'total.js'), after);
  git(repo, 'commit', '-q', '-am', `Use cents in ${name}`);
  return repo;
}
