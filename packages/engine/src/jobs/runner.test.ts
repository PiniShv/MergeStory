import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MergeStoryError } from '../core/errors.ts';
import { globalRedactor } from '../core/redact.ts';
import type { GenerateResult, ProgressEvent } from '../core/types.ts';
import type { GenerateHooks, GenerateOptions } from '../pipeline/index.ts';
import { generate } from '../pipeline/index.ts';
import { runJob, startBackgroundJob, waitForJob } from './runner.ts';
import { JobStore } from './store.ts';
import { startDetachedWorker } from './worker.ts';

vi.mock('../pipeline/index.ts', () => ({
  generate: vi.fn(),
  prepareAuthoring: vi.fn(),
  checkStoryboard: vi.fn(),
}));
vi.mock('./worker.ts', () => ({ startDetachedWorker: vi.fn(async () => 4242) }));

const generateMock = vi.mocked(generate);
const workerMock = vi.mocked(startDetachedWorker);

let dir: string;
let store: JobStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mergestory-runner-'));
  store = new JobStore(join(dir, 'jobs'));
  generateMock.mockReset();
  workerMock.mockClear();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fakeResult(overrides: Partial<GenerateResult> = {}): GenerateResult {
  return {
    ok: true,
    runId: 'r1',
    runDir: '/runs/r1',
    title: 'Add retries',
    summary: 'Adds retries.',
    durationSec: 60,
    chapters: [{ title: 'Mission', startSec: 0 }],
    storyboardSource: 'heuristic',
    files: {
      video: '/runs/r1/video.mp4',
      poster: '/runs/r1/poster.png',
      captions: '/runs/r1/captions.vtt',
      storyboard: '/runs/r1/storyboard.json',
      watchPage: '/runs/r1/watch.html',
    },
    publish: null,
    notify: null,
    grounding: { groundedClaims: 3, fixes: [], warnings: [] },
    cost: { totalUsd: 0, budgetUsd: 0.25, records: [] },
    egress: [],
    warnings: [],
    ...overrides,
  };
}

