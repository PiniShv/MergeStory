/** Typed errors with an actionable hint. The CLI prints `message` and `hint`; JSON output includes `code`. */

export type ErrorCode =
  | 'USAGE'
  | 'CONFIG_INVALID'
  | 'SOURCE_INVALID'
  | 'SOURCE_NOT_FOUND'
  | 'GIT_FAILED'
  | 'GITHUB_AUTH'
  | 'GITHUB_FAILED'
  | 'RATE_LIMITED'
  | 'LLM_FAILED'
  | 'LLM_REFUSED'
  | 'STORYBOARD_INVALID'
  | 'GROUNDING_FAILED'
  | 'BUDGET_EXCEEDED'
  | 'TTS_FAILED'
  | 'FFMPEG_NOT_FOUND'
  | 'BROWSER_NOT_FOUND'
  | 'RENDER_FAILED'
  | 'PUBLISH_FAILED'
  | 'PRIVACY_BLOCKED'
  | 'NOTIFY_FAILED'
  | 'JOB_NOT_FOUND'
  | 'ABORTED'
  | 'INTERNAL';

/** Process exit codes, so agents and CI can branch on the failure kind. */
export const EXIT_CODES: Record<ErrorCode, number> = {
  USAGE: 2,
  CONFIG_INVALID: 2,
  SOURCE_INVALID: 2,
  SOURCE_NOT_FOUND: 2,
  GIT_FAILED: 5,
  GITHUB_AUTH: 5,
  GITHUB_FAILED: 5,
  RATE_LIMITED: 5,
  LLM_FAILED: 5,
  LLM_REFUSED: 5,
  STORYBOARD_INVALID: 3,
  GROUNDING_FAILED: 3,
  BUDGET_EXCEEDED: 4,
  TTS_FAILED: 5,
  FFMPEG_NOT_FOUND: 6,
  BROWSER_NOT_FOUND: 6,
  RENDER_FAILED: 1,
  PUBLISH_FAILED: 5,
  PRIVACY_BLOCKED: 7,
  NOTIFY_FAILED: 5,
  JOB_NOT_FOUND: 2,
  ABORTED: 130,
  INTERNAL: 1,
};

export interface MergeStoryErrorOptions {
  hint?: string;
  cause?: unknown;
  /** Structured details safe to print (never secrets). */
  details?: Record<string, unknown>;
  /** true when retrying the same request may succeed (429, 5xx, network). */
  retryable?: boolean;
}

export class MergeStoryError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly details: Record<string, unknown> | undefined;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, options: MergeStoryErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'MergeStoryError';
    this.code = code;
    this.hint = options.hint;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }

  get exitCode(): number {
    return EXIT_CODES[this.code];
  }

  toJSON(): {
    code: ErrorCode;
    message: string;
    hint: string | null;
    details: Record<string, unknown> | null;
  } {
    return { code: this.code, message: this.message, hint: this.hint ?? null, details: this.details ?? null };
  }
}

export function isMergeStoryError(err: unknown): err is MergeStoryError {
  return err instanceof MergeStoryError;
}

/** A command or request that did not finish within its time limit. */
export class TimedOutError extends MergeStoryError {
  constructor(message: string, options: MergeStoryErrorOptions = {}) {
    super('INTERNAL', message, options);
    this.name = 'TimedOutError';
  }
}

/** A program that is not installed, or not on the PATH. */
export class CommandNotFoundError extends MergeStoryError {
  constructor(command: string, options: MergeStoryErrorOptions = {}) {
    super('INTERNAL', `Command not found: ${command}`, options);
    this.name = 'CommandNotFoundError';
  }
}

/** A program that printed more than the caller was willing to read. */
export class OutputTooLargeError extends MergeStoryError {
  constructor(command: string, maxBytes: number, options: MergeStoryErrorOptions = {}) {
    super('INTERNAL', `${command} produced more than ${maxBytes} bytes of output`, options);
    this.name = 'OutputTooLargeError';
  }
}

/** The error for a cancelled run. `cause` is what stopped it, when that is known. */
export function abortedError(cause?: unknown): MergeStoryError {
  return new MergeStoryError('ABORTED', 'The run was cancelled.', { cause });
}

/** Stop here when the run was cancelled. */
export function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortedError();
}

/** The message and its hint as one sentence, for a warning. */
export function describeProblem(problem: MergeStoryError): string {
  return problem.hint ? `${problem.message} ${problem.hint}` : problem.message;
}

/** Wrap any thrown value as a MergeStoryError, keeping the original as `cause`. */
export function toMergeStoryError(err: unknown, fallback: ErrorCode = 'INTERNAL'): MergeStoryError {
  if (err instanceof MergeStoryError) return err;
  if (err instanceof Error && err.name === 'AbortError') return abortedError(err);
  const message = err instanceof Error ? err.message : String(err);
  return new MergeStoryError(fallback, message, { cause: err });
}
