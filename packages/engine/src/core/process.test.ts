import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandNotFoundError, MergeStoryError, OutputTooLargeError, TimedOutError } from './errors.ts';
import { findProgram, runCommand } from './process.ts';

/** Larger than a pipe holds, so the write is still going when the child exits. */
const BIG_INPUT = Buffer.alloc(5 * 1024 * 1024, 'x');

/** Errors that reached the process as uncaught exceptions while a test ran. */
let uncaught: unknown[] = [];
const collect = (err: unknown): void => {
  uncaught.push(err);
};

beforeEach(() => {
  uncaught = [];
  process.on('uncaughtException', collect);
});

afterEach(() => {
  process.off('uncaughtException', collect);
});

/** Lets a write error that is still on its way surface. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('runCommand input', () => {
  it('passes all of the input on to a child that reads it', async () => {
    const script =
      "let n = 0; process.stdin.on('data', (c) => { n += c.length; }).on('end', () => console.log(n));";
    const result = await runCommand(process.execPath, ['-e', script], { input: BIG_INPUT });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(String(BIG_INPUT.length));
  });
});

describe('runCommand with a child that exits before it reads its input', () => {
  const exitAtOnce = ['-e', 'process.exit(3)'];

  it('returns the exit code when failures are allowed', async () => {
    const result = await runCommand(process.execPath, exitAtOnce, { input: BIG_INPUT, allowFailure: true });
    expect(result.code).toBe(3);
    await settle();
    expect(uncaught).toEqual([]);
  });

  it('rejects with the exit code otherwise', async () => {
    const error = await runCommand(process.execPath, exitAtOnce, { input: BIG_INPUT }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(MergeStoryError);
    expect((error as MergeStoryError).message).toContain('exited with code 3');
    await settle();
    expect(uncaught).toEqual([]);
  });
});

describe('runCommand failures', () => {
  const rejection = (command: string, args: string[], options = {}) =>
    runCommand(command, args, options).catch((e: unknown) => e);

  it('reports a program that is not there as CommandNotFoundError', async () => {
    const error = await rejection('mergestory-no-such-program', []);
    expect(error).toBeInstanceOf(CommandNotFoundError);
    expect((error as Error).message).toBe('Command not found: mergestory-no-such-program');
    expect(((error as Error).cause as NodeJS.ErrnoException).code).toBe('ENOENT');
  });

  it('reports a program that runs too long as TimedOutError', async () => {
    const error = await rejection(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
      timeoutMs: 100,
    });
    expect(error).toBeInstanceOf(TimedOutError);
    expect((error as Error).message).toContain('timed out after 100 ms');
  });

  it('reports output over the limit as OutputTooLargeError', async () => {
    const error = await rejection(process.execPath, ['-e', "process.stdout.write('x'.repeat(5000))"], {
      maxOutputBytes: 1000,
    });
    expect(error).toBeInstanceOf(OutputTooLargeError);
    expect((error as Error).message).toContain('produced more than 1000 bytes of output');
  });

  it('stops a program as soon as its output is over the limit', async () => {
    const started = Date.now();
    const error = await rejection(
      process.execPath,
      ['-e', "process.stdout.write('x'.repeat(5000)); setTimeout(() => {}, 10000)"],
      { maxOutputBytes: 1000 },
    );
    expect(error).toBeInstanceOf(OutputTooLargeError);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('keeps a plain MergeStoryError for a program that exits with an error', async () => {
    const error = await rejection(process.execPath, ['-e', 'process.exit(2)']);
    expect(error).toBeInstanceOf(MergeStoryError);
    expect(error).not.toBeInstanceOf(TimedOutError);
    expect(error).not.toBeInstanceOf(CommandNotFoundError);
    expect(error).not.toBeInstanceOf(OutputTooLargeError);
  });
});

describe('findProgram', () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'mergestory-find-')));
    for (const folder of ['bin', 'repo', 'cwd']) {
      await mkdir(join(root, folder));
      await writeFile(join(root, folder, 'tool'), '#!/bin/sh\n', { mode: 0o755 });
    }
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it('returns the absolute path of a program on PATH', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(join(root, 'cwd'));
    vi.stubEnv('PATH', join(root, 'bin'));
    expect(await findProgram('tool', [join(root, 'repo')])).toBe(join(root, 'bin', 'tool'));
  });

  it('refuses a program inside the repository being explained', async () => {
    vi.stubEnv('PATH', join(root, 'repo'));
    await expect(findProgram('tool', [join(root, 'repo')])).rejects.toMatchObject({ code: 'USAGE' });
    await expect(findProgram('tool', [join(root, 'repo')])).rejects.toThrow('tool was found inside');
  });

  it('accepts a program below the current folder when that folder is not the repository', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    vi.stubEnv('PATH', join(root, 'bin'));
    expect(await findProgram('tool', [join(root, 'repo')])).toBe(join(root, 'bin', 'tool'));
  });

  it('never takes a program from a PATH entry that is not absolute', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(join(root, 'cwd'));
    vi.stubEnv('PATH', ['.', '', join('..', 'cwd')].join(delimiter));
    await expect(findProgram('tool')).rejects.toBeInstanceOf(CommandNotFoundError);
  });

  it('throws CommandNotFoundError when the program is missing', async () => {
    vi.stubEnv('PATH', join(root, 'bin'));
    await expect(findProgram('no-such-tool')).rejects.toBeInstanceOf(CommandNotFoundError);
  });
});
