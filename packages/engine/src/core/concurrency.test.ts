import { describe, expect, it } from 'vitest';
import { mapLimit, Semaphore } from './concurrency.ts';

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('Semaphore', () => {
  it('lets at most the given number of tasks run at once', async () => {
    const semaphore = new Semaphore(2);
    let running = 0;
    let peak = 0;
    const task = async (): Promise<void> => {
      running++;
      peak = Math.max(peak, running);
      await tick();
      running--;
    };
    await Promise.all(Array.from({ length: 7 }, () => semaphore.run(task)));
    expect(peak).toBe(2);
    expect(running).toBe(0);
  });

  it('starts waiting tasks in the order they asked', async () => {
    const semaphore = new Semaphore(1);
    const started: number[] = [];
    await Promise.all(
      [1, 2, 3, 4].map((n) =>
        semaphore.run(async () => {
          started.push(n);
          await tick();
        }),
      ),
    );
    expect(started).toEqual([1, 2, 3, 4]);
  });

  it('returns the result of the task and frees the permit when the task fails', async () => {
    const semaphore = new Semaphore(1);
    await expect(
      semaphore.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(semaphore.run(async () => 'next')).resolves.toBe('next');
  });
});

describe('mapLimit', () => {
  it('keeps the order of the items whatever order the tasks finish in', async () => {
    const delays = [30, 5, 20, 1, 10];
    const result = await mapLimit(delays, 3, async (ms, index) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return `${index}:${ms}`;
    });
    expect(result).toEqual(['0:30', '1:5', '2:20', '3:1', '4:10']);
  });

  it('runs at most `limit` tasks at once, and all of them when the limit is higher than the item count', async () => {
    let running = 0;
    let peak = 0;
    const task = async (n: number): Promise<number> => {
      running++;
      peak = Math.max(peak, running);
      await tick();
      running--;
      return n;
    };
    await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, task);
    expect(peak).toBe(3);
    peak = 0;
    await mapLimit([1, 2, 3], 10, task);
    expect(peak).toBe(3);
  });

  it('copes with no items and with a limit below one', async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
    expect(await mapLimit([1, 2, 3], 0, async (n) => n * 2)).toEqual([2, 4, 6]);
  });

  it('starts nothing after a failure, lets running tasks finish, and throws the first failure', async () => {
    const started: number[] = [];
    const finished: number[] = [];
    const error = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      started.push(n);
      await tick();
      if (n === 2) throw new Error('second');
      if (n === 1) await tick();
      finished.push(n);
      return n;
    }).catch((e: unknown) => e);
    expect(error).toEqual(new Error('second'));
    // Items 1 and 2 were running; 3 may have started when 1 or 2 ended, but never anything after the failure.
    expect(started).not.toContain(6);
    expect(finished).toContain(1);
    expect(Math.max(...started)).toBeLessThanOrEqual(4);
  });

  it('does not start any item when the signal is already aborted, and throws ABORTED', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const error = await mapLimit(
      [1, 2],
      2,
      async () => {
        calls++;
      },
      controller.signal,
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'ABORTED', message: 'The run was cancelled.' });
    expect(calls).toBe(0);
  });

  it('stops starting items once the signal is aborted, and lets the running one finish', async () => {
    const controller = new AbortController();
    const started: number[] = [];
    const error = await mapLimit(
      [1, 2, 3, 4],
      1,
      async (n) => {
        started.push(n);
        if (n === 2) controller.abort();
        await tick();
        return n;
      },
      controller.signal,
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'ABORTED' });
    expect(started).toEqual([1, 2]);
  });

  it('prefers the failure of a task to the cancellation that follows it', async () => {
    const controller = new AbortController();
    const error = await mapLimit(
      [1, 2, 3],
      1,
      async (n) => {
        if (n === 1) {
          controller.abort();
          throw new Error('first');
        }
      },
      controller.signal,
    ).catch((e: unknown) => e);
    expect(error).toEqual(new Error('first'));
  });
});
