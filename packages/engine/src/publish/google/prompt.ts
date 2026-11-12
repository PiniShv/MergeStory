/** Reading a secret from a terminal without showing it, and opening an address in the browser. */
import { MergeStoryError } from '../../core/errors.ts';
import { ghEnvironment } from '../../core/child-env.ts';
import { runCommand } from '../../core/process.ts';

/** The parts of a terminal input stream that hidden input needs (process.stdin has them all). */
export interface TerminalInput {
  isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
  setEncoding(encoding: BufferEncoding): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: 'data', listener: (chunk: string) => void): unknown;
  removeListener(event: 'data', listener: (chunk: string) => void): unknown;
}

export interface TerminalOutput {
  write(text: string): unknown;
}

const CTRL_C = '\u0003';
const CTRL_D = '\u0004';
const BACKSPACE = '\u007f';
const BACKSPACE_ALT = '\b';

/**
 * Ask a question and read the answer without echoing it. The terminal is put in raw mode, so the
 * typed characters never appear on screen or in the scrollback. Backspace works; Ctrl+C cancels.
 */
export function readHidden(
  question: string,
  input: TerminalInput,
  output: TerminalOutput,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const wasRaw = input.isRaw === true;
    let value = '';
    let ended = false;

    const finish = (done: () => void): void => {
      if (ended) return;
      ended = true;
      input.removeListener('data', onData);
      signal?.removeEventListener('abort', onAbort);
      input.setRawMode?.(wasRaw);
      input.pause();
      output.write('\n');
      done();
    };
    const cancelled = (): MergeStoryError => new MergeStoryError('ABORTED', 'The sign-in was cancelled.');
    const onAbort = (): void => finish(() => reject(cancelled()));
    const onData = (chunk: string): void => {
      // Arrow keys and other escape sequences arrive as one chunk that starts with ESC.
      if (chunk.startsWith('\u001b')) return;
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          finish(() => resolve(value.trim()));
          return;
        }
        if (char === CTRL_C) {
          finish(() => reject(cancelled()));
          return;
        }
        if (char === CTRL_D) {
          finish(() => (value ? resolve(value.trim()) : reject(cancelled())));
          return;
        }
        if (char === BACKSPACE || char === BACKSPACE_ALT) {
          value = value.slice(0, -1);
        } else if (char >= ' ') {
          value += char;
        }
      }
    };

    if (signal?.aborted) {
      reject(cancelled());
      return;
    }
    output.write(question);
    signal?.addEventListener('abort', onAbort, { once: true });
    input.setRawMode?.(true);
    input.setEncoding('utf8');
    input.on('data', onData);
    input.resume();
  });
}

type RunFn = (
  command: string,
  args: string[],
  options?: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
) => Promise<unknown>;

/**
 * Try to open an address in the default browser. Returns false when no launcher worked: that is
 * fine, the address is also printed. Only http(s) addresses are opened, and no shell is used.
 */
export async function openInBrowser(
  url: string,
  run: RunFn = runCommand,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return false;
  }
  if (protocol !== 'https:' && protocol !== 'http:') return false;
  const launcher: [string, string[]] =
    platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  try {
    // The browser it may start gets none of the keys or tokens of this process.
    await run(launcher[0], launcher[1], { timeoutMs: 10_000, env: ghEnvironment() });
    return true;
  } catch {
    return false;
  }
}
