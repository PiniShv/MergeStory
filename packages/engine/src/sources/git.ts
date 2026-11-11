/**
 * Running git for the local source.
 *
 * Every command runs without a shell, with an argument array, and in a clean environment:
 * variables that could point git at another repository are removed, optional locks are off (so
 * git never refreshes the index of the repository being read), and configuration that changes
 * output format or runs programs (pager, external diff, file system monitor) is overridden.
 *
 * The settings of a repository can also name programs (a filter, for example). Those of a normal
 * clone are the user's own. A repository that sits in a checked-out folder brings settings that
 * someone else wrote, so git only runs in a repository that a `.git` entry names: git never
 * checks out an entry with that name.
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { gitEnvironment } from '../core/child-env.ts';
import { Semaphore } from '../core/concurrency.ts';
import type { RunContext } from '../core/context.ts';
import { CommandNotFoundError, MergeStoryError, OutputTooLargeError, TimedOutError } from '../core/errors.ts';
import { findProgram, type RunResult, runCommand } from '../core/process.ts';

/** Settings that make output stable, and stop git running programs named in configuration. */
const BASE_CONFIG = [
  '-c',
  'core.quotepath=false',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'diff.suppressBlankEmpty=false',
  '-c',
  'log.showSignature=false',
];

/** git 2.38 and later: never use a bare repository found by walking up from the current folder. */
const NO_FOUND_BARE = ['-c', 'safe.bareRepository=explicit'];

const DEFAULT_TIMEOUT_MS = 60_000;
/** Parallel git processes. Reading many files should not start hundreds at once. */
export const MAX_PARALLEL_GIT = 8;

/** Thrown when git printed more than the caller was willing to read. */
export class GitOutputTooLargeError extends MergeStoryError {
  constructor(message: string, cause?: unknown) {
    super('GIT_FAILED', message, {
      cause,
      hint: 'The change is too large to read in one piece. Choose a smaller range with --base and --head.',
    });
    this.name = 'GitOutputTooLargeError';
  }
}

export interface GitRunOptions {
  /** Treat pathspecs as plain file names (no wildcards). */
  literalPathspecs?: boolean;
  maxOutputBytes?: number;
  timeoutMs?: number;
}

/**
 * Whether a `.git` entry at or above `start` names `gitDir` (a real path): as that folder itself,
 * or as the target of a `.git` file (a linked work tree, a submodule).
 */
async function isNamedByDotGit(start: string, gitDir: string): Promise<boolean> {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    const entry = join(dir, '.git');
    const info = await stat(entry).catch(() => null);
    let named: string | null = null;
    if (info?.isDirectory()) {
      named = entry;
    } else if (info?.isFile() && info.size < 1024 * 1024) {
      const target = /^gitdir: (.+)$/m.exec(await readFile(entry, 'utf8'))?.[1]?.trim();
      named = target ? resolve(dir, target) : null;
    }
    if (named !== null && (await realpath(named).catch(() => null)) === gitDir) return true;
    if (dirname(dir) === dir) return false;
  }
}

export class GitRunner {
  readonly cwd: string;
  private readonly ctx: Pick<RunContext, 'signal' | 'redactor'>;
  private readonly limiter = new Semaphore(MAX_PARALLEL_GIT);
  /** git, found once on PATH and started by its absolute path. */
  private program: Promise<string> | undefined;
  /** The repository check, made once: null when git may run here, else the failed lookup. */
  private checked: Promise<RunResult | null> | undefined;

  constructor(cwd: string, ctx: Pick<RunContext, 'signal' | 'redactor'>) {
    this.cwd = cwd;
    this.ctx = ctx;
  }

