import { mkdir, readdir, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dir, fakeResult, run } from '../../testing/cli.ts';

vi.mock('../../pipeline/index.ts', () => ({
  generate: vi.fn(),
  prepareAuthoring: vi.fn(),
  checkStoryboard: vi.fn(),
}));
vi.mock('../../jobs/worker.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../jobs/worker.ts')>()),
  startDetachedWorker: vi.fn(async () => 4242),
}));

const runsDir = () => join(dir, 'home', 'runs');
const A = '20261101-100000-aaaa';
const B = '20261102-100000-bbbb';
const C = '20261103-100000-cccc';

async function makeRun(id: string, files: Record<string, unknown> = {}): Promise<string> {
  const folder = join(runsDir(), id);
  await mkdir(folder, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(folder, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return folder;
}
const withResult = (id: string, overrides = {}) =>
  makeRun(id, { 'result.json': fakeResult({ runId: id, ...overrides }), 'video.mp4': 'x'.repeat(100) });
const jobsDir = () => join(dir, 'home', 'jobs');
/** A job file as the job store writes it. */
async function makeJob(id: string, status: string, runId?: string): Promise<void> {
  await mkdir(join(jobsDir(), id), { recursive: true });
  const stamp = '2026-11-01T10:00:00.000Z';
  const job = {
    version: 1,
    id,
    status,
    createdAt: stamp,
    updatedAt: stamp,
    startedAt: null,
    finishedAt: null,
    pid: null,
    options: runId ? { runId } : {},
    progress: { stage: 'queued', message: 'x', progress: 0 },
    result: null,
    error: null,
  };
  await writeFile(join(jobsDir(), id, 'job.json'), JSON.stringify(job));
}
const ids = (stdout: string): string[] =>
  (JSON.parse(stdout) as { runs: { runId: string }[] }).runs.map((r) => r.runId);

describe('mergestory runs', () => {
  it('lists the runs newest first, and limits them', async () => {
    await withResult(B);
    await withResult(A);
    await withResult(C);
    expect(ids((await run(['runs', '--json'])).stdout)).toEqual([C, B, A]);
    expect(ids((await run(['runs', '--json', '--limit', '2'])).stdout)).toEqual([C, B]);
    expect((await run(['runs', '--limit', '501'])).code).toBe(2);
  });

  it('leaves out a folder without result.json and skips a broken one', async () => {
    await withResult(A);
    await makeRun(B, { 'publish-input.json': {} });
    await makeRun(C, { 'result.json': '{ nope' });
    await makeRun('20261104-100000-dddd', { 'result.json': { ok: false } });
    const { code, stdout } = await run(['runs', '--json']);
    expect(code).toBe(0);
    expect(ids(stdout)).toEqual([A]);
  });

  it('prints the JSON shape, with the time from the id and the folder time for other names', async () => {
    await withResult(A, {
      publish: { provider: 's3', watchUrl: 'https://v.example.com/x', expiresAt: null },
    });
    const other = await withResult('old-run');
    await utimes(other, new Date('2020-01-02T03:04:05Z'), new Date('2020-01-02T03:04:05Z'));
    const { runs } = JSON.parse((await run(['runs', '--json'])).stdout) as {
      runs: Record<string, unknown>[];
    };
    expect(runs[0]).toEqual({
      runId: A,
      runDir: join(runsDir(), A),
      createdAt: '2026-11-01T10:00:00.000Z',
      title: 'Add retries to the uploader',
      durationSec: 83,
      video: join(runsDir(), A, 'video.mp4'),
      publish: {
        provider: 's3',
        watchUrl: 'https://v.example.com/x',
        shareUrl: 'https://v.example.com/x',
        expiresAt: null,
      },
    });
    expect(runs[1]).toMatchObject({ runId: 'old-run', createdAt: '2020-01-02T03:04:05.000Z', publish: null });
  });

  it('prints a table with the place and link, and cleans the title', async () => {
    await withResult(A, {
      title: 'Hello\u001b[31m red',
      publish: { provider: 's3', watchUrl: 'https://v.example.com/x' },
    });
    await withResult(B);
    const { stdout } = await run(['runs']);
    expect(stdout).toContain('this machine');
    expect(stdout).toContain('https://v.example.com/x');
    expect(stdout).not.toContain('\u001b');
  });

  it('gives a local run no link to share, in the table and in the JSON', async () => {
    await withResult(A, { publish: { provider: 'local', watchUrl: 'file:///runs/a/publish/index.html' } });
    expect((await run(['runs'])).stdout).not.toContain('file://');
    const { runs } = JSON.parse((await run(['runs', '--json'])).stdout) as {
      runs: { publish: { shareUrl: string | null } }[];
    };
    expect(runs[0]?.publish.shareUrl).toBeNull();
  });
});

describe('mergestory runs delete', () => {
  it('deletes the run folders and says how many bytes were freed', async () => {
    await withResult(A);
    await withResult(B);
    const { code, stdout } = await run(['runs', 'delete', A, '--json']);
    expect(code).toBe(0);
    const out = JSON.parse(stdout) as { ok: boolean; deleted: string[]; freedBytes: number };
    expect(out).toMatchObject({ ok: true, deleted: [A] });
    expect(out.freedBytes).toBeGreaterThanOrEqual(100);
    expect(await readdir(runsDir())).toEqual([B]);
    expect((await run(['runs', 'delete', B])).stdout).toMatch(/Deleted .*freed/);
  });

  it('deletes the folder of a dry run, which the list leaves out', async () => {
    await makeRun(A, { 'analysis.json': {} });
    expect(ids((await run(['runs', '--json'])).stdout)).toEqual([]);
    expect((await run(['runs', 'delete', A])).code).toBe(0);
    expect(await readdir(runsDir())).toEqual([]);
  });

  it('refuses a bad id, a link, a folder without a file of a run and an id outside the runs folder', async () => {
    const outside = join(dir, 'precious');
    await mkdir(outside);
    await writeFile(join(outside, 'result.json'), '{}');
    await mkdir(runsDir(), { recursive: true });
    await symlink(outside, join(runsDir(), A));
    await makeRun(B, { 'notes.txt': 'keep me' });
    await withResult(C);
    const { code, stdout } = await run(['runs', 'delete', 'bad', '../precious', outside, A, B, C, '--json']);
    expect(code).toBe(2);
    const out = JSON.parse(stdout) as { ok: boolean; deleted: string[]; errors: { runId: string }[] };
    expect(out.ok).toBe(false);
    expect(out.deleted).toEqual([C]);
    expect(out.errors.map((e) => e.runId)).toEqual(['bad', '../precious', outside, A, B]);
    expect(await readdir(runsDir())).toEqual([A, B]);
    expect(await readdir(outside)).toEqual(['result.json']);
  });
});

describe('mergestory runs delete --older-than', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('deletes old runs and their finished jobs, and keeps new runs and runs still being made', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-17T12:00:00Z'));
    await withResult(A);
    await makeJob(A, 'succeeded');
    await makeJob('20261101-110000-dddd', 'failed'); // its run folder is gone
    await withResult(B);
    await makeJob('20261102-090000-eeee', 'running', B); // B is still being made
    await withResult(C); // made 14 days ago, newer than the cutoff
    const { code, stdout } = await run(['runs', 'delete', '--older-than', '15', '--json']);
    const out = JSON.parse(stdout) as { deleted: string[]; errors: { runId: string }[] };
    expect(code).toBe(2);
    expect(out.deleted).toEqual([A, '20261101-110000-dddd']);
    expect(out.errors.map((e) => e.runId)).toEqual([B]);
    expect(await readdir(runsDir())).toEqual([B, C]);
    expect(await readdir(jobsDir())).toEqual(['20261102-090000-eeee']);
  });

  it('also deletes the job of a run deleted by id', async () => {
    await withResult(A);
    await makeJob(A, 'succeeded');
    expect((await run(['runs', 'delete', A])).code).toBe(0);
    expect(await readdir(jobsDir())).toEqual([]);
  });

  it('wants run ids or --older-than, one of the two', async () => {
    await withResult(A);
    expect((await run(['runs', 'delete'])).code).toBe(2);
    expect((await run(['runs', 'delete', A, '--older-than', '1'])).code).toBe(2);
    expect(await readdir(runsDir())).toEqual([A]);
  });
});
