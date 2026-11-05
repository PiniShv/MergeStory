import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandNotFoundError, MergeStoryError, OutputTooLargeError, TimedOutError } from './errors.ts';
import { runCommand } from './process.ts';

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
