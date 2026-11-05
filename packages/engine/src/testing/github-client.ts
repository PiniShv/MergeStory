/**
 * Helpers for the GitHub client tests: a scripted fetch that records every call, small response builders,
 * and a run context with or without a token. Not part of the public API.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import type { Cache } from '../core/cache.ts';
import type { ConfigInput, SecretName } from '../core/config.ts';
import type { RunContext } from '../core/context.ts';
import { isMergeStoryError, type MergeStoryError } from '../core/errors.ts';
import { silentLogger } from '../core/logger.ts';
import type { ProgressEvent } from '../core/types.ts';
import { GitHubClient } from '../github/client.ts';
import { findLinkedIssues } from '../github/linked-issues.ts';
import { type PullRequestRef, parsePullRequestUrl } from '../github/pr-url.ts';
import { testContext } from './context.ts';

export const SHA = 'a'.repeat(40);
export const MAX_BYTES = 1024 * 1024;
export const MAX_ISSUES = 3;
export const MAX_COMMITS = 250;
export const TOKEN = 'ghp_clientTestTokenAAAAAAAAAAAAAAAAAAAAAAAA';

export interface Call {
  url: URL;
  method: string;
  headers: Headers;
  body: string | null;
}
export type Handler = (call: Call) => Response | undefined | Promise<Response | undefined>;

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Replace fetch with a router; the first handler that returns a response wins. Unmatched requests are 404. */
export function mockFetch(...handlers: Handler[]): { calls: Call[] } {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      );
      const call: Call = {
        url,
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? init.body : null,
      };
      calls.push(call);
      for (const handler of handlers) {
        const response = await handler(call);
        if (response) return response;
      }
      return json({ message: 'Not Found' }, 404);
    }),
  );
  return { calls };
}

export function route(method: string, pathname: string, respond: (call: Call) => Response): Handler {
  return (call) => (call.method === method && call.url.pathname === pathname ? respond(call) : undefined);
}

export function memoryCache(): Cache & { store: Map<string, Buffer> } {
  const store = new Map<string, Buffer>();
  return {
    store,
    get: async (ns, key) => store.get(`${ns}/${key}`) ?? null,
    put: async (ns, key, data) => {
      store.set(`${ns}/${key}`, Buffer.isBuffer(data) ? data : Buffer.from(data));
    },
  };
}

export interface ContextOptions {
  config?: ConfigInput;
  secrets?: Partial<Record<SecretName, string>>;
  cache?: Cache;
  dryRun?: boolean;
  events?: ProgressEvent[];
}

export function makeContext(options: ContextOptions = {}): RunContext {
  return testContext({
    config: { github: { useGhCli: false }, ...options.config },
    secrets: options.secrets,
    cache: options.cache,
    dryRun: options.dryRun,
    onProgress: (event) => options.events?.push(event),
  }).ctx;
}

export const REF = parsePullRequestUrl('https://github.com/acme/widgets/pull/7');

export async function clientWith(
  options: ContextOptions = {},
  ref: PullRequestRef = REF,
): Promise<GitHubClient> {
  return GitHubClient.create(ref, makeContext(options), { ghPath: join(tmpdir(), 'mergestory-no-such-gh') });
}

export function linked(client: GitHubClient, body: string, maxIssues: number) {
  return findLinkedIssues(
    client,
    { signal: new AbortController().signal, logger: silentLogger },
    body,
    maxIssues,
  );
}

export async function expectError(promise: Promise<unknown>): Promise<MergeStoryError> {
  try {
    await promise;
  } catch (error) {
    expect(isMergeStoryError(error)).toBe(true);
    return error as MergeStoryError;
  }
  throw new Error('expected a MergeStoryError');
}
