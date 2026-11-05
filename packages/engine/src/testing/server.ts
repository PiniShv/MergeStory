/**
 * Shared setup for the server tests: a temporary folder with a job store, a server started over it, and
 * small HTTP helpers. Importing this module registers the hooks that create and remove the folder.
 * Not part of the public API.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';
import type { GenerateResult } from '../core/types.ts';
import type { RunJobOptions } from '../jobs/runner.ts';
import { JobStore } from '../jobs/store.ts';
import { type ServerHandle, type StartServerOptions, startServer } from '../server/index.ts';

export let dir: string;
export let store: JobStore;
export let allowedRoot: string;
export let outsideDir: string;
let handle: ServerHandle | null = null;

/** Closes a server the test started itself when the test ends. */
export function keepOpen(server: ServerHandle): void {
  handle = server;
}

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'mergestory-server-')));
  store = new JobStore(join(dir, 'jobs'));
  allowedRoot = join(dir, 'repos');
  outsideDir = join(dir, 'outside');
  await mkdir(join(allowedRoot, 'repo-a'), { recursive: true });
  await mkdir(join(outsideDir, 'repo-b'), { recursive: true });
  await mkdir(join(dir, 'repos-evil', 'repo-c'), { recursive: true });
});

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  await rm(dir, { recursive: true, force: true });
});

/** Make `path` an empty git repository. */
export function gitInit(path: string): void {
  execFileSync('git', ['init', '-q', path], { stdio: 'ignore' });
}

/** The id of a process that has already exited. */
export function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

export function fakeResult(): GenerateResult {
  return {
    ok: true,
    runId: 'r1',
    runDir: '/runs/r1',
    title: 'Add retries',
    summary: 'Adds retries.',
    durationSec: 60,
    chapters: [],
    storyboardSource: 'heuristic',
    files: { video: 'v', poster: 'p', captions: 'c', storyboard: 's', watchPage: 'w' },
    publish: null,
    notify: null,
    grounding: { groundedClaims: 0, fixes: [], warnings: [] },
    cost: { totalUsd: 0, budgetUsd: 0.25, records: [] },
    egress: [],
    warnings: [],
  };
}

/** Finishes the job right away, the way the real runner would. */
export const finishAtOnce = vi.fn(async (jobId: string, options: RunJobOptions) => {
  const jobs = options.store as JobStore;
  await jobs.update(jobId, (job) => {
    job.status = 'running';
    job.pid = process.pid;
  });
  await jobs.update(jobId, (job) => {
    job.status = 'succeeded';
    job.result = fakeResult();
  });
});

export async function start(
  overrides: StartServerOptions = {},
): Promise<{ base: string; server: ServerHandle }> {
  const server = await startServer({
    port: 0,
    store,
    allowRoots: [allowedRoot],
    runJob: finishAtOnce,
    ...overrides,
  });
  handle = server;
  return { base: server.url, server };
}

export interface ApiResponse {
  status: number;
  headers: Headers;
  // biome-ignore lint/suspicious/noExplicitAny: the helper hands back whatever JSON the server sent
  json: any;
}

export async function api(base: string, path: string, init: RequestInit = {}): Promise<ApiResponse> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: response.status, headers: response.headers, json };
}

export function post(
  base: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<ApiResponse> {
  return api(base, '/v1/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** For tests that need control over the Host header or the way the body is sent. */
export function raw(
  server: ServerHandle,
  options: { method?: string; path?: string; headers?: Record<string, string>; chunks?: Buffer[] },
): Promise<RawResponse> {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: server.port,
        method: options.method ?? 'GET',
        path: options.path ?? '/v1/health',
        headers: options.headers,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    // The server may answer before it has read everything we send.
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET') reject(err);
    });
    for (const chunk of options.chunks ?? []) req.write(chunk);
    req.end();
  });
}

export async function waitFor(check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition not met in time');
}
