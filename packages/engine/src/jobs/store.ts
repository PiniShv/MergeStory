/**
 * File-based job store: $MERGESTORY_HOME/jobs/<jobId>/job.json.
 *
 * Directories are 0700 and files 0600. Every write goes to a temporary file first and is renamed
 * into place, so a reader never sees a half-written job. Job files never hold secrets: workers
 * get them from their environment.
 */
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MergeStoryError } from '../core/errors.ts';
import { newRunId, RUN_ID_PATTERN, randomToken } from '../core/ids.ts';
import { isRecord } from '../core/json.ts';
import { ensureDir } from '../core/paths.ts';
import { globalRedactor } from '../core/redact.ts';
import { canTransition, isTerminal, JOB_STATUSES, type Job, type JobOptions } from './model.ts';

/** true for a well-formed job id. Job ids look like run ids, for example "20261103-214501-a3f9". */
export function isValidJobId(value: unknown): value is string {
  return typeof value === 'string' && RUN_ID_PATTERN.test(value);
}

/** Throws JOB_NOT_FOUND for anything that is not a well-formed job id, before any file is touched. */
export function assertJobId(value: unknown): asserts value is string {
  if (isValidJobId(value)) return;
  const shown = typeof value === 'string' ? value.replace(/[^\x20-\x7e]/g, '?').slice(0, 40) : typeof value;
  throw new MergeStoryError('JOB_NOT_FOUND', `"${shown}" is not a valid job id.`, {
    hint: 'Job ids look like 20261103-214501-a3f9. List recent jobs with: mergestory jobs',
  });
}

