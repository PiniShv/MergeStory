/** Job records for asynchronous runs (`mergestory generate --async` and the HTTP API). */
import type { ErrorCode } from '../core/errors.ts';
import type { GenerateResult, PlanResult, StageName } from '../core/types.ts';
import type { GenerateOptions } from '../pipeline/index.ts';

/** queued, then running, then succeeded or failed. */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

/** What a job runs: the generate options without live objects. Never holds secrets. */
export type JobOptions = Omit<GenerateOptions, 'signal' | 'logger'>;

/** Where a running job is. */
export interface JobProgress {
  stage: StageName | 'queued';
  message: string;
  /** 0..1 within the stage, or null when unknown. */
  progress: number | null;
}

/** Why a job failed. */
export interface JobError {
  code: ErrorCode;
  message: string;
  hint: string | null;
}

/** The content of job.json. */
export interface Job {
  /** Format version of this file. */
  version: 1;
  id: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /**
   * Process that owns the job, used to spot owners that died: the server that queued it, or the
   * background worker started for it. Null while no owner is known.
   */
  pid: number | null;
  options: JobOptions;
  progress: JobProgress;
  result: GenerateResult | PlanResult | null;
  error: JobError | null;
}

/** Every status, for validation. */
export const JOB_STATUSES: readonly JobStatus[] = ['queued', 'running', 'succeeded', 'failed'];

/** true once a job has finished, one way or the other. */
export function isTerminal(status: JobStatus): boolean {
  return status === 'succeeded' || status === 'failed';
}

/** Allowed status changes. Staying in the same status is always allowed (progress updates). */
const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  queued: ['running', 'failed'],
  running: ['succeeded', 'failed'],
  succeeded: [],
  failed: [],
};

/** true when a job may move from one status to the other. */
export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}
