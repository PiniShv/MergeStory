import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProgressEvent } from '../core/types.ts';
import {
  clientWith,
  expectError,
  json,
  makeContext,
  mockFetch,
  REF,
  route,
  SHA,
  TOKEN,
} from '../testing/github-client.ts';
import { ENGINE_VERSION } from '../version.ts';
import { GITHUB_API_VERSION, GitHubClient } from './client.ts';
import { parsePullRequestUrl } from './pr-url.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('request headers and tokens', () => {
  it('sends the version, user agent and bearer token, and keeps the token out of URLs', async () => {
    const { calls } = mockFetch(
      route('GET', '/repos/acme/widgets/pulls/7', () =>
        json({
          number: 7,
          title: 'T',
          body: null,
          state: 'open',
          base: { ref: 'main', sha: 'b'.repeat(40) },
          head: { ref: 'x', sha: SHA },
        }),
      ),
    );
    const client = await clientWith({ secrets: { GITHUB_TOKEN: TOKEN } });
    await client.getPullRequest();
    const call = calls[0]!;
    expect(call.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(call.headers.get('x-github-api-version')).toBe(GITHUB_API_VERSION);
    expect(GITHUB_API_VERSION).toBe('2022-11-28');
    expect(call.headers.get('user-agent')).toBe(`mergestory/${ENGINE_VERSION}`);
    expect(call.headers.get('accept')).toBe('application/vnd.github+json');
    expect(call.url.toString()).not.toContain(TOKEN);
    expect(client.authenticated).toBe(true);
  });

  it('prefers GITHUB_TOKEN, then GH_TOKEN', async () => {
    const calls = mockFetch(
      route('GET', '/repos/acme/widgets', () => json({ name: 'widgets', private: false })),
    ).calls;
    const both = await clientWith({
      secrets: { GITHUB_TOKEN: 'ghp_first_token_value_1234', GH_TOKEN: 'ghp_second_token_value_1234' },
    });
    await both.getRepo();
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer ghp_first_token_value_1234');
    const onlyGh = await clientWith({ secrets: { GH_TOKEN: 'ghp_second_token_value_1234' } });
    await onlyGh.getRepo();
    expect(calls[1]!.headers.get('authorization')).toBe('Bearer ghp_second_token_value_1234');
  });

  it('works unauthenticated with a warning, and sends no Authorization header', async () => {
    const { calls } = mockFetch(
      route('GET', '/repos/acme/widgets', () => json({ name: 'widgets', private: false })),
    );
    const events: ProgressEvent[] = [];
    const client = await clientWith({ events });
    await client.getRepo();
    expect(client.authenticated).toBe(false);
    expect(calls[0]!.headers.has('authorization')).toBe(false);
    const warning = events.find((e) => e.status === 'warn');
    expect(warning?.message).toContain('60 requests per hour');
    expect(warning?.message).toContain('GITHUB_TOKEN');
  });

  it('never sends the environment token to a host other than api.github.com or the configured one', async () => {
    const { calls } = mockFetch(route('GET', '/api/v3/repos/team/app', () => json({ name: 'app' })));
    const ghe = parsePullRequestUrl('https://ghe.example.com/team/app/pull/3');
    const events: ProgressEvent[] = [];
    const untrusted = await clientWith({ secrets: { GITHUB_TOKEN: TOKEN }, events }, ghe);
    await untrusted.getRepo();
    expect(untrusted.authenticated).toBe(false);
    expect(calls[0]!.headers.has('authorization')).toBe(false);
    expect(events.find((e) => e.status === 'warn')?.message).toContain('github.apiUrl');

    // The same host named in the configuration is trusted.
    const trusted = await clientWith(
      {
        secrets: { GITHUB_TOKEN: TOKEN },
        config: { github: { apiUrl: 'https://ghe.example.com/api/v3', useGhCli: false } },
      },
      parsePullRequestUrl('https://ghe.example.com/team/app/pull/3', 'https://ghe.example.com/api/v3'),
    );
    await trusted.getRepo();
    expect(calls[1]!.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('keeps the token out of JSON and debugger dumps', async () => {
    const client = await clientWith({ secrets: { GITHUB_TOKEN: TOKEN } });
    expect(JSON.stringify(client)).not.toContain(TOKEN);
    expect(inspect(client, { depth: 5 })).not.toContain(TOKEN);
    expect(String(JSON.stringify(client))).toContain('api.github.com');
  });

  describe('the gh CLI fallback', () => {
    async function fakeGh(script: string): Promise<{ dir: string; path: string; log: string }> {
      const dir = await mkdtemp(join(tmpdir(), 'mergestory-gh-'));
      const path = join(dir, 'gh');
      const log = join(dir, 'args.log');
      await writeFile(path, `#!/bin/sh\necho "$@" > '${log}'\n${script}\n`, 'utf8');
      await chmod(path, 0o755);
      return { dir, path, log };
    }

    it('uses "gh auth token" for the host and registers the token for redaction', async () => {
      const gh = await fakeGh("echo 'ghp_fromGhCliAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'");
      try {
        const { calls } = mockFetch(route('GET', '/repos/acme/widgets', () => json({ name: 'widgets' })));
        const ctx = makeContext({ config: { github: { useGhCli: true } } });
        const client = await GitHubClient.create(REF, ctx, { ghPath: gh.path });
        await client.getRepo();
        expect(calls[0]!.headers.get('authorization')).toBe(
          'Bearer ghp_fromGhCliAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        );
        expect(ctx.redactor.redact('x ghp_fromGhCliAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA y')).toBe(
          'x [redacted] y',
        );
        expect((await readFile(gh.log, 'utf8')).trim()).toBe('auth token --hostname github.com');
      } finally {
        await rm(gh.dir, { recursive: true, force: true });
      }
    });

    it('never lets gh hand out environment tokens for a pull request on another host', async () => {
      // A gh that behaves like the real one for unknown hosts: it prints a token variable if it sees one.
      const gh = await fakeGh(
        'printf "%s" "${GH_ENTERPRISE_TOKEN}${GITHUB_ENTERPRISE_TOKEN}${GH_TOKEN}${GITHUB_TOKEN}"',
      );
      const saved = { ...process.env };
      try {
        process.env.GH_ENTERPRISE_TOKEN = 'ghp_enterpriseTokenAAAAAAAAAAAAAAAAAAAAAAAAAA';
        process.env.GITHUB_TOKEN = TOKEN;
        process.env.GH_TOKEN = TOKEN;
        const foreign = parsePullRequestUrl('https://code.example.org/acme/widgets/pull/7');
        const { calls } = mockFetch(
          route('GET', '/api/v3/repos/acme/widgets', () => json({ name: 'widgets' })),
        );
        const ctx = makeContext({ secrets: { GITHUB_TOKEN: TOKEN }, config: { github: { useGhCli: true } } });
        const client = await GitHubClient.create(foreign, ctx, { ghPath: gh.path });
        await client.getRepo();
        expect(calls[0]!.headers.get('authorization')).toBeNull();
      } finally {
        process.env = saved;
        await rm(gh.dir, { recursive: true, force: true });
      }
    });

    it('is skipped when the environment already has a token or when switched off', async () => {
      const gh = await fakeGh("echo 'ghp_fromGhCliAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'");
      try {
        mockFetch(route('GET', '/repos/acme/widgets', () => json({ name: 'widgets' })));
        await GitHubClient.create(
          REF,
          makeContext({ secrets: { GITHUB_TOKEN: TOKEN }, config: { github: { useGhCli: true } } }),
          {
            ghPath: gh.path,
          },
        );
        expect(existsSync(gh.log)).toBe(false);
        await GitHubClient.create(REF, makeContext({ config: { github: { useGhCli: false } } }), {
          ghPath: gh.path,
        });
        expect(existsSync(gh.log)).toBe(false);
      } finally {
        await rm(gh.dir, { recursive: true, force: true });
      }
    });

    it('falls back to unauthenticated when gh fails, prints nothing, or is missing', async () => {
      const failing = await fakeGh('exit 1');
      const empty = await fakeGh('exit 0');
      const slow = await fakeGh('exec sleep 20');
      try {
        for (const path of [failing.path, empty.path, join(tmpdir(), 'mergestory-no-such-gh')]) {
          const events: ProgressEvent[] = [];
          const client = await GitHubClient.create(
            REF,
            makeContext({ config: { github: { useGhCli: true } }, events }),
            { ghPath: path },
          );
          expect(client.authenticated).toBe(false);
          expect(events.some((e) => e.status === 'warn')).toBe(true);
        }
        // A gh that hangs is given up on after five seconds.
        vi.useFakeTimers({ toFake: ['setTimeout'] });
        const pending = GitHubClient.create(REF, makeContext({ config: { github: { useGhCli: true } } }), {
          ghPath: slow.path,
        });
        await vi.advanceTimersByTimeAsync(5100);
        const client = await pending;
        expect(client.authenticated).toBe(false);
      } finally {
        vi.useRealTimers();
        await Promise.all([failing, empty, slow].map((gh) => rm(gh.dir, { recursive: true, force: true })));
      }
    });
  });
});

describe('error mapping', () => {
  it('maps 401 to GITHUB_AUTH', async () => {
    mockFetch(() => json({ message: 'Bad credentials' }, 401));
    const error = await expectError((await clientWith({ secrets: { GITHUB_TOKEN: TOKEN } })).getRepo());
    expect(error.code).toBe('GITHUB_AUTH');
    expect(error.hint).toContain('GITHUB_TOKEN');
    expect(error.hint).toContain('gh auth login');
    expect(error.message).not.toContain(TOKEN);
  });

  it('maps an exhausted rate limit to RATE_LIMITED with the reset time, without retrying', async () => {
    const reset = Math.floor(Date.now() / 1000) + 1800;
    const { calls } = mockFetch(() =>
      json({ message: 'API rate limit exceeded' }, 403, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(reset),
      }),
    );
    const error = await expectError((await clientWith()).getPullRequest());
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.hint).toContain(new Date(reset * 1000).toISOString());
    expect(error.hint).toContain('GITHUB_TOKEN');
    expect(error.retryable).toBe(true);
    expect(calls).toHaveLength(1);
    // With a token the advice about getting one is left out.
    const authed = await expectError(
      (await clientWith({ secrets: { GITHUB_TOKEN: TOKEN } })).getPullRequest(),
    );
    expect(authed.code).toBe('RATE_LIMITED');
    expect(authed.hint).not.toContain('raise the limit');
  });

  it('treats a 429 as a rate limit, too', async () => {
    mockFetch(() =>
      json({ message: 'rate limit' }, 429, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60),
      }),
    );
    expect((await expectError((await clientWith()).getRepo())).code).toBe('RATE_LIMITED');
  });

  it('waits and retries a short secondary rate limit, but not a long one', async () => {
    let count = 0;
    const { calls } = mockFetch(
      route('GET', '/repos/acme/widgets', () => {
        count++;
        return count === 1
          ? json({ message: 'secondary rate limit' }, 403, { 'retry-after': '0' })
          : json({ name: 'widgets', private: false });
      }),
    );
    const repo = await (await clientWith()).getRepo();
    expect(repo.name).toBe('widgets');
    expect(calls).toHaveLength(2);

    const long = mockFetch(() => json({ message: 'slow down' }, 429, { 'retry-after': '3600' }));
    const error = await expectError((await clientWith()).getRepo());
    expect(error.code).toBe('RATE_LIMITED');
    expect(long.calls).toHaveLength(1);
  });

  it('maps 404 to SOURCE_NOT_FOUND, with advice about tokens when there is none', async () => {
    mockFetch(() => json({ message: 'Not Found' }, 404));
    const anonymous = await expectError((await clientWith()).getPullRequest());
    expect(anonymous.code).toBe('SOURCE_NOT_FOUND');
    expect(anonymous.hint).toContain('Private repositories need a token');
    const authed = await expectError(
      (await clientWith({ secrets: { GITHUB_TOKEN: TOKEN } })).getPullRequest(),
    );
    expect(authed.code).toBe('SOURCE_NOT_FOUND');
    expect(authed.hint).toContain('may not have access');
  });

  it('maps a permission failure to GITHUB_AUTH with the permissions needed', async () => {
    mockFetch(() => json({ message: 'Resource not accessible by integration' }, 403));
    const error = await expectError(
      (await clientWith({ secrets: { GITHUB_TOKEN: TOKEN } })).getPullRequest(),
    );
    expect(error.code).toBe('GITHUB_AUTH');
    expect(error.hint).toContain('Pull requests: read');
    expect(error.details).toMatchObject({ status: 403 });
  });

  it('maps an unreachable server to GITHUB_FAILED', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const pending = expectError((await clientWith()).getRepo());
    await vi.advanceTimersByTimeAsync(60_000);
    const error = await pending;
    expect(error.code).toBe('GITHUB_FAILED');
    expect(error.message).toContain('api.github.com');
    expect(error.hint).toContain('network');
  });

  it('tolerates a non-JSON error page', async () => {
    mockFetch(() => new Response('<html>nope</html>', { status: 422 }));
    const error = await expectError((await clientWith()).getRepo());
    expect(error.code).toBe('GITHUB_FAILED');
  });
});

