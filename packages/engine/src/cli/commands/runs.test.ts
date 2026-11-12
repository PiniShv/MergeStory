import { mkdir, readdir, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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
      publish: { provider: 's3', watchUrl: 'https://v.example.com/x', expiresAt: null },
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
