/** Starts a detached background process that runs one job. */
import { spawn } from 'node:child_process';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MergeStoryError } from '../core/errors.ts';
import { assertJobId } from './store.ts';

/**
 * Path of the CLI entry point next to this module: main.ts when running from source (Node runs
 * TypeScript directly) and main.js from the built package.
 */
export function cliEntryPath(): string {
  const here = fileURLToPath(import.meta.url);
  return join(dirname(here), '..', 'cli', `main${extname(here)}`);
}

/** Options of `startDetachedWorker`. */
export interface StartWorkerOptions {
  /** MergeStory home the worker must use, so it finds the same job file. */
  home?: string | null;
  /** Defaults to the CLI entry next to this module. */
  entry?: string;
  execPath?: string;
  /** Defaults to the current environment, which is how the worker gets its API keys. */
  env?: NodeJS.ProcessEnv;
  /** For tests. */
  spawnFn?: typeof spawn;
}

/**
 * Start `mergestory worker <jobId>` detached from this process and return its process id.
 * Secrets are never passed on the command line: the worker inherits the environment.
 */
export async function startDetachedWorker(
  jobId: string,
  options: StartWorkerOptions = {},
): Promise<number | undefined> {
  assertJobId(jobId);
  const entry = options.entry ?? cliEntryPath();
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  if (options.home) env.MERGESTORY_HOME = options.home;
  // A TypeScript entry needs the flags that let this process run TypeScript.
  const execArgv = entry.endsWith('.ts') ? process.execArgv : [];
  const spawnFn = options.spawnFn ?? spawn;
  return new Promise((resolve, reject) => {
    const child = spawnFn(options.execPath ?? process.execPath, [...execArgv, entry, 'worker', jobId], {
      detached: true,
      stdio: 'ignore',
      env,
      windowsHide: true,
    });
    child.once('error', (err) => {
      reject(
        new MergeStoryError('INTERNAL', `Could not start the background worker: ${err.message}`, {
          cause: err,
          hint: `Run it in the foreground instead: mergestory worker ${jobId}`,
        }),
      );
    });
    child.once('spawn', () => {
      child.unref();
      resolve(child.pid);
    });
  });
}
