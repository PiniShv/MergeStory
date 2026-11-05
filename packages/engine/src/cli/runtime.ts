/** Per-run state shared by the commands: output channels, logger, exit code and cancellation. */
import { type Command, CommanderError } from 'commander';
import { isMergeStoryError, toMergeStoryError } from '../core/errors.ts';
import { createLogger, type LogFormat, type Logger, type LogLevel } from '../core/logger.ts';
import { globalRedactor } from '../core/redact.ts';
import type { ErrorView } from './format.ts';
import type { CliIo } from './io.ts';
import { colorEnabled, createStyle, type Style } from './style.ts';

/** Hint shown with every usage error. */
export const USAGE_HINT = 'Run mergestory --help, or add --help to a command, to see the options.';

/** The global options. */
export interface Globals {
  json: boolean;
  quiet: boolean;
  logLevel: LogLevel | undefined;
  logFormat: LogFormat | undefined;
  config: string | undefined;
}

/** What a command needs while it runs. */
export interface CommandEnv {
  readonly io: CliIo;
  readonly json: boolean;
  readonly configPath: string | null;
  readonly logger: Logger;
  readonly style: Style;
  readonly signal: AbortSignal;
  readonly debug: boolean;
  /** Human output on stdout. Dropped in --json mode, where stdout carries one JSON document only. */
  say(text: string): void;
  /** The JSON document of --json mode. */
  emitJson(value: unknown): void;
  /** Set the process exit code without throwing (for example "validation found errors"). */
  setExitCode(code: number): void;
}

/** State shared by the commands of one run. */
export class CliRuntime {
  readonly io: CliIo;
  readonly signal: AbortSignal;
  exitCode = 0;
  /** The environment of the command that ran last, used when reporting a failure. */
  current: CommandEnv | null = null;

  constructor(io: CliIo, signal: AbortSignal) {
    this.io = io;
    this.signal = signal;
  }

  env(command: Command): CommandEnv {
    const globals = command.optsWithGlobals() as Partial<Globals>;
    const json = globals.json === true;
    const level: LogLevel = globals.logLevel ?? (globals.quiet ? 'error' : 'info');
    const format: LogFormat = globals.logFormat ?? 'pretty';
    const logger = createLogger({
      level,
      format,
      write: (line) => this.io.stderr(`${line}\n`),
      color: format === 'pretty' && colorEnabled(this.io.stderrIsTty, this.io.env),
    });
    const io = this.io;
    const env: CommandEnv = {
      io,
      json,
      configPath: globals.config ?? null,
      logger,
      style: createStyle(!json && colorEnabled(io.stdoutIsTty, io.env)),
      signal: this.signal,
      debug: level === 'debug',
      say: (text) => {
        if (!json) io.stdout(text.endsWith('\n') ? text : `${text}\n`);
      },
      emitJson: (value) => io.stdout(`${JSON.stringify(value)}\n`),
      setExitCode: (code) => {
        this.exitCode = code;
      },
    };
    this.current = env;
    return env;
  }
}

/** An error ready to print: redacted, with its exit code. */
export interface ErrorReport extends ErrorView {
  details: Record<string, unknown> | null;
  stack: string | null;
}

/** Turn anything that was thrown into a printable, redacted error. */
export function describeError(err: unknown): ErrorReport {
  if (err instanceof CommanderError) {
    return {
      code: 'USAGE',
      message: globalRedactor.redact(err.message.replace(/^error:\s*/i, '').trim()),
      hint: USAGE_HINT,
      exitCode: 2,
      details: null,
      stack: null,
    };
  }
  const error = toMergeStoryError(err);
  const hint = error.hint ?? (isMergeStoryError(err) ? null : 'Re-run with --log-level debug for details.');
  return {
    code: error.code,
    message: globalRedactor.redact(error.message),
    hint: hint ? globalRedactor.redact(hint) : null,
    exitCode: error.exitCode,
    details: error.details ? globalRedactor.redactValue(error.details) : null,
    stack:
      !isMergeStoryError(err) && err instanceof Error && err.stack ? globalRedactor.redact(err.stack) : null,
  };
}

/** The JSON form of an error, printed on stdout in --json mode. */
export function errorEnvelope(report: ErrorReport): {
  ok: false;
  error: { code: string; message: string; hint: string | null; details: Record<string, unknown> | null };
} {
  return {
    ok: false,
    error: { code: report.code, message: report.message, hint: report.hint, details: report.details },
  };
}
