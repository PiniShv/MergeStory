import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MergeStoryError } from '../core/errors.ts';
import type { GenerateResult } from '../core/types.ts';
import { type DoctorReport, runDoctor } from '../doctor/index.ts';
import { JobStore } from '../jobs/store.ts';
import { setupKokoro } from '../narration/index.ts';
import { generate } from '../pipeline/index.ts';
import { startServer } from '../server/index.ts';
import { runCli } from './program.ts';

vi.mock('../pipeline/index.ts', () => ({
  generate: vi.fn(),
  prepareAuthoring: vi.fn(),
  checkStoryboard: vi.fn(),
}));
vi.mock('../narration/index.ts', () => ({ setupKokoro: vi.fn(), kokoroStatus: vi.fn() }));
vi.mock('../server/index.ts', () => ({ startServer: vi.fn() }));
vi.mock('../doctor/index.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../doctor/index.ts')>()),
  runDoctor: vi.fn(),
}));

const generateMock = vi.mocked(generate);
const installMock = vi.mocked(setupKokoro);
const serverMock = vi.mocked(startServer);
const doctorMock = vi.mocked(runDoctor);

let dir: string;
let store: JobStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mergestory-cmd-'));
  store = new JobStore(join(dir, 'home', 'jobs'));
  for (const mock of [generateMock, installMock, serverMock, doctorMock]) mock.mockReset();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function run(argv: string[], env: Record<string, string> = {}) {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    env: { MERGESTORY_HOME: join(dir, 'home'), ...env },
    cwd: dir,
    handleSignals: false,
    stdoutIsTty: false,
    stderrIsTty: false,
  });
  return { code, stdout, stderr };
}

function fakeResult(): GenerateResult {
  return {
    ok: true,
    runId: 'r1',
    runDir: '/runs/r1',
    title: 'Add retries',
    summary: 's',
    durationSec: 60,
    chapters: [{ title: 'Mission', startSec: 0 }],
    storyboardSource: 'heuristic',
    files: { video: '/runs/r1/video.mp4', poster: 'p', captions: 'c', storyboard: 's', watchPage: 'w' },
    publish: null,
    notify: null,
    grounding: { groundedClaims: 3, fixes: [], warnings: [] },
    cost: { totalUsd: 0, budgetUsd: 0.25, records: [] },
    egress: [],
    warnings: [],
  };
}

