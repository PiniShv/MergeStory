/** Redacted views of jobs and results, shared by the CLI, the job runner and the HTTP API. */
import { MergeStoryError } from '../core/errors.ts';
import { globalRedactor } from '../core/redact.ts';
import { maskSecrets } from '../core/secrets.ts';
import type { GenerateResult, PlanResult, PublishResult } from '../core/types.ts';
import type { ContextOptions } from '../pipeline/index.ts';
import { longestRun, MAX_UNBROKEN_RUN } from './input-rules.ts';
import type { Job, JobError, JobProgress, JobStatus } from './model.ts';

/** Remove "user:password@" from a link, keeping everything else (including signed query strings). */
function withoutUserInfo(link: string): string;
function withoutUserInfo(link: string | null): string | null;
function withoutUserInfo(link: string | null): string | null {
  if (!link) return link;
  try {
    const url = new URL(link);
    if (!url.username && !url.password) return link;
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return link;
  }
}

/**
 * Redact a result for printing and storage. The links to the published video are the product of
 * the run, so they are kept as they are (a signed link stops working when its signature is
 * removed); every other string goes through the redactor.
 */
export function redactResult<T extends GenerateResult | PlanResult>(result: T): T {
  const redacted = globalRedactor.redactValue(result);
  const original = (result as { publish?: PublishResult | null }).publish;
  const target = (redacted as { publish?: PublishResult | null }).publish;
  if (original && target) {
    target.watchUrl = withoutUserInfo(original.watchUrl);
    target.videoUrl = withoutUserInfo(original.videoUrl);
    target.posterUrl = withoutUserInfo(original.posterUrl);
    target.captionsUrl = withoutUserInfo(original.captionsUrl);
  }
  return redacted;
}

/** Redact a message that may have been built from an error body or a path. */
export function redactText(text: string): string {
  return globalRedactor.redact(text);
}

/** A job as people and API clients see it. */
export interface PublicJob {
  id: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  options: Record<string, unknown>;
  progress: JobProgress;
  result: GenerateResult | PlanResult | null;
  error: JobError | null;
}

/** A job as shown to people and API clients: no process id, no storyboard body, everything redacted. */
export function publicJob(job: Job): PublicJob {
  const { storyboard, ...options } = job.options;
  const shownOptions: Record<string, unknown> = globalRedactor.redactValue({ ...options });
  if (storyboard !== undefined) shownOptions.storyboard = '[provided]';
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    options: shownOptions,
    progress: globalRedactor.redactValue(job.progress),
    result: job.result ? redactResult(job.result) : null,
    error: job.error ? globalRedactor.redactValue(job.error) : null,
  };
}

/** A job in a list. */
export interface JobSummary {
  id: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  progress: JobProgress;
  /** Title of the finished video, when there is one. */
  title: string | null;
  error: JobError | null;
}

/** The short form of a job, for lists. */
export function summarizeJob(job: Job): JobSummary {
  const view = publicJob(job);
  return {
    id: view.id,
    status: view.status,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    progress: view.progress,
    title: view.result ? view.result.title : null,
    error: view.error,
  };
}

/**
 * Mask secret-like values in the text that callers hand over (task, notes, test output).
 * Returns how many values were masked so the caller can say so. Throws USAGE when a text holds a
 * very long unbroken string, which would make the secret scan take far too long.
 */
export function maskContext(context: ContextOptions): { context: ContextOptions; masked: number } {
  let masked = 0;
  const mask = (text: string, what: string): string => {
    if (longestRun(text) > MAX_UNBROKEN_RUN) {
      throw new MergeStoryError(
        'USAGE',
        `The ${what} contains an unbroken string of more than ${MAX_UNBROKEN_RUN} characters.`,
        {
          hint: 'Remove it or keep only the relevant part. Very long strings are refused because scanning them for secrets takes too long.',
        },
      );
    }
    const result = maskSecrets(text);
    masked += result.masked;
    return result.text;
  };
  const out: ContextOptions = {};
  if (context.task !== undefined) out.task = context.task === null ? null : mask(context.task, 'task');
  if (context.notes !== undefined) out.notes = context.notes === null ? null : mask(context.notes, 'notes');
  if (context.tests) {
    out.tests = context.tests.map((t) => ({
      ...t,
      command: mask(t.command, 'test results'),
      summary: mask(t.summary, 'test results'),
    }));
  }
  if (context.screenshots) {
    out.screenshots = context.screenshots.map((s) => ({
      ...s,
      caption: mask(s.caption, 'screenshot captions'),
    }));
  }
  return { context: out, masked };
}
