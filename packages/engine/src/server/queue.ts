/** A simple in-process queue: jobs run one at a time, in the order they were accepted. */
import { MergeStoryError, toMergeStoryError } from '../core/errors.ts';

/** Options of `JobQueue`. */
export interface JobQueueOptions {
  /** Runs one job. It should record its own outcome; if it throws, `fail` is called. */
  run(jobId: string, signal: AbortSignal): Promise<unknown>;
  /** Records that a job could not run or finish. */
  fail(jobId: string, error: MergeStoryError): Promise<unknown>;
  /** How many jobs may wait (the one that is running does not count). */
  maxPending: number;
}

/** Runs one job at a time, in the order they arrive. */
export class JobQueue {
  private readonly options: JobQueueOptions;
  private readonly pending: string[] = [];
  private active: { id: string; controller: AbortController; done: Promise<void> } | null = null;
  private closed = false;

  constructor(options: JobQueueOptions) {
    this.options = options;
  }

  /** Jobs that are waiting or running. */
  get size(): number {
    return this.pending.length + (this.active ? 1 : 0);
  }

  get isFull(): boolean {
    return this.pending.length >= this.options.maxPending;
  }

  /** Add a job. Returns false when the queue is full or closed. */
  enqueue(jobId: string): boolean {
    if (this.closed || this.isFull) return false;
    this.pending.push(jobId);
    this.pump();
    return true;
  }

  private pump(): void {
    if (this.active || this.closed) return;
    const id = this.pending.shift();
    if (id === undefined) return;
    const controller = new AbortController();
    const done = (async () => {
      try {
        await this.options.run(id, controller.signal);
      } catch (err) {
        await this.options.fail(id, toMergeStoryError(err)).catch(() => undefined);
      } finally {
        this.active = null;
        this.pump();
      }
    })();
    this.active = { id, controller, done };
  }

  /**
   * Stop taking jobs, fail the ones that never started, cancel the running one and wait up to
   * `graceMs` for it to record its outcome.
   */
  async close(graceMs: number): Promise<void> {
    this.closed = true;
    const waiting = this.pending.splice(0);
    for (const id of waiting) {
      await this.options
        .fail(id, new MergeStoryError('ABORTED', 'The server stopped before this job started.'))
        .catch(() => undefined);
    }
    const active = this.active;
    if (!active) return;
    active.controller.abort();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      active.done,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs);
        timer.unref();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
}
