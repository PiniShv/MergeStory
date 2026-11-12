import { readdir } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { MergeStoryError } from '../core/errors.ts';
import { createLogger } from '../core/logger.ts';
import type { RunJobOptions } from '../jobs/runner.ts';
import {
  allowedRoot,
  api,
  deadPid,
  finishAtOnce,
  post,
  raw,
  start,
  store,
  waitFor,
} from '../testing/server.ts';
import { MAX_BODY_BYTES } from './index.ts';

vi.mock('../sources/index.ts', async () =>
  (await import('../testing/server-sources.ts')).fakeSourcesModule(),
);

describe('POST /v1/jobs: input checks', () => {
  it('requires a JSON content type', async () => {
    const { base } = await start();
    const res = await api(base, '/v1/jobs', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{"source":"o/r#1"}',
    });
    expect(res.status).toBe(415);
    const none = await api(base, '/v1/jobs', {
      method: 'POST',
      body: '{"source":"o/r#1"}',
      headers: { 'content-type': '' },
    });
    expect(none.status).toBe(415);
    const withCharset = await post(
      base,
      { source: 'o/r#1' },
      { 'content-type': 'application/json; charset=utf-8' },
    );
    expect(withCharset.status).toBe(202);
  });

  it('answers 400 for a body that is not JSON', async () => {
    const { base } = await start();
    const res = await post(base, '{not json');
    expect(res.status).toBe(400);
    expect(res.json.error.message).toMatch(/not valid JSON/);
    expect((await post(base, '')).status).toBe(400);
  });

  it('answers 400 with the zod issues for a body of the wrong shape', async () => {
    const { base } = await start();
    const res = await post(base, { source: 123, base: 5 });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('USAGE');
    const paths = res.json.error.issues.map((i: { path: string }) => i.path);
    expect(paths).toContain('source');
    expect(paths).toContain('base');
    expect((await post(base, [])).status).toBe(400);
    expect((await post(base, null)).status).toBe(400);
    expect((await post(base, {})).status).toBe(400);
  });

  it('rejects unknown keys everywhere', async () => {
    const { base } = await start();
    const cases: Record<string, unknown>[] = [
      { source: 'o/r#1', surprise: true },
      { source: 'o/r#1', context: { task: 't', surprise: 1 } },
      { source: 'o/r#1', options: { surprise: 1 } },
      { source: 'o/r#1', options: { llm: { apiKey: 'sk-should-never-be-accepted' } } },
      { source: 'o/r#1', options: { publish: { s3: { bucket: 'x' } } } },
      { source: 'o/r#1', options: { render: { ffmpegPath: '/bin/sh' } } },
      { source: 'o/r#1', options: { home: '/tmp' } },
      { source: 'o/r#1', options: { outDir: '/tmp' } },
      { source: 'o/r#1', dryRun: true },
    ];
    for (const body of cases) {
      const res = await post(base, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.json.error.issues.length).toBeGreaterThan(0);
    }
    expect(await store.list()).toEqual([]);
  });

  it('does not accept screenshots in v1', async () => {
    const { base } = await start();
    const res = await post(base, {
      source: 'o/r#1',
      context: { screenshots: [{ path: '/etc/passwd', caption: 'x' }] },
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.json.error.issues)).toMatch(/screenshots/);
  });

  it('checks option values and ranges', async () => {
    const { base } = await start();
    const bad: [Record<string, unknown>, string][] = [
      [{ style: 'fancy' }, 'options.style'],
      [{ maxDurationSec: 5 }, 'options.maxDurationSec'],
      [{ targetDurationSec: 1000 }, 'options.targetDurationSec'],
      [{ budgetUsd: 500 }, 'options.budgetUsd'],
      [{ budgetUsd: -1 }, 'options.budgetUsd'],
      [{ language: 'x' }, 'options.language'],
      [{ llm: { provider: 'gemini' } }, 'options.llm.provider'],
      [{ tts: { provider: 'azure' } }, 'options.tts.provider'],
      [{ publish: { visibility: 'world' } }, 'options.publish.visibility'],
      [{ github: { comment: 'yes' } }, 'options.github.comment'],
    ];
    for (const [options, path] of bad) {
      const res = await post(base, { source: 'o/r#1', options });
      expect(res.status, path).toBe(400);
      expect(
        res.json.error.issues.map((i: { path: string }) => i.path),
        path,
      ).toContain(path);
    }
  });

  it('accepts null to mean "use the default" for the optional settings', async () => {
    const { base } = await start();
    const res = await post(base, {
      source: 'o/r#1',
      options: { targetDurationSec: null, llm: { model: null }, tts: { voice: null } },
    });
    expect(res.status).toBe(202);
    expect((await store.read(res.json.id)).options.config).toEqual({
      targetDurationSec: null,
      llm: { model: null },
      tts: { voice: null },
      publish: { provider: 'local' },
    });
  });

  it('keeps refs and sources from being read as options', async () => {
    const { base } = await start();
    for (const body of [
      { source: allowedRoot, base: '--upload-pack=touch /tmp/x' },
      { source: allowedRoot, head: '-x' },
      { source: allowedRoot, base: 'has space' },
      { source: allowedRoot, base: 'line\nbreak' },
      { source: '-rf' },
      { source: '' },
      { source: 'a\u0000b' },
    ]) {
      const res = await post(base, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('POST /v1/jobs: body size', () => {
  it('answers 413 when the declared size is over the limit', async () => {
    const { base } = await start();
    const big = JSON.stringify({ source: 'o/r#1', context: { notes: 'x'.repeat(MAX_BODY_BYTES) } });
    const res = await post(base, big);
    expect(res.status).toBe(413);
    expect(res.json.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect((await api(base, '/v1/health')).status).toBe(200);
  });

  it('answers 413 for a streamed body that grows past the limit', async () => {
    const { server } = await start();
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    const res = await raw(server, {
      method: 'POST',
      path: '/v1/jobs',
      headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
      chunks: Array.from({ length: 8 }, () => chunk),
    });
    expect(res.status).toBe(413);
    expect((await raw(server, { path: '/v1/health' })).status).toBe(200);
  });

  it('answers 400, not 500, for a body that is nested too deeply', async () => {
    const { base } = await start();
    const res = await post(
      base,
      `{"source":"acme/widgets#1","storyboard":{"a":${'['.repeat(100_000)}${']'.repeat(100_000)}}}`,
    );
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('USAGE');
    expect(res.json.error.message).toMatch(/nested more than 64 levels/);
    expect(await store.list()).toEqual([]);
  });

  it('answers 400 for a very long unbroken string, anywhere in the body', async () => {
    const { base } = await start();
    const blob = 'password.'.repeat(200);
    for (const body of [
      { source: 'acme/widgets#1', context: { notes: blob } },
      { source: 'acme/widgets#1', storyboard: { scenes: [{ narration: blob }] } },
      { source: blob },
    ]) {
      const started = Date.now();
      const res = await post(base, body);
      expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(400);
      expect(res.json.error.message).toMatch(/unbroken string of more than 1000/);
      expect(Date.now() - started).toBeLessThan(2000);
    }
    // Escape sequences do not hide it.
    const escaped = `{"source":"acme/widgets#1","context":{"notes":"${'\\u0061'.repeat(1500)}"}}`;
    const hidden = await post(base, escaped);
    expect(hidden.status).toBe(400);
    expect(hidden.json.error.message).toMatch(/unbroken string/);
    expect(await store.list()).toEqual([]);
    const fine = await post(base, {
      source: 'acme/widgets#1',
      context: { notes: `${'a'.repeat(900)} ${'b'.repeat(900)}` },
    });
    expect(fine.status).toBe(202);
  });

  it('accepts a body just under the limit', async () => {
    const { base } = await start();
    const body = JSON.stringify({ source: 'o/r#1', context: { notes: 'word '.repeat(12 * 1024) } });
    expect(Buffer.byteLength(body)).toBeLessThan(MAX_BODY_BYTES);
    expect((await post(base, body)).status).toBe(202);
  });

  it('refuses a bad Content-Length', async () => {
    const { server } = await start();
    const res = await raw(server, {
      method: 'POST',
      path: '/v1/jobs',
      headers: { 'content-type': 'application/json', 'content-length': 'abc' },
    });
    expect([400, 413].includes(res.status)).toBe(true);
  });
});

describe('POST /v1/jobs: creating jobs', () => {
  it('answers 202 and runs the job', async () => {
    const { base } = await start({ configPath: '/etc/mergestory/config.json' });
    const res = await post(base, {
      source: 'acme/widgets#12',
      context: {
        task: 'Add retries',
        notes: 'Backoff with jitter',
        tests: [{ command: 'npm test', passed: true, summary: '42 passed' }],
      },
      options: {
        style: 'product',
        maxDurationSec: 90,
        llm: { provider: 'anthropic', model: 'claude-haiku-5-5' },
        publish: { visibility: 'private' },
        github: { comment: true },
      },
      storyboard: { version: 1, scenes: [] },
    });
    expect(res.status).toBe(202);
    expect(res.json).toEqual({ id: expect.stringMatching(/^\d{8}-\d{6}-[a-f0-9]{4}$/), status: 'queued' });
    expect(res.headers.get('location')).toBe(`/v1/jobs/${res.json.id}`);

    await waitFor(() => finishAtOnce.mock.calls.some(([id]) => id === res.json.id));
    const [, runOptions] = finishAtOnce.mock.calls.find(([id]) => id === res.json.id) as [
      string,
      RunJobOptions,
    ];
    expect(runOptions.store).toBe(store);
    expect(runOptions.signal).toBeInstanceOf(AbortSignal);

    const stored = await store.read(res.json.id);
    expect(stored.options).toEqual({
      source: { kind: 'github', url: 'acme/widgets#12' },
      context: {
        task: 'Add retries',
        notes: 'Backoff with jitter',
        tests: [{ command: 'npm test', passed: true, summary: '42 passed', source: 'agent' }],
      },
      storyboard: { version: 1, scenes: [] },
      config: {
        style: 'product',
        maxDurationSec: 90,
        llm: { provider: 'anthropic', model: 'claude-haiku-5-5' },
        // The provider is fixed when the job is accepted (here the settings file cannot be read yet).
        publish: { visibility: 'private', provider: 'local' },
        github: { comment: true },
      },
      configPath: '/etc/mergestory/config.json',
    });
  });

  it('lets a job be read back once it has finished', async () => {
    const { base } = await start();
    const created = await post(base, { source: 'acme/widgets#12' });
    await waitFor(async () => (await store.read(created.json.id)).status === 'succeeded');
    const res = await api(base, `/v1/jobs/${created.json.id}`);
    expect(res.status).toBe(200);
    expect(res.json.id).toBe(created.json.id);
    expect(res.json.status).toBe('succeeded');
    expect(res.json.result.title).toBe('Add retries');
    expect(res.json.pid).toBeUndefined();
  });

  it('masks secret-like values in the context before storing them', async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'warn', write: (line) => lines.push(line) });
    const { base } = await start({ logger });
    const key = `sk-ant-${'Qw3Er5Ty7Ui9Op1A'.repeat(2)}`;
    const res = await post(base, {
      source: 'acme/widgets#12',
      context: {
        task: `use the key ${key} to call the API`,
        tests: [{ command: `API_KEY=${key} npm test`, passed: false, summary: `failed with ${key}` }],
      },
    });
    expect(res.status).toBe(202);
    const stored = JSON.stringify(await store.read(res.json.id));
    expect(stored).not.toContain(key);
    expect(lines.join('\n')).toMatch(/Masked \d+ secret-like value/);
    expect(lines.join('\n')).not.toContain(key);
  });

  it('runs jobs one at a time, in order', async () => {
    const started: string[] = [];
    const releases: (() => void)[] = [];
    const slow = vi.fn(async (jobId: string, options: RunJobOptions) => {
      started.push(jobId);
      await new Promise<void>((release) => releases.push(release));
      await finishAtOnce(jobId, options);
    });
    const { base } = await start({ runJob: slow });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await post(base, { source: 'acme/widgets#12' })).json.id);
    await waitFor(() => started.length === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(started).toEqual([ids[0]]);
    releases[0]?.();
    await waitFor(() => started.length === 2);
    expect(started).toEqual([ids[0], ids[1]]);
    releases[1]?.();
    await waitFor(() => started.length === 3);
    releases[2]?.();
    await waitFor(async () => (await store.read(ids[2] as string)).status === 'succeeded');
    expect(started).toEqual(ids);
  });

  it('answers 503 when too many jobs are waiting, and creates nothing for the refused one', async () => {
    const releases: (() => void)[] = [];
    const slow = vi.fn(async (jobId: string, options: RunJobOptions) => {
      await new Promise<void>((release) => releases.push(release));
      await finishAtOnce(jobId, options);
    });
    const { base } = await start({ runJob: slow, maxQueued: 1 });
    expect((await post(base, { source: 'acme/widgets#1' })).status).toBe(202); // running
    await waitFor(() => releases.length === 1);
    expect((await post(base, { source: 'acme/widgets#2' })).status).toBe(202); // waiting
    const refused = await post(base, { source: 'acme/widgets#3' });
    expect(refused.status).toBe(503);
    expect(refused.json.error.code).toBe('QUEUE_FULL');
    expect(refused.headers.get('retry-after')).toBe('60');
    expect(await store.list()).toHaveLength(2);
    for (const release of releases) release();
    releases[0]?.();
  });

  it('marks a job as failed when the runner itself breaks', async () => {
    const broken = vi.fn(async () => {
      throw new MergeStoryError('INTERNAL', 'runner exploded');
    });
    const { base } = await start({ runJob: broken });
    const created = await post(base, { source: 'acme/widgets#12' });
    await waitFor(async () => (await store.read(created.json.id)).status === 'failed');
    const job = await store.read(created.json.id);
    expect(job.error?.message).toBe('runner exploded');
  });

  it('redacts the message and the hint of a broken run and cuts them to a fixed length', async () => {
    const key = `sk-ant-${'Zy9Xw8Vu7Ts6Rq5P'.repeat(2)}`;
    const broken = vi.fn(async () => {
      throw new MergeStoryError('INTERNAL', `${key} ${'m'.repeat(5000)}`, {
        hint: `${key} ${'h'.repeat(3000)}`,
      });
    });
    const { base } = await start({ runJob: broken });
    const created = await post(base, { source: 'acme/widgets#12' });
    await waitFor(async () => (await store.read(created.json.id)).status === 'failed');
    const job = await store.read(created.json.id);
    expect(job.error?.message).not.toContain(key);
    expect(job.error?.message).toHaveLength(2000);
    expect(job.error?.hint).not.toContain(key);
    expect(job.error?.hint).toHaveLength(1000);
  });

  it('owns every job it queues, also while the job waits for its turn', async () => {
    // The first job holds the queue until the server shuts down.
    const hold = vi.fn(
      (_jobId: string, options: RunJobOptions) =>
        new Promise<void>((resolveRun) =>
          options.signal?.addEventListener('abort', () => resolveRun(), { once: true }),
        ),
    );
    const { base } = await start({ runJob: hold });
    expect((await post(base, { source: 'acme/widgets#1' })).status).toBe(202); // running
    await waitFor(() => hold.mock.calls.length === 1);
    const waiting = await post(base, { source: 'acme/widgets#2' });
    const stored = await store.read(waiting.json.id);
    expect(stored.status).toBe('queued');
    expect(stored.pid).toBe(process.pid);
  });

  it('fails the job and answers 503 when the server shuts down while the job is being created', async () => {
    const { base, server } = await start();
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolveGate) => {
      open = resolveGate;
    });
    const create = store.create.bind(store);
    const spy = vi.spyOn(store, 'create').mockImplementationOnce(async (...args) => {
      await gate;
      return create(...args);
    });
    const pending = post(base, { source: 'acme/widgets#12' });
    await waitFor(() => spy.mock.calls.length === 1);
    const closing = server.close();
    open();
    const res = await pending;
    await closing;
    expect(res.status).toBe(503);
    expect(res.json.error.code).toBe('QUEUE_FULL');
    const [job] = await store.list();
    expect(job?.status).toBe('failed');
    expect(job?.error).toEqual({
      code: 'ABORTED',
      message: 'The server could not accept this job.',
      hint: null,
    });
  });
});

