import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

/** A GitRunner whose "git" is the script given here (or none): the only program on the PATH. */
async function runnerWithGit(script: string | null): Promise<GitRunner> {
  const bin = await mkdtemp(join(tmpdir(), 'mergestory-git-bin-'));
  dirs.push(bin);
  if (script !== null) {
    const file = join(bin, 'git');
    await writeFile(file, `#!/bin/sh\nexec ${shellQuote(process.execPath)} -e ${shellQuote(script)}\n`);
    await chmod(file, 0o755);
  }
  vi.stubEnv('PATH', bin);
  const repo = await mkdtemp(join(tmpdir(), 'mergestory-git-repo-'));
  dirs.push(repo);
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
