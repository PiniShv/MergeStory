/**
 * Child-process helpers. Commands always run without a shell and with an argument array,
 * so branch names, paths and refs can never be interpreted as shell syntax.
 */
import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { CommandNotFoundError, MergeStoryError, OutputTooLargeError, TimedOutError } from './errors.ts';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Data written to stdin, then stdin is closed. */
  input?: string | Buffer;
  timeoutMs?: number;
  /** Max bytes kept from stdout (default 64 MiB). */
  maxOutputBytes?: number;
  signal?: AbortSignal;
  /** Resolve instead of throwing on a non-zero exit code. */
  allowFailure?: boolean;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  stdoutBuffer: Buffer;
}

export function runCommand(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const maxBytes = options.maxOutputBytes ?? 64 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      signal: options.signal,
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let overflowed = false;
    let timer: NodeJS.Timeout | undefined;
    if (options.timeoutMs) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new TimedOutError(`${command} timed out after ${options.timeoutMs} ms`));
      }, options.timeoutMs);
    }
    child.stdout.on('data', (chunk: Buffer) => {
      if (overflowed) return;
      if (outBytes + chunk.length > maxBytes) {
        // The answer is known to be an error, so stop the child now instead of letting it finish.
        overflowed = true;
        if (timer) clearTimeout(timer);
        child.kill('SIGKILL');
        reject(new OutputTooLargeError(command, maxBytes));
        return;
      }
      outBytes += chunk.length;
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (errBytes < 1024 * 1024) {
        errBytes += chunk.length;
        err.push(chunk);
      }
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      if (e.code === 'ENOENT') {
        reject(new CommandNotFoundError(command, { cause: e }));
      } else {
        reject(e);
      }
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const stdoutBuffer = Buffer.concat(out);
      const result: RunResult = {
        code: code ?? -1,
        stdout: stdoutBuffer.toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        stdoutBuffer,
      };
      if (overflowed) return;
      if (result.code !== 0 && !options.allowFailure) {
        const firstLine = result.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400);
        reject(new MergeStoryError('INTERNAL', `${command} exited with code ${result.code}: ${firstLine}`));
      } else {
        resolve(result);
      }
    });
    // A child that exits before it has read its input breaks the pipe. The close handler reports
    // that as the exit code; without a listener the write error would be an uncaught exception.
    child.stdin.on('error', () => undefined);
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

/** Find an executable on PATH without spawning `which`. Returns an absolute path or null. */
export async function which(command: string): Promise<string | null> {
  if (command.includes('/') || command.includes('\\')) {
    return (await isExecutable(command)) ? command : null;
  }
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

export async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
