import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cliEntryPath, startDetachedWorker } from './worker.ts';

class FakeChild extends EventEmitter {
  pid = 4321;
  unref = vi.fn();
}

function fakeSpawn(outcome: 'spawn' | 'error') {
  const child = new FakeChild();
  const fn = vi.fn((..._args: unknown[]) => {
    queueMicrotask(() => {
      if (outcome === 'spawn') child.emit('spawn');
      else child.emit('error', new Error('spawn ENOENT'));
    });
    return child;
  });
  return { fn: fn as unknown as typeof spawn, calls: fn.mock.calls, child };
}

const ID = '20261103-214501-a3f9';

describe('startDetachedWorker', () => {
  it('starts a detached worker for the job and lets go of it', async () => {
    const { fn, calls, child } = fakeSpawn('spawn');
    const pid = await startDetachedWorker(ID, {
      spawnFn: fn,
      entry: '/pkg/dist/cli/main.js',
      execPath: '/usr/bin/node',
      env: { PATH: '/bin', ANTHROPIC_API_KEY: 'from-environment' },
    });
    expect(pid).toBe(4321);
    expect(child.unref).toHaveBeenCalled();
    const [command, args, options] = calls[0] as [string, string[], Record<string, unknown>];
    expect(command).toBe('/usr/bin/node');
    expect(args).toEqual(['/pkg/dist/cli/main.js', 'worker', ID]);
    expect(options.detached).toBe(true);
    expect(options.stdio).toBe('ignore');
  });

  it('passes secrets through the environment, never on the command line', async () => {
    const { fn, calls } = fakeSpawn('spawn');
    await startDetachedWorker(ID, {
      spawnFn: fn,
      entry: '/pkg/dist/cli/main.js',
      env: { ANTHROPIC_API_KEY: 'secret-value-123' },
      home: '/data/mergestory',
    });
    const [, args, options] = calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(args.join(' ')).not.toContain('secret-value-123');
    expect(options.env.ANTHROPIC_API_KEY).toBe('secret-value-123');
    expect(options.env.MERGESTORY_HOME).toBe('/data/mergestory');
  });

  it('leaves the home alone when none is given', async () => {
    const { fn, calls } = fakeSpawn('spawn');
    await startDetachedWorker(ID, { spawnFn: fn, entry: '/x/main.js', env: { PATH: '/bin' } });
    const [, , options] = calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(options.env.MERGESTORY_HOME).toBeUndefined();
  });

  it('passes the runtime flags along only for a TypeScript entry', async () => {
    const ts = fakeSpawn('spawn');
    await startDetachedWorker(ID, { spawnFn: ts.fn, entry: '/src/cli/main.ts', env: {} });
    const tsArgs = ts.calls[0]?.[1] as string[];
    expect(tsArgs.slice(-3)).toEqual(['/src/cli/main.ts', 'worker', ID]);

    const js = fakeSpawn('spawn');
    await startDetachedWorker(ID, { spawnFn: js.fn, entry: '/dist/cli/main.js', env: {} });
    expect(js.calls[0]?.[1]).toEqual(['/dist/cli/main.js', 'worker', ID]);
  });

  it('rejects a bad job id before starting anything', async () => {
    const { fn } = fakeSpawn('spawn');
    await expect(startDetachedWorker('../x; rm -rf /', { spawnFn: fn })).rejects.toMatchObject({
      code: 'JOB_NOT_FOUND',
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it('turns a spawn failure into an actionable error', async () => {
    const { fn } = fakeSpawn('error');
    const error = await startDetachedWorker(ID, { spawnFn: fn, entry: '/x/main.js' }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: 'INTERNAL' });
    expect((error as { hint: string }).hint).toContain(`mergestory worker ${ID}`);
  });
});

describe('cliEntryPath', () => {
  it('points at the CLI entry next to the jobs module', () => {
    const entry = cliEntryPath();
    expect(entry.endsWith(join('cli', 'main.ts')) || entry.endsWith(join('cli', 'main.js'))).toBe(true);
  });
});
