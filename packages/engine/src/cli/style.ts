/** Minimal terminal styling. Plain text when color is off (pipes, NO_COLOR, --json). */

export interface Style {
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
}

function wrap(open: number, close: number): (text: string) => string {
  return (text) => `\u001b[${open}m${text}\u001b[${close}m`;
}

const plain = (text: string): string => text;

/** Styling functions, or plain text when `enabled` is false. */
export function createStyle(enabled: boolean): Style {
  if (!enabled) return { bold: plain, dim: plain, red: plain, green: plain, yellow: plain, cyan: plain };
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    cyan: wrap(36, 39),
  };
}

/** Color only on a terminal, and never when NO_COLOR is set (https://no-color.org). */
export function colorEnabled(isTty: boolean, env: NodeJS.ProcessEnv): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0') return true;
  return isTty && env.TERM !== 'dumb';
}
