/**
 * Structured logger. Writes to stderr so stdout stays clean for `--json` results.
 * Every line passes through the redactor before it is written, and pretty lines are made safe
 * for a terminal (escape sequences in a commit message or PR title could otherwise rewrite the screen).
 */
import { globalRedactor, type Redactor } from './redact.ts';
import { terminalSafe } from './text.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
export type LogFormat = 'pretty' | 'json';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
  readonly level: LogLevel;
}

export interface LoggerOptions {
  level?: LogLevel;
  format?: LogFormat;
  redactor?: Redactor;
  /** Defaults to process.stderr. */
  write?: (line: string) => void;
  fields?: LogFields;
  color?: boolean;
}

const COLORS: Record<Exclude<LogLevel, 'silent'>, string> = {
  debug: '\u001b[90m',
  info: '\u001b[36m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
};
const RESET = '\u001b[0m';

function formatValue(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value.includes(' ') ? JSON.stringify(value) : value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const format = options.format ?? 'pretty';
  const redactor = options.redactor ?? globalRedactor;
  const write = options.write ?? ((line: string) => process.stderr.write(line + '\n'));
  const baseFields = options.fields ?? {};
  const color =
    options.color ?? (format === 'pretty' && Boolean(process.stderr.isTTY) && !process.env.NO_COLOR);

  function emit(lvl: Exclude<LogLevel, 'silent'>, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[lvl] < LEVEL_ORDER[level]) return;
    const all = { ...baseFields, ...(fields ?? {}) };
    if (format === 'json') {
      const record = redactor.redactValue({
        time: new Date().toISOString(),
        level: lvl,
        msg: message,
        ...all,
      });
      write(JSON.stringify(record));
      return;
    }
    const extras = Object.entries(all)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${formatValue(v)}`)
      .join(' ');
    const tag = lvl === 'info' ? '' : `${lvl}: `;
    const text = redactor.redact(terminalSafe(`${tag}${message}${extras ? `  ${extras}` : ''}`));
    write(color ? `${COLORS[lvl]}${text}${RESET}` : text);
  }

  return {
    level,
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger({ ...options, fields: { ...baseFields, ...fields } }),
  };
}

/** A logger that drops everything; handy for tests and library callers. */
export const silentLogger: Logger = createLogger({ level: 'silent' });