describe('doctor', () => {
  const report = (overrides: Partial<DoctorReport> = {}): DoctorReport => ({
    ok: true,
    version: '1.0.0',
    summary: { pass: 2, warn: 1, fail: 0 },
    checks: [
      { id: 'node', name: 'Node.js', status: 'pass', detail: 'v24.0.0', fix: null },
      { id: 'git', name: 'git', status: 'pass', detail: 'git version 2.50', fix: null },
      { id: 'github', name: 'GitHub access', status: 'warn', detail: 'no token', fix: 'Set GITHUB_TOKEN' },
    ],
    ...overrides,
  });

  it('prints the checks with a fix for each problem and exits 0 when nothing failed', async () => {
    doctorMock.mockResolvedValue(report());
    const { code, stdout } = await run(['doctor']);
    expect(code).toBe(0);
    expect(stdout).toContain('Node.js');
    expect(stdout).toContain('warn');
    expect(stdout).toContain('fix: Set GITHUB_TOKEN');
    expect(stdout).toContain('2 passed, 1 warning, 0 failed.');
  });

  it('exits 1 when a check failed', async () => {
    doctorMock.mockResolvedValue(
      report({
        ok: false,
        summary: { pass: 1, warn: 0, fail: 1 },
        checks: [
          { id: 'ffmpeg', name: 'ffmpeg', status: 'fail', detail: 'not found', fix: 'brew install ffmpeg' },
        ],
      }),
    );
    const { code, stdout } = await run(['doctor']);
    expect(code).toBe(1);
    expect(stdout).toContain('FAIL');
    expect(stdout).toContain('brew install ffmpeg');
  });

  it('prints the report as JSON with --json', async () => {
    doctorMock.mockResolvedValue(report());
    const { code, stdout } = await run(['doctor', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual(report());
  });

  it('still runs when the config file is broken, and reports it', async () => {
    doctorMock.mockResolvedValue(report());
    await writeFile(join(dir, 'broken.json'), '{not json');
    const { code } = await run(['doctor', '--config', 'broken.json']);
    expect(code).toBe(0);
    const options = doctorMock.mock.calls[0]?.[0];
    expect(options?.configError?.message).toContain('not valid JSON');
    expect(options?.config.llm.provider).toBe('none');
  });
});

describe('setup', () => {
  it('lists what can be set up', async () => {
    const { code, stdout } = await run(['setup']);
    expect(code).toBe(0);
    expect(stdout).toContain('mergestory setup kokoro');
    expect(stdout).toContain('400 MB');
  });

  it('lists the targets as JSON', async () => {
    const { stdout } = await run(['setup', '--json']);
    expect(JSON.parse(stdout).targets[0].name).toBe('kokoro');
  });

  it('explains the size and the first-use download, then installs Kokoro', async () => {
    installMock.mockResolvedValue({
      installed: true,
      location: join(dir, 'home', 'plugins', 'kokoro'),
      version: '1.2.1',
      modelCached: false,
    });
    const { code, stdout } = await run(['setup', 'kokoro']);
    expect(code).toBe(0);
    expect(stdout).toContain('about 400 MB');
    expect(stdout).toContain('downloads from huggingface.co the first time');
    expect(stdout).toContain('Kokoro 1.2.1 is installed at');
    expect(stdout).toContain('not downloaded yet');
    expect(installMock).toHaveBeenCalledTimes(1);
    const ctx = installMock.mock.calls[0]?.[0];
    expect(ctx?.home.home).toBe(join(dir, 'home'));
    expect(ctx?.signal).toBeInstanceOf(AbortSignal);
  });

  it('prints JSON only with --json', async () => {
    const status = { installed: true, location: '/x', version: '1.2.1', modelCached: true };
    installMock.mockResolvedValue(status);
    const { stdout } = await run(['setup', 'kokoro', '--json']);
    expect(JSON.parse(stdout)).toEqual({ ok: true, kokoro: status });
  });

  it('rejects an unknown target', async () => {
    const { code, stderr } = await run(['setup', 'whisper']);
    expect(code).toBe(2);
    expect(stderr).toContain('Unknown setup target');
    expect(stderr).toContain('kokoro');
    expect(installMock).not.toHaveBeenCalled();
  });

  it('passes an install failure on with its exit code', async () => {
    installMock.mockRejectedValue(
      new MergeStoryError('TTS_FAILED', 'npm install failed', { hint: 'Check your network.' }),
    );
    const { code, stderr } = await run(['setup', 'kokoro']);
    expect(code).toBe(5);
    expect(stderr).toContain('error [TTS_FAILED]: npm install failed');
  });
});

describe('status and jobs', () => {
  async function jobWith(patch: (job: import('../jobs/model.ts').Job) => void, ...steps: (typeof patch)[]) {
    const job = await store.create({ source: 'acme/app#1' });
    for (const step of [patch, ...steps]) await store.update(job.id, step);
    return job.id;
  }

  const running = (job: import('../jobs/model.ts').Job): void => {
    job.status = 'running';
    job.pid = process.pid;
    job.startedAt = new Date().toISOString();
    job.progress = { stage: 'render', message: 'Rendering frames', progress: 0.45 };
  };

  it('shows a running job', async () => {
    const id = await jobWith(running);
    const { code, stdout } = await run(['status', id]);
    expect(code).toBe(0);
    expect(stdout).toContain(`Job ${id}: running`);
    expect(stdout).toContain('render 45%');
    expect(stdout).toContain('Rendering frames');
  });

  it('shows a finished job with its result', async () => {
    const id = await jobWith(running, (job) => {
      job.status = 'succeeded';
      job.finishedAt = new Date().toISOString();
      job.result = fakeResult();
    });
    const { code, stdout } = await run(['status', id]);
    expect(code).toBe(0);
    expect(stdout).toContain('succeeded');
    expect(stdout).toContain('Video ready: Add retries');
    expect(stdout).toContain('/runs/r1/video.mp4');
  });

  it('exits with the exit code of the error for a failed job', async () => {
    const id = await jobWith(running, (job) => {
      job.status = 'failed';
      job.error = { code: 'BUDGET_EXCEEDED', message: 'Too expensive.', hint: 'Raise --budget.' };
    });
    const { code, stdout } = await run(['status', id]);
    expect(code).toBe(4);
    expect(stdout).toContain('[BUDGET_EXCEEDED] Too expensive.');
    expect(stdout).toContain('Raise --budget.');
  });

  it('prints the redacted job as JSON', async () => {
    const id = await jobWith(running);
    const { stdout } = await run(['status', id, '--json']);
    const job = JSON.parse(stdout);
    expect(job.id).toBe(id);
    expect(job.status).toBe('running');
    expect(job.progress.stage).toBe('render');
    expect(job.pid).toBeUndefined();
  });

  it('reports an unknown or malformed id with exit code 2', async () => {
    const unknown = await run(['status', '20261103-214501-a3f9']);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('error [JOB_NOT_FOUND]');
    const bad = await run(['status', '../../etc/passwd', '--json']);
    expect(bad.code).toBe(2);
    expect(JSON.parse(bad.stdout).error.code).toBe('JOB_NOT_FOUND');
  });

  it('notices a job whose worker has died', async () => {
    const id = await jobWith((job) => {
      job.status = 'running';
      job.pid = 2_147_483_000;
    });
    const { code, stdout } = await run(['status', id]);
    expect(code).toBe(1);
    expect(stdout).toContain('failed');
    expect(stdout).toContain('worker process ended');
  });

  it('waits for the job to finish with --wait', async () => {
    const id = await jobWith(running);
    setTimeout(() => {
      void store.update(id, (job) => {
        job.status = 'succeeded';
        job.result = fakeResult();
      });
    }, 150);
    const { code, stdout, stderr } = await run(['status', id, '--wait']);
    expect(code).toBe(0);
    expect(stdout).toContain('succeeded');
    expect(stderr).toContain('[render] Rendering frames');
  });

  it('gives up waiting after --timeout and says the job keeps running', async () => {
    const id = await jobWith(running);
    const { code, stderr } = await run(['status', id, '--wait', '--timeout', '1']);
    expect(code).toBe(1);
    expect(stderr).toContain('still running after 1 seconds');
    expect(stderr).toContain(`mergestory status ${id} --wait`);
  });

  it('lists recent jobs, newest first', async () => {
    const first = await store.create({ source: 'a' }, { now: new Date('2026-11-01T10:00:00Z') });
    await store.update(first.id, (job) => {
      job.status = 'running';
      job.pid = process.pid;
    });
    await store.update(first.id, (job) => {
      job.status = 'succeeded';
      job.result = fakeResult();
    });
    const second = await store.create({ source: 'b' }, { now: new Date('2026-11-02T10:00:00Z') });
    await store.update(second.id, (job) => {
      job.status = 'failed';
      job.error = { code: 'LLM_FAILED', message: 'The model refused.', hint: null };
    });
    const { code, stdout } = await run(['jobs']);
    expect(code).toBe(0);
    const lines = stdout.trim().split('\n');
    expect(lines[0]).toContain('STATUS');
    expect(lines[1]).toContain(second.id);
    expect(lines[1]).toContain('[LLM_FAILED] The model refused.');
    expect(lines[2]).toContain(first.id);
    expect(lines[2]).toContain('Add retries');
  });

  it('lists jobs as JSON and respects --limit', async () => {
    await store.create({ source: 'a' }, { now: new Date('2026-11-01T10:00:00Z') });
    const second = await store.create({ source: 'b' }, { now: new Date('2026-11-02T10:00:00Z') });
    const { stdout } = await run(['jobs', '--json', '--limit', '1']);
    const parsed = JSON.parse(stdout);
    expect(parsed.jobs).toHaveLength(1);
    expect(parsed.jobs[0].id).toBe(second.id);
    expect(parsed.jobs[0].options).toBeUndefined();
  });

  it('refuses a --limit above 200 instead of cutting it', async () => {
    const { code, stderr } = await run(['jobs', '--limit', '500']);
    expect(code).toBe(2);
    expect(stderr).toContain('Must be at most 200.');
  });

  it('says so when there are no jobs', async () => {
    const { code, stdout } = await run(['jobs']);
    expect(code).toBe(0);
    expect(stdout).toContain('No jobs yet');
  });
});

describe('worker (hidden)', () => {
  it('runs a queued job to the end', async () => {
    const job = await store.create({ source: 'acme/app#1', config: { style: 'product' } });
    generateMock.mockResolvedValue(fakeResult());
    const { code, stdout, stderr } = await run(['worker', job.id]);
    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toBe('');
    expect((await store.read(job.id)).status).toBe('succeeded');
    expect(generateMock.mock.calls[0]?.[0].config).toEqual({ style: 'product' });
  });

  it('records a failure on the job and exits with its code', async () => {
    const job = await store.create({ source: 'acme/app#1' });
    generateMock.mockRejectedValue(new MergeStoryError('BUDGET_EXCEEDED', 'Too expensive.'));
    const { code } = await run(['worker', job.id]);
    expect(code).toBe(4);
    const stored = await store.read(job.id);
    expect(stored.status).toBe('failed');
    expect(stored.error?.code).toBe('BUDGET_EXCEEDED');
  });

  it('refuses a job that already ran', async () => {
    const job = await store.create({ source: 'acme/app#1' });
    generateMock.mockResolvedValue(fakeResult());
    await run(['worker', job.id]);
    const again = await run(['worker', job.id]);
    expect(again.code).toBe(2);
    expect(again.stderr).toContain('already succeeded');
  });

  it('is not listed in the help', async () => {
    const { stdout } = await run(['--help']);
    expect(stdout).not.toMatch(/\bworker\b/);
  });
});

describe('cache clear', () => {
  it('removes the cached data and nothing else', async () => {
    const cache = join(dir, 'home', 'cache');
    for (const namespace of ['tts', 'llm', 'files']) {
      await mkdir(join(cache, namespace, 'ab'), { recursive: true });
      await writeFile(join(cache, namespace, 'ab', 'entry'), 'data');
    }
    await mkdir(join(cache, 'unrelated'));
    await writeFile(join(cache, 'unrelated', 'keep.txt'), 'mine');
    await mkdir(join(dir, 'home', 'runs', 'r1'), { recursive: true });
    await writeFile(join(dir, 'home', 'runs', 'r1', 'video.mp4'), 'video');

    const { code, stdout } = await run(['cache', 'clear']);
    expect(code).toBe(0);
    expect(stdout).toContain(`Cache cleared: ${cache}`);
    expect(await readdir(cache)).toEqual(['unrelated']);
    expect((await stat(join(dir, 'home', 'runs', 'r1', 'video.mp4'))).isFile()).toBe(true);
  });

  it('says so when the cache is empty and prints JSON on request', async () => {
    const empty = await run(['cache', 'clear']);
    expect(empty.stdout).toContain('already empty');
    await mkdir(join(dir, 'home', 'cache', 'tts'), { recursive: true });
    const json = await run(['cache', 'clear', '--json']);
    expect(JSON.parse(json.stdout)).toEqual({ ok: true, path: join(dir, 'home', 'cache'), cleared: ['tts'] });
  });
});

describe('serve', () => {
  const handle = (): Awaited<ReturnType<typeof startServer>> => ({
    host: '127.0.0.1',
    port: 7171,
    url: 'http://127.0.0.1:7171',
    closed: Promise.resolve(),
    close: vi.fn(async () => {}),
  });

  it('starts the API on loopback with the documented defaults', async () => {
    serverMock.mockResolvedValue(handle());
    const { code, stdout } = await run(['serve']);
    expect(code).toBe(0);
    const options = serverMock.mock.calls[0]?.[0];
    expect(options?.host).toBe('127.0.0.1');
    expect(options?.port).toBe(7171);
    expect(options?.token).toBeNull();
    expect(options?.allowRoots).toEqual([]);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.home).toBe(join(dir, 'home'));
    expect(stdout).toContain('listening on http://127.0.0.1:7171');
    expect(stdout).toContain('No token');
    expect(stdout).toContain('Pull requests only');
  });

  it('reads the token from the named environment variable, never from the command line', async () => {
    serverMock.mockResolvedValue(handle());
    const { stdout } = await run(['serve', '--token-env', 'MY_API_TOKEN'], {
      MY_API_TOKEN: 'a-long-random-token-0123456789',
    });
    expect(serverMock.mock.calls[0]?.[0]?.token).toBe('a-long-random-token-0123456789');
    expect(stdout).not.toContain('a-long-random-token');
    const fromDefault = await run(['serve'], { MERGESTORY_API_TOKEN: 'default-token-0123456789' });
    expect(serverMock.mock.calls[1]?.[0]?.token).toBe('default-token-0123456789');
    expect(fromDefault.stdout).not.toContain('default-token');
  });

  it('refuses a token given where a variable name belongs, without repeating it', async () => {
    const token = `sk-ant-${'Ab3De5Gh7Jk9Mn1P'.repeat(2)}`;
    const { code, stderr } = await run(['serve', '--token-env', token]);
    expect(code).toBe(2);
    expect(stderr).toContain('name of an environment variable');
    expect(stderr).not.toContain(token);
    expect(serverMock).not.toHaveBeenCalled();
  });

  it('passes host, port and allowed roots on, resolving roots from the working directory', async () => {
    serverMock.mockResolvedValue(handle());
    await mkdir(join(dir, 'repos'));
    const { stdout } = await run(
      ['serve', '--host', '0.0.0.0', '--port', '8080', '--allow-root', 'repos', '--allow-root', '/srv/more'],
      { MERGESTORY_API_TOKEN: 'a-long-random-token-0123456789' },
    );
    const options = serverMock.mock.calls[0]?.[0];
    expect(options?.host).toBe('0.0.0.0');
    expect(options?.port).toBe(8080);
    expect(options?.allowRoots).toEqual([resolve(dir, 'repos'), '/srv/more']);
    expect(stdout).toContain('Authorization: Bearer');
    expect(stdout).toContain('MERGESTORY_API_TOKEN');
  });

  it('passes the extra Host names on, and none without the flag', async () => {
    serverMock.mockResolvedValue(handle());
    const { stdout } = await run([
      'serve',
      '--allow-host',
      'proxy.internal',
      '--allow-host',
      'api.example.com',
    ]);
    expect(serverMock.mock.calls[0]?.[0]?.allowedHosts).toEqual(['proxy.internal', 'api.example.com']);
    expect(stdout).toContain('proxy.internal, api.example.com');
    await run(['serve']);
    expect(serverMock.mock.calls[1]?.[0]?.allowedHosts).toEqual([]);
  });

  it('passes on the refusal to listen without a token', async () => {
    serverMock.mockRejectedValue(
      new MergeStoryError('CONFIG_INVALID', 'Refusing to listen on 0.0.0.0 without an API token.', {
        hint: 'Set MERGESTORY_API_TOKEN',
      }),
    );
    const { code, stderr } = await run(['serve', '--host', '0.0.0.0']);
    expect(code).toBe(2);
    expect(stderr).toContain('error [CONFIG_INVALID]: Refusing to listen on 0.0.0.0 without an API token.');
  });

  it('rejects an invalid port', async () => {
    expect((await run(['serve', '--port', '99999'])).code).toBe(2);
    expect((await run(['serve', '--port', 'http'])).code).toBe(2);
    expect(serverMock).not.toHaveBeenCalled();
  });

  it('prints one JSON document with --json', async () => {
    serverMock.mockResolvedValue(handle());
    const { stdout } = await run(['serve', '--json']);
    expect(stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      url: 'http://127.0.0.1:7171',
      host: '127.0.0.1',
      port: 7171,
      auth: false,
      allowRoots: [],
    });
  });
});