describe('GET /v1/jobs and /v1/jobs/:id', () => {
  it('returns a redacted view of one job', async () => {
    const { base } = await start();
    const secret = `sk-ant-${'Zx9Cv8Bn7Mm6Lk5J'.repeat(2)}`;
    const job = await store.create({
      source: { kind: 'github', url: 'acme/widgets#1' },
      storyboard: { big: 'x'.repeat(5000) },
    });
    await store.update(job.id, (j) => {
      j.status = 'running';
      j.pid = process.pid;
    });
    await store.update(job.id, (j) => {
      j.status = 'failed';
      j.error = { code: 'LLM_FAILED', message: `bad key ${secret}`, hint: null };
    });
    const res = await api(base, `/v1/jobs/${job.id}`);
    expect(res.status).toBe(200);
    expect(res.json.status).toBe('failed');
    expect(res.json.pid).toBeUndefined();
    expect(res.json.options.storyboard).toBe('[provided]');
    expect(JSON.stringify(res.json)).not.toContain(secret);
    expect(JSON.stringify(res.json)).not.toContain('xxxxx');
  });

  it('fails the jobs that an earlier server with the same pid left queued', async () => {
    // Process 1 in a restarted container gets the same pid again, so the pid alone looks alive.
    const beforeStart = new Date(Date.now() - process.uptime() * 1000 - 60_000);
    const left = await store.create({ source: '.' }, { pid: process.pid, now: beforeStart });
    const { base } = await start();
    const res = await api(base, `/v1/jobs/${left.id}`);
    expect(res.status).toBe(200);
    expect(res.json.status).toBe('failed');
    expect(res.json.error.message).toBe('The worker process ended before the job finished.');
  });

  it('reports a job that a dead server left queued as failed', async () => {
    const { base } = await start();
    const left = await store.create({ source: 'acme/widgets#1' }, { pid: deadPid() });
    const one = await api(base, `/v1/jobs/${left.id}`);
    expect(one.status).toBe(200);
    expect(one.json.status).toBe('failed');
    expect(one.json.error.message).toMatch(/worker process ended/);
    const list = await api(base, '/v1/jobs');
    expect(list.json.jobs.map((j: { status: string }) => j.status)).toEqual(['failed']);
  });

  it('answers 404 for a job that does not exist', async () => {
    const { base } = await start();
    const res = await api(base, '/v1/jobs/20261103-214501-a3f9');
    expect(res.status).toBe(404);
    expect(res.json.error.code).toBe('JOB_NOT_FOUND');
  });

  it('lists recent jobs, newest first, without bulky fields', async () => {
    const { base } = await start();
    const a = await store.create(
      { source: 'a', storyboard: { x: 1 } },
      { now: new Date('2026-11-01T10:00:00Z') },
    );
    const b = await store.create({ source: 'b' }, { now: new Date('2026-11-02T10:00:00Z') });
    const res = await api(base, '/v1/jobs');
    expect(res.status).toBe(200);
    expect(res.json.jobs.map((j: { id: string }) => j.id)).toEqual([b.id, a.id]);
    expect(Object.keys(res.json.jobs[0]).sort()).toEqual([
      'createdAt',
      'error',
      'id',
      'progress',
      'status',
      'title',
      'updatedAt',
    ]);
    const one = await api(base, '/v1/jobs?limit=1');
    expect(one.json.jobs).toHaveLength(1);
    const junk = await api(base, '/v1/jobs?limit=abc');
    expect(junk.json.jobs).toHaveLength(2);
  });
});