  /** Run git. A non-zero exit code is returned, not thrown. */
  async run(args: string[], options: GitRunOptions = {}): Promise<RunResult> {
    const full = [
      '--no-pager',
      ...(options.literalPathspecs ? ['--literal-pathspecs'] : []),
      ...BASE_CONFIG,
      ...NO_FOUND_BARE,
      ...args,
    ];
    try {
      this.program ??= findProgram('git', [this.cwd]);
      const program = await this.program;
      const refused = await this.checkRepository(program, options);
      if (refused) return refused;
      return await this.limiter.run(() =>
        runCommand(program, full, {
          cwd: this.cwd,
          env: gitEnvironment(),
          signal: this.ctx.signal,
          allowFailure: true,
          maxOutputBytes: options.maxOutputBytes,
          timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        }),
      );
    } catch (error) {
      throw this.toGitError(error);
    }
  }

  /**
   * Before the first command: ask git which repository it finds from this folder (`rev-parse` runs
   * no program from the settings) and refuse one that no `.git` entry names. When git finds no
   * repository, its answer stands in for every command here, which would fail the same way.
   */
  private async checkRepository(program: string, options: GitRunOptions): Promise<RunResult | null> {
    this.checked ??= (async () => {
      const found = await runCommand(
        program,
        ['--no-pager', ...BASE_CONFIG, 'rev-parse', '--absolute-git-dir'],
        {
          cwd: this.cwd,
          env: gitEnvironment(),
          signal: this.ctx.signal,
          allowFailure: true,
          maxOutputBytes: 64 * 1024,
          timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        },
      );
      if (found.code !== 0) return found;
      const used = await realpath(found.stdout.trim()).catch(() => null);
      if (used !== null && (await isNamedByDotGit(this.cwd, used))) return null;
      throw new MergeStoryError(
        'SOURCE_INVALID',
        `The git repository found from ${this.cwd} is not one that a .git entry names.`,
        {
          hint: 'Run MergeStory in a normal clone or work tree. A bare repository, or one that sits inside a checked-out folder, is refused: its settings can name programs for git to run.',
        },
      );
    })();
    try {
      return await this.checked;
    } catch (error) {
      // Not kept: the next command asks again (the lookup may have been cancelled or too slow).
      this.checked = undefined;
      throw error;
    }
  }

  /** Run git and return stdout; any non-zero exit code is a GIT_FAILED error. */
  async ok(args: string[], options: GitRunOptions = {}): Promise<string> {
    const result = await this.run(args, options);
    if (result.code !== 0) throw this.failure(args[0] ?? 'git', result);
    return result.stdout;
  }

  /** Build the error for a failed command, with a hint for the causes people run into. */
  failure(command: string, result: RunResult): MergeStoryError {
    const detail = this.ctx.redactor
      .redact(result.stderr.trim().split('\n').slice(-3).join(' '))
      .slice(0, 300);
    const dubious = /dubious ownership/i.test(result.stderr);
    return new MergeStoryError(
      'GIT_FAILED',
      `git ${command} failed (exit code ${result.code}). ${detail}`.trim(),
      {
        hint: dubious
          ? `Git does not trust the owner of this repository. If you trust it, run: git config --global --add safe.directory ${this.cwd}`
          : 'Check that the path is a healthy git repository (try "git status" there).',
        details: { command, exitCode: result.code },
      },
    );
  }

  private toGitError(error: unknown): unknown {
    if (this.ctx.signal.aborted) return error;
    if (error instanceof CommandNotFoundError) {
      return new MergeStoryError('GIT_FAILED', 'git is not installed or not on the PATH.', {
        hint: 'Install git (https://git-scm.com/downloads) and try again.',
        cause: error,
      });
    }
    if (error instanceof OutputTooLargeError) {
      return new GitOutputTooLargeError('git printed more output than MergeStory reads.', error);
    }
    if (error instanceof TimedOutError) {
      return new MergeStoryError('GIT_FAILED', 'git took too long to answer.', {
        hint: 'The repository may be on a slow or disconnected drive, or be extremely large. Try again.',
        cause: error,
      });
    }
    return error;
  }
}
