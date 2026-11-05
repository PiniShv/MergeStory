import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MergeStoryError } from '../core/errors.ts';
import { REDACTED } from '../core/redact.ts';
import type { GenerateResult } from '../core/types.ts';
import { canTransition } from './model.ts';
import { assertJobId, isValidJobId, JobStore } from './store.ts';

let dir: string;
let store: JobStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mergestory-jobs-'));
  store = new JobStore(join(dir, 'jobs'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function deadPid(): Promise<number> {
  const child = spawnSync(process.execPath, ['-e', '']);
  return child.pid;
}

describe('job ids', () => {
  it('accepts run-style ids only', () => {
    expect(isValidJobId('20261103-214501-a3f9')).toBe(true);
    for (const bad of [
      '',
      '../etc/passwd',
      '20261103-214501-A3F9',
      '20261103-214501-a3f',
      '20261103-214501-a3f9/',
      '20261103-214501-a3f9\n',
      'x20261103-214501-a3f9',
      '2026110-214501-a3f9',
      42,
      null,
      undefined,
    ]) {
      expect(isValidJobId(bad), String(bad)).toBe(false);
    }
  });

  it('throws JOB_NOT_FOUND with a hint before touching the file system', async () => {
    expect(() => assertJobId('../../etc')).toThrow(MergeStoryError);
    try {
      assertJobId('../../etc');
    } catch (err) {
      expect((err as MergeStoryError).code).toBe('JOB_NOT_FOUND');
      expect((err as MergeStoryError).hint).toContain('mergestory jobs');
    }
    await expect(store.read('../../etc')).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
    await expect(store.update('nope', () => {})).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
    expect(() => store.jobDir('..')).toThrow(MergeStoryError);
  });

  it('does not echo long or non-printable input back', () => {
    try {
      assertJobId(`\u001b[31m${'x'.repeat(200)}`);
    } catch (err) {
      const message = (err as MergeStoryError).message;
      expect(message).not.toContain('\u001b');
      expect(message.length).toBeLessThan(100);
    }
  });
});

describe('JobStore.create and read', () => {
  it('creates a queued job with private permissions', async () => {
    const job = await store.create({ source: '/work/repo', config: { style: 'product' } });
    expect(job.status).toBe('queued');
    expect(job.id).toMatch(/^\d{8}-\d{6}-[a-f0-9]{4}$/);
    expect(job.version).toBe(1);
    expect(job.result).toBeNull();
    expect(job.error).toBeNull();
    expect(job.progress.stage).toBe('queued');

    const again = await store.read(job.id);
    expect(again).toEqual(job);

    if (process.platform !== 'win32') {
      expect((await stat(store.root)).mode & 0o777).toBe(0o700);
      expect((await stat(store.jobDir(job.id))).mode & 0o777).toBe(0o700);
      expect((await stat(join(store.jobDir(job.id), 'job.json'))).mode & 0o777).toBe(0o600);
    }
  });

  it('records the process that owns the job, and none by default', async () => {
    const owned = await store.create({ source: '.' }, { pid: 4321 });
    expect(owned.pid).toBe(4321);
    expect((await store.read(owned.id)).pid).toBe(4321);
    expect((await store.create({ source: '.' })).pid).toBeNull();
  });

  it('keeps secrets out of the stored options', async () => {
    const key = `sk-ant-${'a1B2c3D4e5F6g7H8'.repeat(2)}`;
    const job = await store.create({ source: `/work/repo?token=${key}`, context: { notes: `use ${key}` } });
    const text = await readFile(join(store.jobDir(job.id), 'job.json'), 'utf8');
    expect(text).not.toContain(key);
  });

  it('gives every job its own directory even when created in the same second', async () => {
    const now = new Date('2026-11-03T21:45:01Z');
    const jobs = await Promise.all(Array.from({ length: 12 }, () => store.create({ source: '.' }, { now })));
    expect(new Set(jobs.map((j) => j.id)).size).toBe(12);
  });

  it('reports a missing job as JOB_NOT_FOUND', async () => {
    await expect(store.read('20261103-214501-a3f9')).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
  });

  it('reports a damaged job file as INTERNAL', async () => {
    const job = await store.create({ source: '.' });
    await writeFile(join(store.jobDir(job.id), 'job.json'), '{not json');
    await expect(store.read(job.id)).rejects.toMatchObject({ code: 'INTERNAL' });
    await writeFile(join(store.jobDir(job.id), 'job.json'), JSON.stringify({ id: job.id }));
    await expect(store.read(job.id)).rejects.toMatchObject({ code: 'INTERNAL' });
  });
});

describe('JobStore.update', () => {
  it('writes atomically and leaves no temporary files', async () => {
    const job = await store.create({ source: '.' });
    await store.update(job.id, (j) => {
      j.status = 'running';
    });
    // Many updates at once must apply one after the other and keep the file valid.
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        store.update(job.id, (j) => {
          j.progress = { stage: 'render', message: `step ${i}`, progress: i / 25 };
        }),
      ),
    );
    const names = await readdir(store.jobDir(job.id));
    expect(names).toEqual(['job.json']);
    const final = await store.read(job.id);
    expect(final.progress.message).toBe('step 24');
    expect(final.status).toBe('running');
  });

  it('updates updatedAt', async () => {
    const job = await store.create({ source: '.' }, { now: new Date('2020-01-01T00:00:00Z') });
    const next = await store.update(job.id, (j) => {
      j.progress = { stage: 'source', message: 'hi', progress: null };
    });
    expect(Date.parse(next.updatedAt)).toBeGreaterThan(Date.parse(job.updatedAt));
  });

  it('follows queued, running, succeeded or failed', async () => {
    const job = await store.create({ source: '.' });
    const running = await store.update(job.id, (j) => {
      j.status = 'running';
    });
    expect(running.status).toBe('running');
    const done = await store.update(job.id, (j) => {
      j.status = 'succeeded';
    });
    expect(done.status).toBe('succeeded');
    await expect(
      store.update(job.id, (j) => {
        j.status = 'running';
      }),
    ).rejects.toThrow(/Invalid job status change: succeeded to running/);
    // The rejected change was not written.
    expect((await store.read(job.id)).status).toBe('succeeded');
  });

  it('refuses to skip a step', async () => {
    const job = await store.create({ source: '.' });
    await expect(
      store.update(job.id, (j) => {
        j.status = 'succeeded';
      }),
    ).rejects.toThrow(/queued to succeeded/);
    expect(canTransition('queued', 'failed')).toBe(true);
    expect(canTransition('failed', 'queued')).toBe(false);
    expect(canTransition('running', 'running')).toBe(true);
  });

  it('keeps going after a failed update', async () => {
    const job = await store.create({ source: '.' });
    await expect(
      store.update(job.id, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const next = await store.update(job.id, (j) => {
      j.status = 'running';
    });
    expect(next.status).toBe('running');
  });
});

describe('JobStore.list', () => {
  it('returns newest first and respects the limit', async () => {
    const a = await store.create({ source: 'a' }, { now: new Date('2026-11-01T10:00:00Z') });
    const b = await store.create({ source: 'b' }, { now: new Date('2026-11-02T10:00:00Z') });
    const c = await store.create({ source: 'c' }, { now: new Date('2026-11-03T10:00:00Z') });
    expect((await store.list()).map((j) => j.id)).toEqual([c.id, b.id, a.id]);
    expect((await store.list(2)).map((j) => j.id)).toEqual([c.id, b.id]);
  });

  it('is empty when nothing was created yet', async () => {
    expect(await store.list()).toEqual([]);
  });

  it('ignores foreign entries and damaged jobs', async () => {
    const good = await store.create({ source: 'a' }, { now: new Date('2026-11-01T10:00:00Z') });
    await mkdir(join(store.root, 'not-a-job'));
    await writeFile(join(store.root, 'notes.txt'), 'hello');
    const bad = await store.create({ source: 'b' }, { now: new Date('2026-11-02T10:00:00Z') });
    await writeFile(join(store.jobDir(bad.id), 'job.json'), 'garbage');
    expect((await store.list()).map((j) => j.id)).toEqual([good.id]);
  });
});

describe('JobStore.get', () => {
  it('marks a running job as failed when its worker is gone', async () => {
    const job = await store.create({ source: '.' });
    const pid = await deadPid();
    await store.update(job.id, (j) => {
      j.status = 'running';
      j.pid = pid;
    });
    const seen = await store.get(job.id);
    expect(seen.status).toBe('failed');
    expect(seen.error?.code).toBe('INTERNAL');
    expect(seen.error?.message).toMatch(/worker process ended/);
    expect(seen.finishedAt).not.toBeNull();
    expect((await store.read(job.id)).status).toBe('failed');
  });

  it('also notices a queued job whose background worker died before it started', async () => {
    const job = await store.create({ source: '.' });
    const pid = await deadPid();
    await store.update(job.id, (j) => {
      j.pid = pid;
    });
    const seen = await store.get(job.id);
    expect(seen.status).toBe('failed');
    expect(seen.error?.message).toMatch(/worker process ended/);
  });

  it('fails a queued job whose owner was recorded at creation and has died', async () => {
    const pid = await deadPid();
    const job = await store.create({ source: '.' }, { pid });
    const fail = vi.spyOn(store, 'fail');
    const seen = await store.get(job.id);
    // The failure is written by the same method that every other failure goes through.
    expect(fail).toHaveBeenCalledTimes(1);
    expect(seen.status).toBe('failed');
    expect(seen.error).toEqual({
      code: 'INTERNAL',
      message: 'The worker process ended before the job finished.',
      hint: 'Run the command again. Add --log-level debug to see more.',
    });
    expect(seen.finishedAt).not.toBeNull();
    expect((await store.read(job.id)).status).toBe('failed');
    expect((await store.list()).map((j) => j.status)).toEqual(['failed']);
  });

  it('leaves a queued job without an owner alone', async () => {
    const job = await store.create({ source: '.' });
    expect((await store.get(job.id)).status).toBe('queued');
  });

  it('leaves a job alone while its process is alive', async () => {
    const job = await store.create({ source: '.' });
    await store.update(job.id, (j) => {
      j.status = 'running';
      j.pid = process.pid;
    });
    expect((await store.get(job.id)).status).toBe('running');
  });

  it('does not touch finished jobs', async () => {
    const job = await store.create({ source: '.' });
    await store.update(job.id, (j) => {
      j.status = 'running';
      j.pid = 999_999_999;
    });
    await store.update(job.id, (j) => {
      j.status = 'succeeded';
    });
    expect((await store.get(job.id)).status).toBe('succeeded');
  });
});

describe('JobStore.failOrphans', () => {
  const earlier = new Date('2026-11-01T10:00:00Z');
  const startedAt = new Date('2026-11-01T11:00:00Z');
  const later = new Date('2026-11-01T12:00:00Z');

  it('fails the unfinished jobs that an earlier process with the same pid left behind', async () => {
    const queued = await store.create({ source: '.' }, { pid: 4242, now: earlier });
    const running = await store.create({ source: '.' }, { pid: 4242, now: earlier });
    await store.update(running.id, (j) => {
      j.status = 'running';
    });
    expect(await store.failOrphans(4242, startedAt)).toBe(2);
    for (const id of [queued.id, running.id]) {
      const job = await store.read(id);
      expect(job.status).toBe('failed');
      expect(job.error?.message).toBe('The worker process ended before the job finished.');
    }
  });

  it('leaves jobs of other processes, newer jobs and finished jobs alone', async () => {
    const other = await store.create({ source: '.' }, { pid: 4243, now: earlier });
    const unowned = await store.create({ source: '.' }, { now: earlier });
    const newer = await store.create({ source: '.' }, { pid: 4242, now: later });
    const done = await store.create({ source: '.' }, { pid: 4242, now: earlier });
    await store.update(done.id, (j) => {
      j.status = 'running';
    });
    await store.update(done.id, (j) => {
      j.status = 'succeeded';
    });
    expect(await store.failOrphans(4242, startedAt)).toBe(0);
    expect((await store.read(other.id)).status).toBe('queued');
    expect((await store.read(unowned.id)).status).toBe('queued');
    expect((await store.read(newer.id)).status).toBe('queued');
    expect((await store.read(done.id)).status).toBe('succeeded');
  });

  it('finds nothing in a job folder that does not exist yet', async () => {
    expect(await new JobStore(join(dir, 'missing')).failOrphans(4242, startedAt)).toBe(0);
  });
});

describe('JobStore.fail', () => {
  const key = `sk-ant-${'Zy9Xw8Vu7Ts6Rq5P'.repeat(2)}`;
  const partial = { title: 'Add retries' } as unknown as GenerateResult;

  it('marks a queued job as failed', async () => {
    const job = await store.create({ source: '.' });
    const failed = await store.fail(
      job.id,
      new MergeStoryError('LLM_FAILED', 'The model refused.', { hint: 'Try another model.' }),
    );
    expect(failed.status).toBe('failed');
    expect(failed.error).toEqual({
      code: 'LLM_FAILED',
      message: 'The model refused.',
      hint: 'Try another model.',
    });
    expect(failed.finishedAt).not.toBeNull();
    expect(await store.read(job.id)).toEqual(failed);
  });

  it('marks a running job as failed, clears its result and stores a missing hint as null', async () => {
    const job = await store.create({ source: '.' });
    await store.update(job.id, (j) => {
      j.status = 'running';
      j.result = partial;
    });
    const failed = await store.fail(job.id, new MergeStoryError('ABORTED', 'The run was cancelled.'));
    expect(failed.status).toBe('failed');
    expect(failed.result).toBeNull();
    expect(failed.error).toEqual({ code: 'ABORTED', message: 'The run was cancelled.', hint: null });
    expect((await store.read(job.id)).result).toBeNull();
  });

  it('redacts the message and the hint and cuts them to a fixed length', async () => {
    const job = await store.create({ source: '.' });
    const failed = await store.fail(
      job.id,
      new MergeStoryError('INTERNAL', `request failed for ${key} ${'m'.repeat(5000)}`, {
        hint: `use ${key} ${'h'.repeat(3000)}`,
      }),
    );
    const stored = (await store.read(job.id)).error;
    expect(stored).toEqual(failed.error);
    expect(stored?.message).not.toContain(key);
    expect(stored?.message).toContain(REDACTED);
    expect(stored?.message).toHaveLength(2000);
    expect(stored?.hint).not.toContain(key);
    expect(stored?.hint).toContain(REDACTED);
    expect(stored?.hint).toHaveLength(1000);
  });

  it('redacts before it cuts, so a secret at the cut does not survive', async () => {
    const job = await store.create({ source: '.' });
    await store.fail(
      job.id,
      new MergeStoryError('INTERNAL', `${'m'.repeat(1989)} ${key}`, { hint: `${'h'.repeat(989)} ${key}` }),
    );
    const stored = (await store.read(job.id)).error;
    expect(stored?.message).toBe(`${'m'.repeat(1989)} ${REDACTED}`);
    expect(stored?.hint).toBe(`${'h'.repeat(989)} ${REDACTED}`);
  });

  it('leaves a finished job exactly as it is', async () => {
    const succeeded = await store.create({ source: 'a' });
    await store.update(succeeded.id, (j) => {
      j.status = 'running';
    });
    await store.update(succeeded.id, (j) => {
      j.status = 'succeeded';
      j.finishedAt = new Date().toISOString();
      j.result = partial;
    });
    const failed = await store.create({ source: 'b' });
    await store.fail(failed.id, new MergeStoryError('LLM_FAILED', 'The first failure.'));

    for (const job of [succeeded, failed]) {
      const file = join(store.jobDir(job.id), 'job.json');
      const before = await readFile(file, 'utf8');
      const seen = await store.fail(job.id, new MergeStoryError('INTERNAL', 'A later failure.'));
      expect(seen).toEqual(JSON.parse(before));
      expect(await readFile(file, 'utf8')).toBe(before);
    }
    expect((await store.read(succeeded.id)).status).toBe('succeeded');
    expect((await store.read(succeeded.id)).result).toEqual(partial);
    expect((await store.read(failed.id)).error?.message).toBe('The first failure.');
  });

  it('throws JOB_NOT_FOUND for a job that does not exist', async () => {
    await expect(
      store.fail('20261103-214501-a3f9', new MergeStoryError('INTERNAL', 'Nothing here.')),
    ).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
  });
});