// Keeps the directory listing helper used (a stray temp file would show up here).
it('leaves no temporary files in the jobs directory', async () => {
  const { base } = await start();
  const created = await post(base, { source: 'acme/widgets#12' });
  await waitFor(async () => (await store.read(created.json.id)).status === 'succeeded');
  expect(await readdir(store.jobDir(created.json.id))).toEqual(['job.json']);
});

describe('POST /v1/jobs: the publish provider', () => {
  it("never uses the operator's YouTube or Google Drive sign-in, also not as a default", async () => {
    vi.stubEnv('MERGESTORY_PUBLISH_PROVIDER', 'drive');
    try {
      const { base } = await start();
      const refused = await post(base, { source: 'o/r#1' });
      expect(refused.status).toBe(403);
      expect(refused.json.error.message).toContain('never uses');
      // Naming a provider the API allows works, and the job keeps it.
      const accepted = await post(base, { source: 'o/r#1', options: { publish: { provider: 'local' } } });
      expect(accepted.status).toBe(202);
      expect((await store.read(accepted.json.id))?.options.config?.publish?.provider).toBe('local');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('writes the default provider into the job, so a later change of the environment cannot switch it', async () => {
    const { base } = await start();
    const res = await post(base, { source: 'o/r#1' });
    expect(res.status).toBe(202);
    expect((await store.read(res.json.id))?.options.config?.publish?.provider).toBe('local');
  });
});
