import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MergeStoryError } from '../core/errors.ts';
import type { ValidationIssue } from '../storyboard/index.ts';
import { analyzeMock, dir, generateMock, run, validateMock, workerMock } from '../testing/cli.ts';
import { makePng } from '../testing/png.ts';

vi.mock('../pipeline/index.ts', () => ({
  generate: vi.fn(),
  prepareAuthoring: vi.fn(),
  checkStoryboard: vi.fn(),
}));
vi.mock('../jobs/worker.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../jobs/worker.ts')>()),
  startDetachedWorker: vi.fn(async () => 4242),
}));

describe('generate --async', () => {
  it('creates a job, starts a worker and prints the id', async () => {
    const { code, stdout } = await run(['generate', 'acme/app#1', '--async', '--style', 'product'], {
      ANTHROPIC_API_KEY: 'sk-ant-should-never-reach-a-job-file-0123456789',
    });
    expect(code).toBe(0);
    expect(generateMock).not.toHaveBeenCalled();
    const ids = await readdir(join(dir, 'home', 'jobs'));
    expect(ids).toHaveLength(1);
    const id = ids[0] as string;
    expect(stdout).toContain(`Started job ${id}`);
    expect(stdout).toContain(`mergestory status ${id} --wait`);

    const text = await readFile(join(dir, 'home', 'jobs', id, 'job.json'), 'utf8');
    const job = JSON.parse(text);
    expect(job.status).toBe('queued');
    expect(job.options).toEqual({ source: 'acme/app#1', config: { style: 'product' } });
    // The worker is remembered in its own file, so a worker that dies early is noticed.
    expect(job.pid).toBeNull();
    expect((await readFile(join(dir, 'home', 'jobs', id, 'worker.pid'), 'utf8')).trim()).toBe('4242');
    // Secrets stay in the environment; the worker inherits them from there.
    expect(text).not.toContain('should-never-reach');
    expect(workerMock).toHaveBeenCalledTimes(1);
    const [workerId, options] = workerMock.mock.calls[0] as [
      string,
      { home?: string | null; env?: NodeJS.ProcessEnv },
    ];
    expect(workerId).toBe(id);
    expect(options.home).toBe(join(dir, 'home'));
    expect(options.env?.ANTHROPIC_API_KEY).toBe('sk-ant-should-never-reach-a-job-file-0123456789');
  });

  it('prints JSON with the job id', async () => {
    const { code, stdout } = await run(['generate', 'acme/app#1', '--async', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({
      ok: true,
      id: expect.stringMatching(/^\d{8}-\d{6}-[a-f0-9]{4}$/),
      status: 'queued',
    });
  });

  it('stores absolute paths so the worker does not depend on the working directory', async () => {
    await mkdir(join(dir, 'repo'));
    await writeFile(join(dir, 'shot.png'), makePng(8, 8));
    await run(['generate', 'repo', '--async', '--screenshot', 'shot.png', '--out', 'out']);
    const [id] = await readdir(join(dir, 'home', 'jobs'));
    const job = JSON.parse(await readFile(join(dir, 'home', 'jobs', id as string, 'job.json'), 'utf8'));
    expect(job.options.source).toBe(join(dir, 'repo'));
    expect(job.options.context.screenshots[0].path).toBe(join(dir, 'shot.png'));
    expect(job.options.config.outDir).toBe(join(dir, 'out'));
  });

  it('reports a bad setting at once, without creating a job', async () => {
    const result = await run(['generate', 'acme/app#1', '--async', '--budget', '1000']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('error [CONFIG_INVALID]');
    await expect(readdir(join(dir, 'home', 'jobs'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(workerMock).not.toHaveBeenCalled();
  });

  it('marks the job as failed when the worker cannot be started', async () => {
    workerMock.mockRejectedValueOnce(
      new MergeStoryError('INTERNAL', 'Could not start the background worker: spawn ENOENT'),
    );
    const result = await run(['generate', 'acme/app#1', '--async']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Could not start the background worker');
    const [id] = await readdir(join(dir, 'home', 'jobs'));
    const job = JSON.parse(await readFile(join(dir, 'home', 'jobs', id as string, 'job.json'), 'utf8'));
    expect(job.status).toBe('failed');
    expect(job.error.message).toContain('Could not start');
  });

  it('redacts the message and the hint of that failure and cuts them to a fixed length', async () => {
    const key = `sk-ant-${'Zy9Xw8Vu7Ts6Rq5P'.repeat(2)}`;
    workerMock.mockRejectedValueOnce(
      new MergeStoryError('INTERNAL', `${key} ${'m'.repeat(5000)}`, { hint: `${key} ${'h'.repeat(3000)}` }),
    );
    const result = await run(['generate', 'acme/app#1', '--async']);
    expect(result.code).toBe(1);
    const [id] = await readdir(join(dir, 'home', 'jobs'));
    const job = JSON.parse(await readFile(join(dir, 'home', 'jobs', id as string, 'job.json'), 'utf8'));
    expect(job.status).toBe('failed');
    expect(job.error.message).not.toContain(key);
    expect(job.error.message).toHaveLength(2000);
    expect(job.error.hint).not.toContain(key);
    expect(job.error.hint).toHaveLength(1000);
  });

  it('also works for a dry run', async () => {
    await run(['generate', 'acme/app#1', '--async', '--dry-run']);
    const [id] = await readdir(join(dir, 'home', 'jobs'));
    const job = JSON.parse(await readFile(join(dir, 'home', 'jobs', id as string, 'job.json'), 'utf8'));
    expect(job.options.dryRun).toBe(true);
  });
});

describe('analyze', () => {
  const authoring = {
    runId: 'r3',
    runDir: '/runs/r3',
    files: {
      analysis: '/runs/r3/analysis.json',
      evidence: '/runs/r3/evidence.md',
      guide: '/runs/r3/AUTHORING.md',
      schema: '/runs/r3/storyboard.schema.json',
    },
    summary: {
      title: 'Add retries',
      changeLabel: 'PR #42',
      size: 'm',
      files: 7,
      suggestedDurationSec: 90,
      evidenceItems: 42,
    },
  };

  it('writes the authoring files and explains what to do next', async () => {
    analyzeMock.mockResolvedValue(authoring);
    const { code, stdout } = await run(['analyze', 'acme/app#42', '--task', 'Add retries']);
    expect(code).toBe(0);
    expect(stdout).toContain('Analysis ready: Add retries');
    expect(stdout).toContain('PR #42 (size m, 7 files)');
    expect(stdout).toContain('suggested about 1:30');
    expect(stdout).toContain('42 items');
    for (const path of Object.values(authoring.files)) expect(stdout).toContain(path);
    for (const name of ['analysis.json', 'evidence.md', 'AUTHORING.md', 'storyboard.schema.json'])
      expect(stdout).toContain(name);
    expect(stdout).toContain('mergestory validate /runs/r3/storyboard.json acme/app#42');
    expect(stdout).toContain('mergestory generate acme/app#42 --storyboard /runs/r3/storyboard.json');
    const call = analyzeMock.mock.calls[0]?.[0];
    expect(call?.source).toBe('acme/app#42');
    expect(call?.context).toEqual({ task: 'Add retries' });
    expect(call?.outDir).toBeNull();
  });

  it('passes --out on and keeps refs in the follow-up commands', async () => {
    await mkdir(join(dir, 'repo'));
    analyzeMock.mockResolvedValue(authoring);
    const { stdout } = await run([
      'analyze',
      'repo',
      '--base',
      'main',
      '--head',
      'feature/x',
      '--out',
      'authoring',
    ]);
    const call = analyzeMock.mock.calls[0]?.[0];
    expect(call?.outDir).toBe(join(dir, 'authoring'));
    expect(call?.base).toBe('main');
    expect(stdout).toContain('--base main --head feature/x');
  });

  it('prints JSON with --json', async () => {
    analyzeMock.mockResolvedValue(authoring);
    const { stdout } = await run(['analyze', 'acme/app#42', '--json']);
    expect(JSON.parse(stdout)).toEqual({ ok: true, ...authoring });
  });

  it('quotes a source that needs it', async () => {
    await mkdir(join(dir, 'my repo'));
    analyzeMock.mockResolvedValue(authoring);
    const { stdout } = await run(['analyze', 'my repo']);
    expect(stdout).toContain(`'${join(dir, 'my repo')}'`);
  });
});

describe('validate', () => {
  const issue = (path: string, code: ValidationIssue['code'], message: string): ValidationIssue => ({
    path,
    code,
    message,
  });

  it('prints errors, warnings and fixes, and exits 3 when errors remain', async () => {
    await writeFile(join(dir, 'storyboard.json'), JSON.stringify({ version: 1 }));
    validateMock.mockResolvedValue({
      storyboard: null,
      errors: [
        issue('scenes[2].visual.ref', 'code-ref-out-of-range', 'Lines 90-120 do not exist in src/a.ts'),
      ],
      warnings: [issue('scenes[0].narration[1]', 'unverified-claim', 'No evidence cited')],
      fixes: ['Removed an unknown evidence id'],
      groundedClaims: 4,
    });
    const { code, stdout } = await run([
      'validate',
      'storyboard.json',
      'acme/app#1',
      '--task',
      'Add retries',
    ]);
    expect(code).toBe(3);
    expect(stdout).toContain('Storyboard has errors: 1 to fix');
    expect(stdout).toContain('scenes[2].visual.ref');
    expect(stdout).toContain('[code-ref-out-of-range]');
    expect(stdout).toContain('Lines 90-120 do not exist in src/a.ts');
    expect(stdout).toContain('unverified-claim');
    expect(stdout).toContain('Removed an unknown evidence id');
    const call = validateMock.mock.calls[0]?.[0];
    expect(call?.storyboard).toEqual({ version: 1 });
    expect(call?.source).toBe('acme/app#1');
    expect(call?.context).toEqual({ task: 'Add retries' });
  });

  it('exits 0 for a valid storyboard', async () => {
    await writeFile(join(dir, 'storyboard.json'), '{}');
    validateMock.mockResolvedValue({
      storyboard: null,
      errors: [],
      warnings: [],
      fixes: [],
      groundedClaims: 12,
    });
    const { code, stdout } = await run(['validate', 'storyboard.json']);
    expect(code).toBe(0);
    expect(stdout).toContain('Storyboard is valid: 12 narration lines cite evidence.');
  });

  it('prints JSON with --json', async () => {
    await writeFile(join(dir, 'storyboard.json'), '{}');
    validateMock.mockResolvedValue({
      storyboard: null,
      errors: [issue('x', 'schema', 'wrong')],
      warnings: [],
      fixes: ['f'],
      groundedClaims: 0,
    });
    const { code, stdout } = await run(['validate', 'storyboard.json', '--json']);
    expect(code).toBe(3);
    expect(JSON.parse(stdout)).toEqual({
      ok: false,
      errors: [issue('x', 'schema', 'wrong')],
      warnings: [],
      fixes: ['f'],
      groundedClaims: 0,
    });
  });

  it('exits 3 for a storyboard file that is not JSON', async () => {
    await writeFile(join(dir, 'storyboard.json'), 'not json');
    const { code, stderr } = await run(['validate', 'storyboard.json']);
    expect(code).toBe(3);
    expect(stderr).toContain('storyboard file: storyboard.json is not valid JSON');
    expect(validateMock).not.toHaveBeenCalled();
  });
});

describe('schema', () => {
  it('prints the storyboard JSON Schema', async () => {
    const { code, stdout } = await run(['schema']);
    expect(code).toBe(0);
    const schema = JSON.parse(stdout);
    expect(schema.type).toBe('object');
    expect(schema.properties.scenes).toBeDefined();
  });
});