describe('reading the pull request', () => {
  it('normalises the pull request, repository and comparison', async () => {
    const { calls } = mockFetch(
      route('GET', '/repos/acme/widgets/pulls/7', () =>
        json({
          number: 7,
          title: 'Add retries',
          body: null,
          html_url: 'https://github.com/acme/widgets/pull/7',
          state: 'closed',
          merged: true,
          draft: false,
          user: { login: 'octocat' },
          labels: [{ name: 'bug' }, { name: 'ui' }],
          base: { ref: 'main', sha: 'b'.repeat(40) },
          head: { ref: 'feature', sha: SHA },
          changed_files: 4,
          additions: 10,
          deletions: 2,
          commits: 3,
        }),
      ),
      route('GET', '/repos/acme/widgets', () =>
        json({
          name: 'Widgets',
          owner: { login: 'Acme' },
          private: false,
          visibility: 'internal',
          default_branch: 'trunk',
          html_url: 'https://github.com/Acme/Widgets',
        }),
      ),
      route('GET', `/repos/acme/widgets/compare/${'b'.repeat(40)}...${SHA}`, () =>
        json({ status: 'ahead', ahead_by: 3, behind_by: 1, merge_base_commit: { sha: 'c'.repeat(40) } }),
      ),
    );
    const client = await clientWith();
    expect(await client.getPullRequest()).toEqual({
      number: 7,
      title: 'Add retries',
      body: '',
      htmlUrl: 'https://github.com/acme/widgets/pull/7',
      author: 'octocat',
      baseRef: 'main',
      baseSha: 'b'.repeat(40),
      headRef: 'feature',
      headSha: SHA,
      labels: ['bug', 'ui'],
      draft: false,
      state: 'merged',
      changedFiles: 4,
      additions: 10,
      deletions: 2,
      commits: 3,
    });
    // "internal" repositories count as private.
    expect(await client.getRepo()).toEqual({
      owner: 'Acme',
      name: 'Widgets',
      isPrivate: true,
      defaultBranch: 'trunk',
      htmlUrl: 'https://github.com/Acme/Widgets',
    });
    expect(await client.compare('b'.repeat(40), SHA)).toEqual({
      mergeBaseSha: 'c'.repeat(40),
      status: 'ahead',
      aheadBy: 3,
      behindBy: 1,
    });
    expect(calls[2]!.url.searchParams.get('per_page')).toBe('1');
  });

  it('rejects answers that are missing what we need', async () => {
    mockFetch(() => json({ number: 7 }));
    const client = await clientWith();
    expect((await expectError(client.getPullRequest())).code).toBe('GITHUB_FAILED');
    expect((await expectError(client.compare('a', 'b'))).code).toBe('GITHUB_FAILED');
  });
});