describe('runJob', () => {
  it('runs a queued job and stores the result', async () => {
    const queued = await store.create({ source: '/work/repo', base: 'main', config: { style: 'product' } });
    generateMock.mockResolvedValue(fakeResult());

    const job = await runJob(queued.id, { store });

    expect(job.status).toBe('succeeded');
    expect(job.error).toBeNull();
    expect(job.result?.title).toBe('Add retries');
    expect(job.startedAt).not.toBeNull();
    expect(job.finishedAt).not.toBeNull();
    expect(job.progress.progress).toBe(1);
    expect((await store.read(queued.id)).status).toBe('succeeded');

    const [options] = generateMock.mock.calls[0] as [GenerateOptions, GenerateHooks];
    expect(options.source).toBe('/work/repo');
    expect(options.base).toBe('main');
    expect(options.config).toEqual({ style: 'product' });
    // A job's run directory is named after the job.
    expect(options.runId).toBe(queued.id);
  });

  it('passes the abort signal and logger on', async () => {
    const queued = await store.create({ source: '.' });
    const controller = new AbortController();
    generateMock.mockResolvedValue(fakeResult());
    await runJob(queued.id, { store, signal: controller.signal });
    const [options] = generateMock.mock.calls[0] as [GenerateOptions, GenerateHooks];
    expect(options.signal).toBe(controller.signal);
  });

  it('marks the job running while generate works', async () => {
    const queued = await store.create({ source: '.' });
    let seenStatus = '';
    let seenPid: number | null = null;
    generateMock.mockImplementation(async () => {
      const current = await store.read(queued.id);
      seenStatus = current.status;
      seenPid = current.pid;
      return fakeResult();
    });
    await runJob(queued.id, { store });
    expect(seenStatus).toBe('running');
    expect(seenPid).toBe(process.pid);
  });

  it('records progress events', async () => {
    const queued = await store.create({ source: '.' });
    let midway = '';
    generateMock.mockImplementation(async (_options, hooks) => {
      const event: ProgressEvent = { stage: 'analyze', status: 'start', message: 'Analysing the change' };
      hooks?.onProgress?.(event);
      // Wait for the write to land.
      await new Promise((resolve) => setTimeout(resolve, 80));
      midway = (await store.read(queued.id)).progress.message;
      return fakeResult();
    });
    await runJob(queued.id, { store });
    expect(midway).toBe('Analysing the change');
  });

  it('throttles rapid progress events but keeps the last state sensible', async () => {
    const queued = await store.create({ source: '.' });
    const updates = vi.spyOn(store, 'update');
    generateMock.mockImplementation(async (_options, hooks) => {
      hooks?.onProgress?.({ stage: 'render', status: 'start', message: 'Rendering' });
      for (let i = 1; i <= 50; i++) {
        hooks?.onProgress?.({ stage: 'render', status: 'progress', progress: i / 50, message: `frame ${i}` });
      }
      return fakeResult();
    });
    const job = await runJob(queued.id, { store });
    // start + the running/finished transitions, and far fewer writes than events.
    expect(updates.mock.calls.length).toBeLessThan(10);
    expect(job.status).toBe('succeeded');
    expect(job.progress.message).toBe('Finished');
  });

  it('clamps progress values and redacts messages', async () => {
    const queued = await store.create({ source: '.' });
    const secret = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
    globalRedactor.add(secret);
    let seen = { message: '', progress: -1 as number | null };
    generateMock.mockImplementation(async (_options, hooks) => {
      hooks?.onProgress?.({ stage: 'publish', status: 'warn', progress: 7, message: `token ${secret}` });
      await new Promise((resolve) => setTimeout(resolve, 80));
      const current = (await store.read(queued.id)).progress;
      seen = { message: current.message, progress: current.progress };
      return fakeResult();
    });
    await runJob(queued.id, { store });
    expect(seen.message).not.toContain(secret);
    expect(seen.progress).toBe(1);
  });

  it('stores a MergeStoryError with its code and hint', async () => {
    const queued = await store.create({ source: '.' });
    generateMock.mockRejectedValue(
      new MergeStoryError('BUDGET_EXCEEDED', 'Too expensive.', { hint: 'Raise --budget.' }),
    );
    const job = await runJob(queued.id, { store });
    expect(job.status).toBe('failed');
    expect(job.result).toBeNull();
    expect(job.error).toEqual({
      code: 'BUDGET_EXCEEDED',
      message: 'Too expensive.',
      hint: 'Raise --budget.',
    });
    expect(job.finishedAt).not.toBeNull();
  });

  it('stores other errors as INTERNAL and redacts secrets in the message', async () => {
    const queued = await store.create({ source: '.' });
    const key = `sk-ant-${'Zy9Xw8Vu7Ts6Rq5P'.repeat(2)}`;
    generateMock.mockRejectedValue(new Error(`request failed for key ${key}`));
    const job = await runJob(queued.id, { store });
    expect(job.error?.code).toBe('INTERNAL');
    expect(job.error?.message).not.toContain(key);
    expect(job.error?.hint).toBeNull();
  });

  it('redacts the message and the hint of a failed run and cuts them to a fixed length', async () => {
    const queued = await store.create({ source: '.' });
    const key = `sk-ant-${'Zy9Xw8Vu7Ts6Rq5P'.repeat(2)}`;
    generateMock.mockRejectedValue(
      new MergeStoryError('LLM_FAILED', `${key} ${'m'.repeat(5000)}`, { hint: `${key} ${'h'.repeat(3000)}` }),
    );
    const job = await runJob(queued.id, { store });
    expect(job.error?.message).not.toContain(key);
    expect(job.error?.message).toHaveLength(2000);
    expect(job.error?.hint).not.toContain(key);
    expect(job.error?.hint).toHaveLength(1000);
    expect((await store.read(queued.id)).error).toEqual(job.error);
  });

  it('records a cancelled run as ABORTED', async () => {
    const queued = await store.create({ source: '.' });
    const controller = new AbortController();
    generateMock.mockImplementation(async () => {
      controller.abort();
      throw new Error('socket hang up');
    });
    const job = await runJob(queued.id, { store, signal: controller.signal });
    expect(job.status).toBe('failed');
    expect(job.error?.code).toBe('ABORTED');
  });

  it('refuses to run a job twice', async () => {
    const queued = await store.create({ source: '.' });
    generateMock.mockResolvedValue(fakeResult());
    await runJob(queued.id, { store });
    await expect(runJob(queued.id, { store })).rejects.toMatchObject({ code: 'USAGE' });
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown or malformed job id', async () => {
    await expect(runJob('20261103-214501-a3f9', { store })).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
    await expect(runJob('../escape', { store })).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('keeps the links to the published video intact in the stored result', async () => {
    const queued = await store.create({ source: '.' });
    const link =
      'https://files.example.com/v/abc/video.mp4?X-Amz-Signature=0123456789abcdef&X-Amz-Expires=3600';
    generateMock.mockResolvedValue(
      fakeResult({
        publish: {
          provider: 's3',
          watchUrl: link.replace('video.mp4', 'index.html'),
          videoUrl: link,
          posterUrl: null,
          captionsUrl: null,
          expiresAt: '2026-11-10T00:00:00Z',
          visibility: 'private',
          location: 's3://bucket/prefix/',
        },
      }),
    );
    const job = await runJob(queued.id, { store });
    const stored = job.result as GenerateResult;
    expect(stored.publish?.videoUrl).toBe(link);
    expect(stored.publish?.watchUrl).toContain('X-Amz-Signature=0123456789abcdef');
  });
});

describe('startBackgroundJob', () => {
  it('creates a queued job for the worker that was started for it', async () => {
    const job = await startBackgroundJob(
      { source: '/work/repo', config: { style: 'product' } },
      { store, home: '/the/home', env: { SOME_KEY: 'value' } },
    );
    expect(job.status).toBe('queued');
    expect(workerMock).toHaveBeenCalledTimes(1);
    expect(workerMock).toHaveBeenCalledWith(job.id, { home: '/the/home', env: { SOME_KEY: 'value' } });
    const stored = await store.read(job.id);
    expect(stored.status).toBe('queued');
    expect(stored.pid).toBeNull();
    expect(stored.options).toEqual({ source: '/work/repo', config: { style: 'product' } });
  });

  it('fails a queued job whose worker died before it started', async () => {
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    workerMock.mockResolvedValueOnce(dead);
    const job = await startBackgroundJob({ source: '.' }, { store });
    const seen = await store.get(job.id);
    expect(seen.status).toBe('failed');
    expect(seen.error?.message).toMatch(/worker process ended/);
  });

  it('keeps a queued job whose worker is still starting', async () => {
    workerMock.mockResolvedValueOnce(process.pid);
    const job = await startBackgroundJob({ source: '.' }, { store });
    expect((await store.get(job.id)).status).toBe('queued');
  });

  it('keeps the job open when the worker reports no process id', async () => {
    workerMock.mockResolvedValueOnce(undefined);
    const job = await startBackgroundJob({ source: '.' }, { store });
    expect((await store.get(job.id)).status).toBe('queued');
  });

  it('does not undo the worker when it starts while the parent is still busy', async () => {
    const worker = new JobStore(store.root);
    let spawned = false;
    let started = false;
    workerMock.mockImplementationOnce(async () => {
      spawned = true;
      return 4242;
    });
    // The worker, in another process, starts at the moment the parent writes the job file.
    const write = store.write.bind(store);
    vi.spyOn(store, 'write').mockImplementation(async (job) => {
      if (spawned && !started) {
        started = true;
        await worker.update(job.id, (j) => {
          j.status = 'running';
          j.pid = process.pid;
        });
      }
      await write(job);
    });
    const job = await startBackgroundJob({ source: '.' }, { store });
    if (!started) {
      await worker.update(job.id, (j) => {
        j.status = 'running';
        j.pid = process.pid;
      });
    }
    await worker.update(job.id, (j) => {
      j.status = 'succeeded';
    });
    expect((await store.read(job.id)).status).toBe('succeeded');
  });

  it('fails the job and throws when the worker cannot be started', async () => {
    const error = new MergeStoryError('INTERNAL', 'Could not start the background worker: spawn ENOENT', {
      hint: 'Run it in the foreground instead.',
    });
    workerMock.mockRejectedValueOnce(error);
    await expect(startBackgroundJob({ source: '.' }, { store })).rejects.toBe(error);
    const [stored] = await store.list();
    expect(stored?.status).toBe('failed');
    expect(stored?.finishedAt).not.toBeNull();
    expect(stored?.error).toEqual({
      code: 'INTERNAL',
      message: 'Could not start the background worker: spawn ENOENT',
      hint: 'Run it in the foreground instead.',
    });
  });

  it('redacts the message and the hint of that failure and cuts them to a fixed length', async () => {
    const key = `sk-ant-${'Zy9Xw8Vu7Ts6Rq5P'.repeat(2)}`;
    workerMock.mockRejectedValueOnce(
      new MergeStoryError('INTERNAL', `${key} ${'m'.repeat(5000)}`, { hint: `${key} ${'h'.repeat(3000)}` }),
    );
    await expect(startBackgroundJob({ source: '.' }, { store })).rejects.toBeInstanceOf(MergeStoryError);
    const [stored] = await store.list();
    expect(stored?.error?.message).not.toContain(key);
    expect(stored?.error?.message).toHaveLength(2000);
    expect(stored?.error?.hint).not.toContain(key);
    expect(stored?.error?.hint).toHaveLength(1000);
  });

  it('wraps an error that is not a MergeStoryError', async () => {
    workerMock.mockRejectedValueOnce(new Error('spawn EAGAIN'));
    await expect(startBackgroundJob({ source: '.' }, { store })).rejects.toThrow('spawn EAGAIN');
    const [stored] = await store.list();
    expect(stored?.status).toBe('failed');
    expect(stored?.error).toEqual({ code: 'INTERNAL', message: 'spawn EAGAIN', hint: null });
  });
});

describe('waitForJob', () => {
  it('returns as soon as the job has finished', async () => {
    const queued = await store.create({ source: '.' });
    const updates: string[] = [];
    setTimeout(() => {
      void store
        .update(queued.id, (j) => {
          j.status = 'running';
          j.pid = process.pid;
        })
        .then(() =>
          store.update(queued.id, (j) => {
            j.status = 'succeeded';
          }),
        );
    }, 40);
    const job = await waitForJob(queued.id, 5000, {
      store,
      pollMs: 10,
      onUpdate: (j) => updates.push(j.status),
    });
    expect(job.status).toBe('succeeded');
    expect(updates[0]).toBe('queued');
    expect(updates.at(-1)).toBe('succeeded');
  });

  it('returns at once for a finished job', async () => {
    const queued = await store.create({ source: '.' });
    await store.update(queued.id, (j) => {
      j.status = 'failed';
    });
    const started = Date.now();
    const job = await waitForJob(queued.id, 5000, { store });
    expect(job.status).toBe('failed');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('times out with a hint when the job keeps running', async () => {
    const queued = await store.create({ source: '.' });
    await store.update(queued.id, (j) => {
      j.status = 'running';
      j.pid = process.pid;
    });
    const error = await waitForJob(queued.id, 120, { store, pollMs: 20 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MergeStoryError);
    expect((error as MergeStoryError).message).toMatch(/still running/);
    expect((error as MergeStoryError).hint).toContain(`mergestory status ${queued.id} --wait`);
  });

  it('returns a failed job at once when the process that owned a queued job has died', async () => {
    const pid = spawnSync(process.execPath, ['-e', '']).pid;
    const queued = await store.create({ source: '.' }, { pid });
    const started = Date.now();
    const job = await waitForJob(queued.id, 5000, { store, pollMs: 10 });
    expect(job.status).toBe('failed');
    expect(job.error?.message).toMatch(/worker process ended/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('stops waiting when cancelled', async () => {
    const queued = await store.create({ source: '.' });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    await expect(
      waitForJob(queued.id, 5000, { store, pollMs: 10, signal: controller.signal }),
    ).rejects.toBeDefined();
  });

  it('throws JOB_NOT_FOUND for an unknown job', async () => {
    await expect(waitForJob('20261103-214501-a3f9', 100, { store })).rejects.toMatchObject({
      code: 'JOB_NOT_FOUND',
    });
  });
});
