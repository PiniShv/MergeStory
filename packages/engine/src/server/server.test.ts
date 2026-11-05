import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MergeStoryError } from '../core/errors.ts';
import type { RunJobOptions } from '../jobs/runner.ts';
import type { JobStore } from '../jobs/store.ts';
import { api, dir, keepOpen, post, raw, start, store, waitFor } from '../testing/server.ts';
import { allowedHostNames, createAuthenticator, hostHeaderAllowed } from './auth.ts';
import { startServer } from './index.ts';
import { JobQueue } from './queue.ts';

vi.mock('../sources/index.ts', async () =>
  (await import('../testing/server-sources.ts')).fakeSourcesModule(),
);

describe('GET /v1/health', () => {
  it('answers with the version and no CORS headers', async () => {
    const { base } = await start();
    const res = await api(base, '/v1/health');
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect([...res.headers.keys()].filter((k) => k.startsWith('access-control-'))).toEqual([]);
  });
});

describe('authentication', () => {
  const token = 'a-long-random-api-token-1234567890';

  it('requires the token on every request when one is set', async () => {
    const { base } = await start({ token });
    for (const path of ['/v1/health', '/v1/jobs', '/v1/jobs/20261103-214501-a3f9', '/no/such/route']) {
      const res = await api(base, path);
      expect(res.status, path).toBe(401);
      expect(res.json.error.code).toBe('UNAUTHORIZED');
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
    }
    const created = await post(base, { source: 'o/r#1' });
    expect(created.status).toBe(401);
    expect(await store.list()).toEqual([]);
  });

  it('rejects a wrong token, a wrong scheme and a token in the URL', async () => {
    const { base } = await start({ token });
    expect((await api(base, '/v1/health', { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
    expect((await api(base, '/v1/health', { headers: { authorization: `Basic ${token}` } })).status).toBe(
      401,
    );
    expect((await api(base, '/v1/health', { headers: { authorization: token } })).status).toBe(401);
    expect((await api(base, `/v1/health?token=${token}`)).status).toBe(401);
    expect((await api(base, '/v1/health', { headers: { authorization: `Bearer ${token}x` } })).status).toBe(
      401,
    );
    expect(
      (await api(base, '/v1/health', { headers: { authorization: `Bearer ${token.slice(1)}` } })).status,
    ).toBe(401);
  });

  it('accepts the right token', async () => {
    const { base } = await start({ token });
    const res = await api(base, '/v1/health', { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const lower = await api(base, '/v1/health', { headers: { authorization: `bearer ${token}` } });
    expect(lower.status).toBe(200);
  });

  it('never repeats the token in a response', async () => {
    const { base } = await start({ token });
    const res = await fetch(`${base}/v1/health`, { headers: { authorization: 'Bearer wrong-token-value' } });
    const text = await res.text();
    expect(text).not.toContain('wrong-token-value');
    expect(text).not.toContain(token);
  });

  it('compares tokens without regard to their length', () => {
    const auth = createAuthenticator('secret-token-0123456789');
    expect(auth.check('Bearer secret-token-0123456789')).toBe(true);
    expect(auth.check('Bearer secret-token-012345678')).toBe(false);
    expect(auth.check('Bearer ')).toBe(false);
    expect(auth.check(undefined)).toBe(false);
    expect(auth.check('Bearer a b')).toBe(false);
  });
});

describe('startup rules', () => {
  it('refuses a network address without a token', async () => {
    for (const host of ['0.0.0.0', '::', '192.168.1.5']) {
      const error = await startServer({ host, port: 0, store }).catch((e: unknown) => e);
      expect(error, host).toBeInstanceOf(MergeStoryError);
      expect((error as MergeStoryError).code).toBe('CONFIG_INVALID');
      expect((error as MergeStoryError).hint).toContain('MERGESTORY_API_TOKEN');
    }
  });

  it('refuses a weak token on a network address', async () => {
    const error = await startServer({ host: '0.0.0.0', port: 0, store, token: 'short' }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: 'CONFIG_INVALID' });
    expect((error as MergeStoryError).hint).toContain('openssl rand');
  });

  it('refuses a weak token on loopback too', async () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      const error = await startServer({ host, port: 0, store, token: 'test1234' }).catch((e: unknown) => e);
      expect(error, host).toMatchObject({ code: 'CONFIG_INVALID' });
    }
  });

  it('refuses an invalid port', async () => {
    await expect(startServer({ port: 70_000, store })).rejects.toMatchObject({ code: 'USAGE' });
    await expect(startServer({ port: -1, store })).rejects.toMatchObject({ code: 'USAGE' });
    await expect(startServer({ port: 1.5, store })).rejects.toMatchObject({ code: 'USAGE' });
  });

  it('says clearly when the port is taken', async () => {
    const { server } = await start();
    const error = await startServer({ port: server.port, store }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'USAGE' });
    expect((error as MergeStoryError).hint).toContain('--port');
  });

  it('refuses an allowed root that is not a directory', async () => {
    const file = join(dir, 'a-file');
    await writeFile(file, 'x');
    await expect(startServer({ port: 0, store, allowRoots: [file] })).rejects.toMatchObject({
      code: 'USAGE',
    });
    await expect(startServer({ port: 0, store, allowRoots: [join(dir, 'missing')] })).rejects.toMatchObject({
      code: 'USAGE',
    });
  });

  it('listens on loopback by default', async () => {
    const server = await startServer({ port: 0, store });
    keepOpen(server);
    expect(server.host).toBe('127.0.0.1');
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

describe('Host header', () => {
  it('rejects a foreign Host when there is no token (DNS rebinding)', async () => {
    const { server } = await start();
    const bad = await raw(server, { headers: { Host: 'evil.example.com' } });
    expect(bad.status).toBe(403);
    const bad2 = await raw(server, { headers: { Host: `evil.example.com:${server.port}` } });
    expect(bad2.status).toBe(403);
    for (const host of [
      `localhost:${server.port}`,
      `127.0.0.1:${server.port}`,
      'localhost',
      `[::1]:${server.port}`,
    ]) {
      expect((await raw(server, { headers: { Host: host } })).status, host).toBe(200);
    }
  });

  it('checks the Host header on loopback even when a token is set', async () => {
    const token = 'a-long-random-api-token-1234567890';
    const { server } = await start({ token });
    const headers = { Host: 'proxy.internal', Authorization: `Bearer ${token}` };
    const res = await raw(server, { headers });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error.hint).toContain('Host header');
    expect(JSON.parse(res.body).error.hint).toContain('--allow-host');
    expect((await raw(server, { headers: { ...headers, Host: `127.0.0.1:${server.port}` } })).status).toBe(
      200,
    );
  });

  it('accepts the extra host names a reverse proxy uses', async () => {
    const token = 'a-long-random-api-token-1234567890';
    const { server } = await start({ token, allowedHosts: ['Proxy.Internal'] });
    const res = await raw(server, {
      headers: { Host: 'proxy.internal:443', Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(
      (await raw(server, { headers: { Host: 'other.internal', Authorization: `Bearer ${token}` } })).status,
    ).toBe(403);
  });

  it('refuses extra host names that are not names', async () => {
    for (const name of ['https://proxy.internal', 'proxy.internal:443', 'proxy.internal/x', '', 'a b']) {
      await expect(start({ allowedHosts: [name] }), name).rejects.toMatchObject({ code: 'USAGE' });
    }
  });

  it('parses Host headers strictly', () => {
    const allowed = allowedHostNames('127.0.0.1');
    expect(hostHeaderAllowed('localhost:7171', allowed)).toBe(true);
    expect(hostHeaderAllowed('LOCALHOST', allowed)).toBe(true);
    expect(hostHeaderAllowed('[::1]:7171', allowed)).toBe(true);
    expect(hostHeaderAllowed('localhost.evil.com:7171', allowed)).toBe(false);
    expect(hostHeaderAllowed('evil.com', allowed)).toBe(false);
    expect(hostHeaderAllowed('', allowed)).toBe(false);
    expect(hostHeaderAllowed(undefined, allowed)).toBe(true);
  });
});

describe('routing', () => {
  it('answers 404 for unknown routes', async () => {
    const { base } = await start();
    for (const path of ['/', '/v1', '/v1/unknown', '/v2/jobs', '/v1/jobs/x/y', '/v1/health/extra']) {
      const res = await api(base, path);
      expect(res.status, path).toBe(404);
      expect(res.json.ok).toBe(false);
    }
  });

  it('answers 405 with an Allow header for the wrong method', async () => {
    const { base, server } = await start();
    const cases: [string, string, string][] = [
      ['POST', '/v1/health', 'GET'],
      ['DELETE', '/v1/jobs', 'GET, POST'],
      ['PUT', '/v1/jobs', 'GET, POST'],
      ['POST', '/v1/jobs/20261103-214501-a3f9', 'GET'],
      ['DELETE', '/v1/jobs/20261103-214501-a3f9', 'GET'],
    ];
    for (const [method, path, allow] of cases) {
      const res = await api(base, path, { method });
      expect(res.status, `${method} ${path}`).toBe(405);
      expect(res.headers.get('allow')).toBe(allow);
    }
    const head = await raw(server, { method: 'HEAD', path: '/v1/health' });
    expect(head.status).toBe(405);
  });

  it('does not support CORS preflight', async () => {
    const { server } = await start();
    const res = await raw(server, {
      method: 'OPTIONS',
      path: '/v1/jobs',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(res.status).toBe(405);
    expect(Object.keys(res.headers).filter((k) => k.startsWith('access-control-'))).toEqual([]);
  });

  it('ignores a trailing slash', async () => {
    const { base } = await start();
    expect((await api(base, '/v1/jobs/')).status).toBe(200);
    expect((await api(base, '/v1/health/')).status).toBe(200);
  });

  it('answers 404 for a malformed or unknown job id', async () => {
    const { base } = await start();
    for (const id of ['abc', '..%2F..%2Fetc', '20261103-214501-A3F9', '20261103-214501-a3f9']) {
      const res = await api(base, `/v1/jobs/${id}`);
      expect(res.status, id).toBe(404);
      expect(res.json.error.code).toBe('JOB_NOT_FOUND');
    }
  });
});

describe('error handling', () => {
  it('answers 500 without details when something unexpected happens', async () => {
    const { base } = await start();
    vi.spyOn(store, 'list').mockRejectedValueOnce(new Error('ENOENT: /secret/home/path'));
    const res = await api(base, '/v1/jobs');
    expect(res.status).toBe(500);
    expect(res.json.error.code).toBe('INTERNAL');
    expect(JSON.stringify(res.json)).not.toContain('/secret/home/path');
  });
});

describe('shutdown', () => {
  it('cancels the running job, fails the waiting ones and stops listening', async () => {
    let seenSignal: AbortSignal | null = null;
    const hang = vi.fn(async (jobId: string, options: RunJobOptions) => {
      seenSignal = options.signal ?? null;
      const jobs = options.store as JobStore;
      await jobs.update(jobId, (job) => {
        job.status = 'running';
        job.pid = process.pid;
      });
      await new Promise<void>((resolveRun) =>
        options.signal?.addEventListener('abort', () => resolveRun(), { once: true }),
      );
      await jobs.update(jobId, (job) => {
        job.status = 'failed';
        job.error = { code: 'ABORTED', message: 'The run was cancelled.', hint: null };
      });
    });
    const { base, server } = await start({ runJob: hang });
    const first = await post(base, { source: 'acme/widgets#1' });
    const second = await post(base, { source: 'acme/widgets#2' });
    await waitFor(() => hang.mock.calls.length === 1);

    await server.close();
    await server.closed;

    expect((seenSignal as AbortSignal | null)?.aborted).toBe(true);
    const a = await store.read(first.json.id);
    const b = await store.read(second.json.id);
    expect(a.status).toBe('failed');
    expect(a.error?.code).toBe('ABORTED');
    expect(b.status).toBe('failed');
    expect(b.error?.code).toBe('ABORTED');
    expect(b.error?.message).toMatch(/stopped before this job started/);
    await expect(fetch(`${base}/v1/health`)).rejects.toBeDefined();
    // Closing twice is fine.
    await server.close();
  });

  it('closes when its signal is aborted', async () => {
    const controller = new AbortController();
    const { base, server } = await start({ signal: controller.signal });
    expect((await api(base, '/v1/health')).status).toBe(200);
    controller.abort();
    await server.closed;
    await expect(fetch(`${base}/v1/health`)).rejects.toBeDefined();
  });

  it('closes at once when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { server } = await start({ signal: controller.signal });
    await server.closed;
  });
});

describe('JobQueue', () => {
  function make(run: (id: string, signal: AbortSignal) => Promise<unknown>, maxPending = 3) {
    const failures: [string, string][] = [];
    const queue = new JobQueue({
      run,
      fail: async (id, error) => {
        failures.push([id, error.code]);
      },
      maxPending,
    });
    return { queue, failures };
  }

  it('reports failures from the runner and keeps going', async () => {
    const order: string[] = [];
    const { queue, failures } = make(async (id) => {
      order.push(id);
      if (id === 'a') throw new Error('boom');
    });
    queue.enqueue('a');
    queue.enqueue('b');
    await waitFor(() => order.length === 2 && queue.size === 0);
    expect(order).toEqual(['a', 'b']);
    expect(failures).toEqual([['a', 'INTERNAL']]);
  });

  it('refuses jobs when full or closed', async () => {
    const releases: (() => void)[] = [];
    const { queue } = make(() => new Promise<void>((release) => releases.push(release)), 1);
    expect(queue.enqueue('a')).toBe(true); // runs
    expect(queue.enqueue('b')).toBe(true); // waits
    expect(queue.isFull).toBe(true);
    expect(queue.enqueue('c')).toBe(false);
    releases[0]?.();
    await waitFor(() => releases.length === 2);
    releases[1]?.();
    await waitFor(() => queue.size === 0);
    await queue.close(10);
    expect(queue.enqueue('d')).toBe(false);
  });
});
