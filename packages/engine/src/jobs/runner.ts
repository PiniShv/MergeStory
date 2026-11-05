/** Starting, running and waiting for jobs. Used by the CLI, the background worker and the HTTP API. */
import { abortedError, MergeStoryError, toMergeStoryError } from '../core/errors.ts';
import type { Logger } from '../core/logger.ts';
import { homeLayout } from '../core/paths.ts';
import { sleep } from '../core/retry.ts';
import type { ProgressEvent } from '../core/types.ts';
import type { GenerateOptions } from '../pipeline/index.ts';
import { isTerminal, type Job, type JobOptions, type JobProgress } from './model.ts';
import { JobStore } from './store.ts';
import { redactResult, redactText } from './view.ts';
import { startDetachedWorker } from './worker.ts';

/** The store under $MERGESTORY_HOME (or the given home). */
export function defaultJobStore(home?: string | null): JobStore {
  return new JobStore(homeLayout(home).jobs);
}

/** Options of `runJob`. */
export interface RunJobOptions {
  store?: JobStore;
  /** Used when no store is given. */
  home?: string | null;
  signal?: AbortSignal;
  logger?: Logger;
}

/** At most one progress write per interval, so rendering does not rewrite the job file all the time. */
const PROGRESS_INTERVAL_MS = 500;

function toJobProgress(event: ProgressEvent): JobProgress {
  const progress =
    typeof event.progress === 'number' && Number.isFinite(event.progress)
      ? Math.max(0, Math.min(1, event.progress))
      : event.status === 'done'
        ? 1
        : null;
  return { stage: event.stage, message: redactText(event.message).slice(0, 300), progress };
}

/** Writes progress to the job file without ever failing the job. */
class ProgressWriter {
  private readonly store: JobStore;
  private readonly jobId: string;
  private readonly logger: Logger | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private lastWrite = 0;
  private pending: JobProgress | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(store: JobStore, jobId: string, logger: Logger | undefined) {
    this.store = store;
    this.jobId = jobId;
    this.logger = logger;
  }

  push(event: ProgressEvent): void {
    const progress = toJobProgress(event);
    const wait = PROGRESS_INTERVAL_MS - (Date.now() - this.lastWrite);
    if (event.status === 'progress' && wait > 0) {
      this.pending = progress;
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null;
          if (this.pending) this.write(this.pending);
        }, wait);
        this.timer.unref();
      }
      return;
    }
    this.write(progress);
  }

  private write(progress: JobProgress): void {
    this.lastWrite = Date.now();
    this.pending = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.chain = this.chain
      .then(() =>
        this.store.update(this.jobId, (job) => {
          if (job.status === 'running') job.progress = progress;
        }),
      )
      .catch((err: unknown) => {
        this.logger?.debug('Could not write job progress', { jobId: this.jobId, error: String(err) });
      });
  }

  /** Wait for writes in flight and drop any update still waiting for its turn. */
  async settle(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    await this.chain;
  }
}

/**
 * Run one queued job to the end and record the outcome in its file. Generation errors are stored
 * on the job, not thrown; only a job that cannot be started (missing, or not queued) throws.
 */
export async function runJob(jobId: string, options: RunJobOptions = {}): Promise<Job> {
  const store = options.store ?? defaultJobStore(options.home);
  const job = await store.update(jobId, (queued) => {
    if (queued.status !== 'queued') {
      throw new MergeStoryError('USAGE', `Job ${jobId} is already ${queued.status}.`, {
        hint: 'Only a queued job can be started. Create a new one with: mergestory generate --async',
      });
    }
    queued.status = 'running';
    queued.pid = process.pid;
    queued.startedAt = new Date().toISOString();
    queued.progress = { stage: 'source', message: 'Starting', progress: 0 };
  });
  const writer = new ProgressWriter(store, jobId, options.logger);
  try {
    // Loaded here so that commands that only read jobs stay fast to start.
    const { generate } = await import('../pipeline/index.ts');
    const generateOptions: GenerateOptions = {
      ...job.options,
      runId: job.options.runId ?? job.id,
      signal: options.signal,
      logger: options.logger,
    };
    const result = await generate(generateOptions, { onProgress: (event) => writer.push(event) });
    await writer.settle();
    return await store.update(jobId, (current) => {
      current.status = 'succeeded';
      current.finishedAt = new Date().toISOString();
      current.result = redactResult(result);
      current.error = null;
      current.progress = { stage: current.progress.stage, message: 'Finished', progress: 1 };
    });
  } catch (err) {
    await writer.settle();
    const failure = options.signal?.aborted ? abortedError(err) : toMergeStoryError(err);
    options.logger?.debug('Job failed', { jobId, code: failure.code });
    return await store.fail(jobId, failure);
  }
}

/** Options of `startBackgroundJob`. */
export interface StartBackgroundJobOptions {
  store?: JobStore;
  /** Used when no store is given. It is also the home the worker uses, so that it finds the job file. */
  home?: string | null;
  /** Defaults to the current environment, which is how the worker gets its API keys. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Create a job and start a detached worker for it. The job file holds no secrets: the worker reads
 * them from its environment. A worker that cannot be started fails the job, and the error is thrown.
 */
export async function startBackgroundJob(
  options: JobOptions,
  settings: StartBackgroundJobOptions = {},
): Promise<Job> {
  const store = settings.store ?? defaultJobStore(settings.home);
  const job = await store.create(options);
  try {
    const pid = await startDetachedWorker(job.id, { home: settings.home, env: settings.env });
    // Remember the worker, so that a worker that dies at startup is noticed instead of waited for.
    if (pid !== undefined) await store.setWorkerPid(job.id, pid);
  } catch (err) {
    await store.fail(job.id, toMergeStoryError(err)).catch(() => undefined);
    throw err;
  }
  return job;
}

/** Options of `waitForJob`. */
export interface WaitForJobOptions {
  store?: JobStore;
  home?: string | null;
  /** First polling interval in milliseconds; it grows to two seconds. */
  pollMs?: number;
  signal?: AbortSignal;
  /** Called with the first state seen and again whenever the status or progress changes. */
  onUpdate?: (job: Job) => void;
}

/** Poll a job until it succeeds or fails. Throws when `timeoutMs` passes first. */
export async function waitForJob(
  jobId: string,
  timeoutMs: number,
  options: WaitForJobOptions = {},
): Promise<Job> {
  const store = options.store ?? defaultJobStore(options.home);
  const deadline = Date.now() + timeoutMs;
  let delay = options.pollMs ?? 400;
  let seen = '';
  for (;;) {
    const job = await store.get(jobId);
    const key = [job.status, job.progress.stage, job.progress.progress, job.progress.message].join('|');
    if (key !== seen) {
      seen = key;
      options.onUpdate?.(job);
    }
    if (isTerminal(job.status)) return job;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new MergeStoryError(
        'INTERNAL',
        `Job ${jobId} is still ${job.status} after ${Math.round(timeoutMs / 1000)} seconds.`,
        { hint: `It keeps running in the background. Check again with: mergestory status ${jobId} --wait` },
      );
    }
    await sleep(Math.min(delay, remaining), options.signal);
    delay = Math.min(Math.round(delay * 1.5), 2000);
  }
}
