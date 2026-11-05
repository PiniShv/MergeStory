/**
 * Running git for the local source.
 *
 * Every command runs without a shell, with an argument array, and in a clean environment:
 * variables that could point git at another repository are removed, optional locks are off (so
 * git never refreshes the index of the repository being read), and configuration that changes
 * output format or runs programs (pager, external diff, file system monitor) is overridden.
 */
import { gitEnvironment } from '../core/child-env.ts';
import { Semaphore } from '../core/concurrency.ts';
import type { RunContext } from '../core/context.ts';
import { CommandNotFoundError, MergeStoryError, OutputTooLargeError, TimedOutError } from '../core/errors.ts';
import { type RunResult, runCommand } from '../core/process.ts';

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

export class GitRunner {
  readonly cwd: string;
  private readonly ctx: RunContext;
  private readonly limiter = new Semaphore(MAX_PARALLEL_GIT);

  constructor(cwd: string, ctx: RunContext) {
    this.cwd = cwd;
    this.ctx = ctx;
  }

  /** Run git. A non-zero exit code is returned, not thrown. */
  async run(args: string[], options: GitRunOptions = {}): Promise<RunResult> {
    const full = [
      '--no-pager',
      ...(options.literalPathspecs ? ['--literal-pathspecs'] : []),
      ...BASE_CONFIG,
      ...args,
    ];
    try {
      return await this.limiter.run(() =>
        runCommand('git', full, {
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
