import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MergeStoryError } from '../core/errors.ts';
import { shellQuote } from '../core/text.ts';
import { testContext } from '../testing/context.ts';
import { GitOutputTooLargeError, GitRunner } from './git.ts';

const dirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * A GitRunner whose "git" is the script given here (or none): the only program on the PATH. The
 * script answers the runner's first question (which repository is this?) with the folder's `.git`.
 */
async function runnerWithGit(script: string | null): Promise<GitRunner> {
  const repo = await mkdtemp(join(tmpdir(), 'mergestory-git-repo-'));
  const bin = await mkdtemp(join(tmpdir(), 'mergestory-git-bin-'));
  dirs.push(repo, bin);
  await mkdir(join(repo, '.git'));
  if (script !== null) {
    const file = join(bin, 'git');
    const gitDir = `case " $* " in *" --absolute-git-dir "*) echo ${shellQuote(join(repo, '.git'))}; exit 0;; esac`;
    await writeFile(
      file,
      `#!/bin/sh\n${gitDir}\nexec ${shellQuote(process.execPath)} -e ${shellQuote(script)}\n`,
    );
    await chmod(file, 0o755);
  }
  vi.stubEnv('PATH', bin);
  return new GitRunner(repo, testContext().ctx);
}

const failure = (promise: Promise<unknown>): Promise<unknown> => promise.catch((e: unknown) => e);

describe('GitRunner errors', () => {
  it('says that git is missing when no git is on the PATH', async () => {
    const error = await failure((await runnerWithGit(null)).run(['status']));
    expect(error).toMatchObject({ code: 'GIT_FAILED', message: 'git is not installed or not on the PATH.' });
    expect((error as MergeStoryError).hint).toContain('Install git');
  });

  it('says that git was too slow when it runs past its time limit', async () => {
    const runner = await runnerWithGit('setTimeout(() => {}, 10000);');
    const error = await failure(runner.run(['status'], { timeoutMs: 100 }));
    expect(error).toMatchObject({ code: 'GIT_FAILED', message: 'git took too long to answer.' });
  });

  it('says that the output was too large when git prints more than may be read', async () => {
    const runner = await runnerWithGit("process.stdout.write('x'.repeat(5000));");
    const error = await failure(runner.run(['log'], { maxOutputBytes: 1000 }));
    expect(error).toBeInstanceOf(GitOutputTooLargeError);
    expect(error).toMatchObject({
      code: 'GIT_FAILED',
      message: 'git printed more output than MergeStory reads.',
    });
    expect((error as MergeStoryError).hint).toContain('--base and --head');
  });

  it('refuses a git that lies inside the repository being explained', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'mergestory-git-repo-'));
    dirs.push(repo);
    await writeFile(join(repo, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    vi.stubEnv('PATH', repo);
    const error = await failure(new GitRunner(repo, testContext().ctx).run(['status']));
    expect(error).toMatchObject({ code: 'USAGE' });
    expect((error as MergeStoryError).message).toContain('git was found inside');
  });

  it('returns a non-zero exit code instead of throwing', async () => {
    const runner = await runnerWithGit('process.exit(7);');
    expect((await runner.run(['status'])).code).toBe(7);
  });
});

describe('GitRunner: which repository', () => {
  /** Real git, without the developer's own settings. */
  const git = (cwd: string, ...args: string[]): string => {
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  };
  const newRepo = async (): Promise<string> => {
    const repo = await mkdtemp(join(tmpdir(), 'mergestory-git-repo-'));
    dirs.push(repo);
    git(repo, 'init', '-q');
    return repo;
  };
  const toplevel = (dir: string): Promise<string> =>
    new GitRunner(dir, testContext().ctx).ok(['rev-parse', '--show-toplevel']).then((out) => out.trim());

  it('refuses a repository that no .git entry names, and runs no program that its settings name', async () => {
    const outer = await newRepo();
    // A folder that is a repository itself: what a checkout can bring along.
    const inner = join(outer, 'vendor', 'tool');
    const marker = join(outer, 'filter-ran');
    git(outer, 'init', '-q', '--bare', inner);
    await appendFile(join(inner, 'config'), '[core]\n\tbare = false\n\tworktree = .\n');
    await writeFile(join(inner, 'file.txt'), 'one\n');
    git(outer, `--git-dir=${inner}`, `--work-tree=${inner}`, 'add', 'file.txt');
    await appendFile(join(inner, 'config'), `[filter "x"]\n\tclean = "touch '${marker}'; cat"\n`);
    await writeFile(join(inner, '.gitattributes'), '* filter=x\n');
    // Same size as before, so git has to read the file (through the filter) to see the change.
    await writeFile(join(inner, 'file.txt'), 'two\n');

    // The setup is real: plain git, started in that folder, runs the program.
    git(inner, '-c', 'safe.bareRepository=all', 'status', '--porcelain');
    expect(existsSync(marker)).toBe(true);
    await rm(marker);

    const error = await failure(new GitRunner(inner, testContext().ctx).run(['status', '--porcelain']));
    expect(error).toMatchObject({ code: 'SOURCE_INVALID' });
    expect((error as MergeStoryError).message).toContain('is not one that a .git entry names');
    expect(existsSync(marker)).toBe(false);
  });

  it('works in a subfolder, a linked work tree and a work tree with a .git file', async () => {
    const repo = await newRepo();
    await mkdir(join(repo, 'src', 'deep'), { recursive: true });
    await writeFile(join(repo, 'src', 'deep', 'a.txt'), 'a\n');
    git(repo, 'add', '.');
    git(repo, '-c', 'user.name=T', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'first');
    const real = git(repo, 'rev-parse', '--show-toplevel');
    expect(await toplevel(join(repo, 'src', 'deep'))).toBe(real);
    // A stray, empty .git folder on the way up: git skips it, and so does the check.
    await mkdir(join(repo, 'src', '.git'));
    expect(await toplevel(join(repo, 'src', 'deep'))).toBe(real);

    const linked = `${repo}-linked`;
    dirs.push(linked);
    git(repo, 'worktree', 'add', '-q', linked);
    expect(await toplevel(linked)).toBe(git(linked, 'rev-parse', '--show-toplevel'));

    const separate = await mkdtemp(join(tmpdir(), 'mergestory-git-work-'));
    dirs.push(separate, `${separate}-gitdir`);
    git(separate, 'init', '-q', `--separate-git-dir=${separate}-gitdir`);
    expect(await toplevel(separate)).toBe(git(separate, 'rev-parse', '--show-toplevel'));
  });
});
