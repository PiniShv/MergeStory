import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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

  it('refuses a repository that no .git entry names', async () => {
    const outer = await newRepo();
    // A folder that is a repository itself, as a checkout can bring along.
    const inner = join(outer, 'vendor', 'tool');
    git(outer, 'init', '-q', '--bare', inner);
    await appendFile(join(inner, 'config'), '[core]\n\tbare = false\n\tworktree = .\n');
    // Plain git uses it.
    expect(git(inner, '-c', 'safe.bareRepository=all', 'rev-parse', '--show-toplevel')).toBe(
      git(inner, '-c', 'safe.bareRepository=all', 'rev-parse', '--absolute-git-dir'),
    );

    const error = await failure(new GitRunner(inner, testContext().ctx).run(['status', '--porcelain']));
    expect(error).toMatchObject({ code: 'SOURCE_INVALID' });
    expect((error as MergeStoryError).message).toContain('is not one that a .git entry names');
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
    // The same with a relative path and Windows line ends in the .git file, as a submodule has.
    await writeFile(join(separate, '.git'), `gitdir: ../${basename(separate)}-gitdir\r\n`);
    expect(await toplevel(separate)).toBe(git(separate, 'rev-parse', '--show-toplevel'));
  });

  it('works in a work tree of a bare clone, with a .git that is a link, and in a submodule', async () => {
    const repo = await newRepo();
    await writeFile(join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', '.');
    git(repo, '-c', 'user.name=T', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'first');
    const same = async (dir: string): Promise<void> =>
      expect(await toplevel(dir)).toBe(git(dir, 'rev-parse', '--show-toplevel'));

    const bare = `${repo}-bare.git`;
    const tree = `${repo}-bare-tree`;
    dirs.push(bare, tree);
    git(repo, 'clone', '-q', '--bare', repo, bare);
    git(bare, 'worktree', 'add', '-q', tree);
    await same(tree);

    const viaLink = await mkdtemp(join(tmpdir(), 'mergestory-git-link-'));
    dirs.push(viaLink);
    await symlink(join(repo, '.git'), join(viaLink, '.git'));
    await same(viaLink);

    git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', bare, 'mod');
    await same(join(repo, 'mod'));
  });

  // One folder can have two names that no link explains. macOS gives every path such a second name.
  const SECOND_NAME = '/System/Volumes/Data';
  it.runIf(existsSync(SECOND_NAME))('knows a folder under its second name', async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'mergestory-git-home-')));
    dirs.push(home);
    const draft = join(home, 'work', 'draft');
    await mkdir(draft, { recursive: true });
    git(draft, 'init', '-q');
    const refused = {
      code: 'SOURCE_INVALID',
      message: 'MergeStory does not run git in its work folder, or in a repository kept there.',
    };
    // The home under one name and the folder under the other, both ways round.
    const renamedHome = testContext({ home: SECOND_NAME + home }).ctx;
    expect(await failure(new GitRunner(draft, renamedHome).run(['status']))).toMatchObject(refused);
    const plainHome = testContext({ home }).ctx;
    expect(await failure(new GitRunner(SECOND_NAME + draft, plainHome).run(['status']))).toMatchObject(
      refused,
    );
    // A normal clone works under its second name too.
    const repo = await realpath(await newRepo());
    expect((await new GitRunner(SECOND_NAME + repo, testContext().ctx).run(['status'])).code).toBe(0);
  });

  it('refuses a repository in the work folder, where a coding agent writes without asking', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mergestory-git-home-'));
    dirs.push(home);
    const { ctx } = testContext({ home });
    const refused = {
      code: 'SOURCE_INVALID',
      message: 'MergeStory does not run git in its work folder, or in a repository kept there.',
    };

    // A whole repository there, with a real .git folder.
    const draft = join(home, 'work', 'draft');
    await mkdir(draft, { recursive: true });
    git(draft, 'init', '-q');
    expect(await failure(new GitRunner(draft, ctx).run(['status']))).toMatchObject(refused);

    // A folder elsewhere whose .git file points into the work folder.
    const elsewhere = await mkdtemp(join(tmpdir(), 'mergestory-git-work-'));
    dirs.push(elsewhere);
    git(elsewhere, 'init', '-q', `--separate-git-dir=${join(home, 'work', 'kept')}`);
    expect(await failure(new GitRunner(elsewhere, ctx).run(['status']))).toMatchObject(refused);

    // The same repository is fine for a home that keeps its work folder elsewhere.
    const other = testContext({ home: `${home}-other` }).ctx;
    expect((await new GitRunner(elsewhere, other).run(['status'])).code).toBe(0);
  });
});
