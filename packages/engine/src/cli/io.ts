/** Where the CLI reads and writes. Tests replace all of it. */

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdoutIsTty: boolean;
  stderrIsTty: boolean;
  /** Turn SIGINT and SIGTERM into a graceful cancel. Off in tests. */
  handleSignals: boolean;
}

/** The color sequences of style.ts, and every other control character except tab and line feed. */
const OUTPUT_CONTROLS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape character starts the color sequences kept here
  /(\u001b\[[0-9;]*m)|(?![\t\n])\p{Cc}/gu;

/**
 * Text as it may reach the terminal: the color sequences the CLI writes itself stay, every other
 * control character is dropped. The formatters and the logger already clean the text they print;
 * this catches anything that reaches the output another way.
 */
export function safeOutput(text: string): string {
  return text.replace(OUTPUT_CONTROLS, (_match, color: string | undefined) => color ?? '');
}

/** The real terminal, with any part replaced by `overrides`. */
export function createIo(overrides: Partial<CliIo> = {}): CliIo {
  return {
    stdout: (text) => {
      process.stdout.write(safeOutput(text));
    },
    stderr: (text) => {
      process.stderr.write(safeOutput(text));
    },
    env: process.env,
    cwd: process.cwd(),
    stdoutIsTty: Boolean(process.stdout.isTTY),
    stderrIsTty: Boolean(process.stderr.isTTY),
    handleSignals: true,
    ...overrides,
  };
}