function isJob(value: unknown): value is Job {
  if (!isRecord(value) || value.version !== 1) return false;
  if (!isValidJobId(value.id)) return false;
  if (!JOB_STATUSES.includes(value.status as Job['status'])) return false;
  if (typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') return false;
  if (!isRecord(value.options)) return false;
  const progress = value.progress;
  return isRecord(progress) && typeof progress.stage === 'string' && typeof progress.message === 'string';
}

/** true when a process with this id exists (it may belong to another user). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The longest message and hint a failed job keeps. */
const MAX_ERROR_MESSAGE = 2000;
const MAX_ERROR_HINT = 1000;

/** The failure recorded for a job whose owning process ended before the job did. */
function ownerEnded(): MergeStoryError {
  return new MergeStoryError('INTERNAL', 'The worker process ended before the job finished.', {
    hint: 'Run the command again. Add --log-level debug to see more.',
  });
}

/** Options of `JobStore.create`. */
export interface CreateJobOptions {
  /** Process that owns the job. `get` fails the job when that process has died. */
  pid?: number | null;
  /** When the job is created. Tests set it to get ids in a known order. */
  now?: Date;
}

/** Jobs on disk under one directory. */
export class JobStore {
  readonly root: string;
  /** Serialises read-modify-write cycles per job inside this process. */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(root: string) {
    this.root = root;
  }

  jobDir(id: string): string {
    assertJobId(id);
    return join(this.root, id);
  }

  private file(id: string): string {
    return join(this.jobDir(id), 'job.json');
  }

  /**
   * Create a queued job. The options are redacted once more on the way in, as a last safety net.
   * A caller that already owns the job, such as the server that queues it, passes its `pid`.
   */
  async create(options: JobOptions, { pid = null, now = new Date() }: CreateJobOptions = {}): Promise<Job> {
    await ensureDir(this.root);
    await this.tightenRoot();
    const safeOptions = globalRedactor.redactValue(JSON.parse(JSON.stringify(options)) as JobOptions);
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = newRunId(now);
      try {
        // Not recursive: an existing directory means the id is taken.
        await mkdir(join(this.root, id), { mode: 0o700 });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw err;
      }
      const stamp = now.toISOString();
      const job: Job = {
        version: 1,
        id,
        status: 'queued',
        createdAt: stamp,
        updatedAt: stamp,
        startedAt: null,
        finishedAt: null,
        pid,
        options: safeOptions,
        progress: { stage: 'queued', message: 'Waiting to start', progress: 0 },
        result: null,
        error: null,
      };
      await this.write(job);
      return job;
    }
    throw new MergeStoryError('INTERNAL', 'Could not allocate a job id.', {
      hint: 'Try again in a moment.',
    });
  }

  /** Read a job as stored. Throws JOB_NOT_FOUND when it does not exist. */
  async read(id: string): Promise<Job> {
    const file = this.file(id);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new MergeStoryError('JOB_NOT_FOUND', `No job with id ${id}.`, {
          hint: 'List recent jobs with: mergestory jobs',
        });
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new MergeStoryError('INTERNAL', `The file for job ${id} is damaged.`, { cause: err });
    }
    if (!isJob(parsed)) throw new MergeStoryError('INTERNAL', `The file for job ${id} is damaged.`);
    return parsed;
  }

  /**
   * Read a job and, when the process that owns it has died without finishing the job, record that
   * as a failure so nobody waits for it forever. A job has an owner once the server has queued it
   * or a background worker has been started for it.
   */
  async get(id: string): Promise<Job> {
    const job = await this.read(id);
    if (isTerminal(job.status)) return job;
    const owner = job.pid ?? (await this.readWorkerPid(id));
    if (owner === null || isProcessAlive(owner)) return job;
    return this.fail(id, ownerEnded());
  }

  /**
   * Remember the worker that was started for a queued job. It goes in its own file, so that it
   * cannot overwrite a change that the worker makes to the job file while it starts. The worker
   * records its own pid in the job file once it runs; this one covers a worker that dies first.
   */
  async setWorkerPid(id: string, pid: number): Promise<void> {
    await writeFile(join(this.jobDir(id), 'worker.pid'), `${pid}\n`, { mode: 0o600 });
  }

  private async readWorkerPid(id: string): Promise<number | null> {
    try {
      const pid = Number.parseInt(await readFile(join(this.jobDir(id), 'worker.pid'), 'utf8'), 10);
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  /**
   * Fail the unfinished jobs recorded under `pid` that were created before `createdBefore`. A
   * process that started at `createdBefore` cannot own them, so they were left by an earlier
   * process that had the same pid, for example a server that runs as process 1 in a container and
   * was restarted. `get` cannot tell, because that pid is alive again. Returns how many it failed.
   */
  async failOrphans(pid: number, createdBefore: Date): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw err;
    }
    let failed = 0;
    for (const id of names.filter(isValidJobId)) {
      try {
        const job = await this.read(id);
        if (isTerminal(job.status) || job.pid !== pid) continue;
        if (Date.parse(job.createdAt) >= createdBefore.getTime()) continue;
        await this.fail(id, ownerEnded());
        failed++;
      } catch {
        // A damaged or removed job must not stop the others.
      }
    }
    return failed;
  }

  /**
   * Record that a job failed. A job that has already finished is left as it is. The message and
   * the hint are redacted first and cut afterwards, so a secret at the cut is still removed.
   */
  async fail(id: string, error: MergeStoryError): Promise<Job> {
    return this.change(id, (job) => {
      if (isTerminal(job.status)) return false;
      job.status = 'failed';
      job.finishedAt = new Date().toISOString();
      job.result = null;
      job.error = {
        code: error.code,
        message: globalRedactor.redact(error.message).slice(0, MAX_ERROR_MESSAGE),
        hint: error.hint ? globalRedactor.redact(error.hint).slice(0, MAX_ERROR_HINT) : null,
      };
      return true;
    });
  }

  /**
   * Read, change and write a job atomically. The mutator edits the job in place; it may throw to
   * abort. Status changes must follow queued -> running -> succeeded | failed.
   */
  async update(id: string, mutate: (job: Job) => void): Promise<Job> {
    return this.change(id, (job) => {
      mutate(job);
      return true;
    });
  }

  /** The read, change and write behind `update`. `apply` returns false to leave the job as it is. */
  private async change(id: string, apply: (job: Job) => boolean): Promise<Job> {
    const previous = this.chains.get(id) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        const job = await this.read(id);
        const from = job.status;
        if (!apply(job)) return job;
        if (!canTransition(from, job.status)) {
          throw new MergeStoryError('INTERNAL', `Invalid job status change: ${from} to ${job.status}.`);
        }
        job.updatedAt = new Date().toISOString();
        await this.write(job);
        return job;
      });
    this.chains.set(id, run);
    try {
      return await run;
    } finally {
      if (this.chains.get(id) === run) this.chains.delete(id);
    }
  }

  /** Recent jobs, newest first. Ids start with a UTC timestamp, so sorting the names sorts by age. */
  async list(limit = 20): Promise<Job[]> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const wanted = Math.max(1, Math.min(200, Math.floor(limit)));
    const ids = names.filter(isValidJobId).sort().reverse();
    const jobs: Job[] = [];
    for (const id of ids) {
      if (jobs.length >= wanted) break;
      try {
        jobs.push(await this.get(id));
      } catch {
        // A damaged or removed job must not hide the others.
      }
    }
    return jobs;
  }

  /** Atomic write: temporary file, then rename. */
  async write(job: Job): Promise<void> {
    const target = this.file(job.id);
    const tmp = `${target}.${randomToken(4)}.tmp`;
    await writeFile(tmp, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    try {
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  /** Make sure the jobs directory is private even when an older run created it with looser rights. */
  private async tightenRoot(): Promise<void> {
    try {
      const info = await stat(this.root);
      if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) await chmod(this.root, 0o700);
    } catch {
      // Best effort: the directory was just created or belongs to someone else.
    }
  }
}
