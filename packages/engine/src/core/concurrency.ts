/** Limits on how much work runs at once. */
import { abortedError } from './errors.ts';

/** A first-in first-out limit on how many tasks run at once. */
export class Semaphore {
  private available: number;
  private readonly waiting: (() => void)[] = [];

  constructor(permits: number) {
    this.available = permits;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.available > 0) this.available--;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await task();
    } finally {
      // Hand the permit straight to the next waiting task, if there is one.
      const next = this.waiting.shift();
      if (next) next();
      else this.available++;
    }
  }
}

/**
 * Run `task` over `items`, at most `limit` at a time, and return the results in the order of the
 * items. After the first failure, or once `signal` is aborted, no new item starts; the tasks that
 * are running finish, and then the first failure is thrown (a cancelled run throws ABORTED).
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed: { error: unknown } | null = null;
  const lane = async (): Promise<void> => {
    while (!failed && next < items.length) {
      if (signal?.aborted) {
        failed = { error: abortedError() };
        return;
      }
      const index = next++;
      try {
        results[index] = await task(items[index] as T, index);
      } catch (error) {
        failed ??= { error };
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  if (failed) throw (failed as { error: unknown }).error;
  return results;
}
