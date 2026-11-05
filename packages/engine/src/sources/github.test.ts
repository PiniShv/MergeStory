import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigInput } from '../core/config.ts';
import type { RunContext } from '../core/context.ts';
import { isMergeStoryError, type MergeStoryError } from '../core/errors.ts';
import type { ProgressEvent } from '../core/types.ts';
import { testContext } from '../testing/context.ts';
import { GitHubSource } from './github.ts';

const BASE = 'b'.repeat(40);
const HEAD = 'a'.repeat(40);
const MERGE_BASE = 'c'.repeat(40);
const PR_URL = 'https://github.com/acme/widgets/pull/7';
// Built at run time, so the made-up token never appears whole in the source.
const SECRET_TOKEN = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
const SECRET_PASSWORD = 'hunter2hunter2';

interface Call {
  url: URL;
  method: string;
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const APP_PATCH = [
  '@@ -1,3 +1,4 @@ export function main() {',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' return a;',
  '@@ -20,2 +21,2 @@',
  ' x',
  '-y',
  '+z',
].join('\n');

interface Fixture {
  pull?: Record<string, unknown>;
  repo?: Record<string, unknown>;
  files?: Record<string, unknown>[];
  commits?: Record<string, unknown>[];
  /** Responds to the compare request; default is a normal answer. */
  compare?: () => Response;
  /** Responds to a tree request; default is a normal listing. */
  tree?: (recursive: boolean) => Response;
  contents?: Record<string, string>;
  issues?: Record<number, Record<string, unknown>>;
}

const DEFAULT_FILES = [
  {
    filename: '.env',
    status: 'added',
    additions: 2,
    deletions: 0,
    changes: 2,
    patch: `@@ -0,0 +1,2 @@\n+API_TOKEN=${SECRET_TOKEN}\n+DB_PASSWORD=${SECRET_PASSWORD}`,
  },
  { filename: 'assets/logo.png', status: 'modified', additions: 0, deletions: 0, changes: 0 },
  { filename: 'big/generated.ts', status: 'modified', additions: 8000, deletions: 1000, changes: 9000 },
  {
    filename: 'docs/new.md',
    previous_filename: 'docs/old.md',
    status: 'renamed',
    additions: 1,
    deletions: 1,
    changes: 2,
    patch: '@@ -1,2 +1,2 @@\n title\n-old line\n+new line',
  },
  {
    filename: 'internal/notes.md',
    status: 'added',
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: '@@ -0,0 +1 @@\n+private note',
  },
  {
    filename: 'removed.txt',
    status: 'removed',
    additions: 0,
    deletions: 2,
    changes: 2,
    patch: '@@ -1,2 +0,0 @@\n-a\n-b',
  },
  { filename: 'src/app.ts', status: 'modified', additions: 3, deletions: 2, changes: 5, patch: APP_PATCH },
];

function installFetch(fixture: Fixture = {}): { calls: Call[] } {
  const calls: Call[] = [];
  const contents = fixture.contents ?? {
    [`README.md@${HEAD}`]: '# Widgets\n\nUseful widgets.\n',
    [`package.json@${HEAD}`]: '{"name":"widgets"}',
    [`src/app.ts@${MERGE_BASE}`]: 'old app\n',
    [`src/app.ts@${HEAD}`]: 'new app\n',
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      );
      calls.push({ url, method: init?.method ?? 'GET' });
      const path = url.pathname;
      if (path === '/repos/acme/widgets/pulls/7') {
        return json({
          number: 7,
          title: 'Add retries',
          body: 'Adds retries.\n\nFixes #3\n\nTesting token: ghp_abcdefghijklmnopqrstuvwxyz0123456789, mail jane@example.com',
          html_url: PR_URL,
          state: 'open',
          draft: true,
          user: { login: 'octocat' },
          labels: [{ name: 'enhancement' }],
          base: { ref: 'main', sha: BASE },
          head: { ref: 'feature/retries', sha: HEAD },
          changed_files: 7,
          additions: 8007,
          deletions: 1005,
          commits: 2,
          ...fixture.pull,
        });
      }
      if (path === '/repos/acme/widgets') {
        return json({
          name: 'widgets',
          owner: { login: 'acme' },
          private: true,
          default_branch: 'main',
          html_url: 'https://github.com/acme/widgets',
          ...fixture.repo,
        });
      }
      if (path === `/repos/acme/widgets/compare/${BASE}...${HEAD}`) {
        return fixture.compare
          ? fixture.compare()
          : json({ status: 'ahead', merge_base_commit: { sha: MERGE_BASE } });
      }
      if (path === '/repos/acme/widgets/pulls/7/files') return json(fixture.files ?? DEFAULT_FILES);
      if (path === '/repos/acme/widgets/pulls/7/commits') {
        return json(
          fixture.commits ?? [
            {
              sha: 'd'.repeat(40),
              commit: {
                message:
                  'Add retries\n\nRetry failed requests.\n\nCo-authored-by: Jane Doe <jane@example.com>',
              },
            },
            { sha: 'e'.repeat(40), commit: { message: 'Fix typo' } },
          ],
        );
      }
      if (path === `/repos/acme/widgets/git/trees/${HEAD}`) {
        const recursive = url.searchParams.has('recursive');
        if (fixture.tree) return fixture.tree(recursive);
        return json({
          truncated: false,
          tree: [
            { path: 'README.md', type: 'blob' },
            { path: 'package.json', type: 'blob' },
            { path: '.env', type: 'blob' },
            { path: 'src', type: 'tree' },
            { path: 'src/app.ts', type: 'blob' },
            { path: 'docs', type: 'tree' },
            { path: 'docs/new.md', type: 'blob' },
            { path: 'internal', type: 'tree' },
            { path: 'internal/notes.md', type: 'blob' },
          ],
        });
      }
      const issue = /^\/repos\/acme\/widgets\/issues\/(\d+)$/.exec(path);
      if (issue) {
        const data = (fixture.issues ?? {
          3: {
            number: 3,
            title: 'Requests fail',
            body: 'Details',
            html_url: 'https://github.com/acme/widgets/issues/3',
          },
        })[Number(issue[1])];
        return data ? json(data) : json({ message: 'Not Found' }, 404);
      }
      const content = /^\/repos\/acme\/widgets\/contents\/(.+)$/.exec(path);
      if (content) {
        const key = `${decodeURIComponent(content[1]!)}@${url.searchParams.get('ref')}`;
        const text = contents[key];
        return text === undefined
          ? json({ message: 'Not Found' }, 404)
          : new Response(text, { status: 200, headers: { 'x-github-media-type': 'github.v3; param=raw' } });
      }
      return json({ message: 'Not Found' }, 404);
    }),
  );
  return { calls };
}

function makeContext(
  options: { config?: ConfigInput; token?: boolean; events?: ProgressEvent[] } = {},
): RunContext {
  return testContext({
    config: { github: { useGhCli: false }, ...options.config },
    secrets: options.token ? { GITHUB_TOKEN: 'ghp_sourceTestTokenAAAAAAAAAAAAAAAAAAAAAAA' } : {},
    onProgress: (event) => options.events?.push(event),
  }).ctx;
}

async function expectError(promise: Promise<unknown>): Promise<MergeStoryError> {
  try {
    await promise;
  } catch (error) {
    expect(isMergeStoryError(error)).toBe(true);
    return error as MergeStoryError;
  }
  throw new Error('expected a MergeStoryError');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GitHubSource', () => {
  it('uses the merge base as the base of the change', async () => {
    installFetch();
    const { changeSet } = await new GitHubSource().load({ kind: 'github', url: PR_URL }, makeContext());
    // The patches GitHub returns are relative to the merge base, not to the tip of the base branch.
    expect(changeSet.base).toEqual({ ref: 'main', sha: MERGE_BASE });
    expect(changeSet.head).toEqual({ ref: 'feature/retries', sha: HEAD });
  });

  it('builds the change set from the pull request, repository, files and commits', async () => {
    installFetch();
    const { changeSet } = await new GitHubSource().load({ kind: 'github', url: PR_URL }, makeContext());

    expect(changeSet.source).toBe('github');
    expect(changeSet.repo).toEqual({
      host: 'github.com',
      owner: 'acme',
      name: 'widgets',
      isPrivate: true,
      defaultBranch: 'main',
      webUrl: 'https://github.com/acme/widgets',
    });
    expect(changeSet.pr).toMatchObject({
      number: 7,
      title: 'Add retries',
      url: PR_URL,
      author: 'octocat',
      baseRef: 'main',
      headRef: 'feature/retries',
      labels: ['enhancement'],
      draft: true,
      state: 'open',
    });
    // Secrets and e-mail addresses are masked in the description.
    expect(changeSet.pr!.body).toContain('Adds retries.');
    expect(changeSet.pr!.body).not.toContain('ghp_');
    expect(changeSet.pr!.body).not.toContain('jane@example.com');

    expect(changeSet.commits).toEqual([
      { id: 'CM1', sha: 'd'.repeat(40), subject: 'Add retries', body: 'Retry failed requests.' },
      { id: 'CM2', sha: 'e'.repeat(40), subject: 'Fix typo', body: '' },
    ]);
    // Totals come from the pull request, which also counts files whose code GitHub left out.
    expect(changeSet.stats).toEqual({ files: 7, additions: 8007, deletions: 1005 });
    expect(changeSet.files.map((f) => f.id)).toEqual(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7']);

    const byPath = new Map(changeSet.files.map((f) => [f.path, f]));
    const app = byPath.get('src/app.ts')!;
    expect(app).toMatchObject({
      id: 'F7',
      status: 'modified',
      additions: 3,
      deletions: 2,
      language: 'typescript',
      binary: false,
      patchTruncated: false,
      sensitive: false,
    });
    expect(app.hunks.map((h) => h.id)).toEqual(['F7.H1', 'F7.H2']);
    expect(app.hunks[0]).toMatchObject({ oldStart: 1, newStart: 1, header: 'export function main() {' });
    expect(app.hunks[0]!.lines.map((l) => [l.kind, l.text, l.oldLine, l.newLine])).toEqual([
      ['ctx', 'const a = 1;', 1, 1],
      ['del', 'const b = 2;', 2, null],
      ['add', 'const b = 3;', null, 2],
      ['add', 'const c = 4;', null, 3],
      ['ctx', 'return a;', 3, 4],
    ]);

    expect(byPath.get('docs/new.md')).toMatchObject({
      status: 'renamed',
      oldPath: 'docs/old.md',
      additions: 1,
      deletions: 1,
    });
    expect(byPath.get('docs/new.md')!.hunks).toHaveLength(1);
    expect(byPath.get('removed.txt')).toMatchObject({ status: 'deleted', deletions: 2 });
    expect(byPath.get('removed.txt')!.hunks[0]!.lines.every((l) => l.kind === 'del')).toBe(true);
    // No patch and no counts for a PNG: binary.
    expect(byPath.get('assets/logo.png')).toMatchObject({ binary: true, hunks: [], patchTruncated: false });
    // A big file without a patch is marked as truncated, with GitHub's counts kept.
    expect(byPath.get('big/generated.ts')).toMatchObject({
      binary: false,
      hunks: [],
      patchTruncated: true,
      additions: 8000,
      deletions: 1000,
    });
    expect(changeSet.limits.filesCapped).toBe(false);
    expect(changeSet.limits.commitsCapped).toBe(false);
    expect(changeSet.limits.note).toContain('no code for 1 changed file');
  });

  it('never keeps sensitive or excluded content, even though GitHub sends the patch', async () => {
    installFetch();
    const { changeSet, reader } = await new GitHubSource().load(
      { kind: 'github', url: PR_URL },
      makeContext({ config: { privacy: { excludePaths: ['internal/'] } } }),
    );
    const env = changeSet.files.find((f) => f.path === '.env')!;
    expect(env).toMatchObject({ sensitive: true, hunks: [], additions: 2, patchTruncated: false });
    const notes = changeSet.files.find((f) => f.path === 'internal/notes.md')!;
    expect(notes).toMatchObject({ sensitive: true, hunks: [] });
    const serialised = JSON.stringify(changeSet);
    expect(serialised).not.toContain(SECRET_TOKEN);
    expect(serialised).not.toContain(SECRET_PASSWORD);
    expect(serialised).not.toContain('private note');
    expect(changeSet.repoContext.tree).not.toContain('.env');
    expect(changeSet.repoContext.tree.some((entry) => entry.startsWith('internal'))).toBe(false);
    expect(await reader.readFile('.env', 'head')).toBeNull();
    expect(await reader.readFile('internal/notes.md', 'head')).toBeNull();
  });

  it('treats a rename from a sensitive path as sensitive', async () => {
    installFetch({
      files: [
        {
          filename: 'data.json',
          previous_filename: 'credentials.json',
          status: 'renamed',
          additions: 1,
          deletions: 1,
          changes: 2,
          patch: `@@ -1 +1 @@\n-"${SECRET_PASSWORD}"\n+"x"`,
        },
      ],
      pull: { changed_files: 1, additions: 1, deletions: 1 },
    });
    const { changeSet } = await new GitHubSource().load({ kind: 'github', url: PR_URL }, makeContext());
    expect(changeSet.files[0]).toMatchObject({ sensitive: true, hunks: [] });
    expect(JSON.stringify(changeSet)).not.toContain(SECRET_PASSWORD);
  });

  it('treats a rename away from an excluded path as sensitive', async () => {
    installFetch({
      files: [
        {
          filename: 'public/plan.md',
          previous_filename: 'internal/plan.md',
          status: 'renamed',
          additions: 1,
          deletions: 1,
          changes: 2,
          patch: '@@ -1 +1 @@\n-Launch on Friday\n+Launch later',
        },
      ],
      pull: { changed_files: 1, additions: 1, deletions: 1 },
    });
    const { changeSet } = await new GitHubSource().load(
      { kind: 'github', url: PR_URL },
      makeContext({ config: { privacy: { excludePaths: ['internal/'] } } }),
    );
    expect(changeSet.files[0]).toMatchObject({ sensitive: true, hunks: [] });
    expect(JSON.stringify(changeSet)).not.toContain('Launch');
  });

  it('reads base files at the merge base and head files at the head commit, from the base repository', async () => {
    const { calls } = installFetch();
    const { reader } = await new GitHubSource().load({ kind: 'github', url: PR_URL }, makeContext());
    expect(await reader.readFile('src/app.ts', 'base')).toBe('old app\n');
    expect(await reader.readFile('src/app.ts', 'head')).toBe('new app\n');
    expect(await reader.readFile('src/app.ts', 'head')).toBe('new app\n');
    expect(await reader.readFile('missing.txt', 'head')).toBeNull();
    expect(await reader.readFile('../escape', 'head')).toBeNull();

    const appReads = calls.filter((c) => c.url.pathname === '/repos/acme/widgets/contents/src/app.ts');
    expect(appReads.map((c) => c.url.searchParams.get('ref'))).toEqual([MERGE_BASE, HEAD]);
    expect(calls.every((c) => c.url.pathname.startsWith('/repos/acme/widgets'))).toBe(true);
  });

  it('builds the repository context from the tree, README and manifests', async () => {
    installFetch();
    const { changeSet } = await new GitHubSource().load({ kind: 'github', url: PR_URL }, makeContext());
    expect(changeSet.repoContext.readmeExcerpt).toBe('# Widgets\n\nUseful widgets.');
    expect(changeSet.repoContext.manifests).toEqual([
      { path: 'package.json', excerpt: '{"name":"widgets"}' },
    ]);
    expect(changeSet.repoContext.tree).toEqual(['README.md', 'docs/', 'internal/', 'package.json', 'src/']);
    expect(changeSet.repoContext.treeTruncated).toBe(false);
  });

  it('falls back to the top level when GitHub cuts the tree short', async () => {
    const { calls } = installFetch({
      tree: (recursive) =>
        recursive
          ? json({ truncated: true, tree: [{ path: 'only/deep/file.txt', type: 'blob' }] })
          : json({
              truncated: false,
              tree: [
                { path: 'README.md', type: 'blob' },
                { path: 'src', type: 'tree' },
                { path: 'package.json', type: 'blob' },
              ],
            }),
    });
    const { changeSet } = await new GitHubSource().load({ kind: 'github', url: PR_URL }, makeContext());
    expect(changeSet.repoContext.tree).toEqual(['README.md', 'package.json', 'src/']);
    expect(changeSet.repoContext.treeTruncated).toBe(true);
    expect(
      calls
        .filter((c) => c.url.pathname.includes('/git/trees/'))
        .map((c) => c.url.searchParams.has('recursive')),
    ).toEqual([true, false]);
  });

  it('reads linked issues from the description when there is no token', async () => {
    installFetch();
    const { changeSet } = await new GitHubSource().load({ kind: 'github', url: PR_URL }, makeContext());
    expect(changeSet.linkedIssues).toEqual([
      {
        id: 'IS1',
        number: 3,
        title: 'Requests fail',
        body: 'Details',
        url: 'https://github.com/acme/widgets/issues/3',
      },
    ]);
  });

  it('masks a secret in a linked issue before it cuts the body to 4 KB', async () => {
    // The quoted value starts before character 4096 and ends after it.
    const secret = 'Zx9fQw3LmN8pR2vT7yKb';
    const body = `${'x'.repeat(4073)}\npassword = "${secret}"\n${'y'.repeat(900)}`;
    installFetch({
      issues: {
        3: { number: 3, title: 'Requests fail', body, html_url: 'https://github.com/acme/widgets/issues/3' },
      },
    });
    const { changeSet } = await new GitHubSource().load({ kind: 'github', url: PR_URL }, makeContext());
    const kept = changeSet.linkedIssues[0]!.body;
    expect(kept.length).toBeLessThanOrEqual(4096);
    expect(kept).toContain('password = "••••••••"');
    expect(kept).not.toContain(secret.slice(0, 6));
  });

  it('warns and carries on when the merge base cannot be computed', async () => {
    installFetch({ compare: () => json({ message: 'No common ancestor between X and Y.' }, 404) });
    const events: ProgressEvent[] = [];
    const { changeSet } = await new GitHubSource().load(
      { kind: 'github', url: PR_URL },
      makeContext({ events }),
    );
    expect(changeSet.base.sha).toBe(BASE);
    expect(events.some((e) => e.status === 'warn' && e.message.includes('merge base'))).toBe(true);
  });

  it('warns and carries on when optional parts fail', async () => {
    installFetch({ tree: () => json({ message: 'Not Found' }, 404), issues: {} });
    const events: ProgressEvent[] = [];
    const { changeSet } = await new GitHubSource().load(
      { kind: 'github', url: PR_URL },
      makeContext({ events }),
    );
    expect(changeSet.linkedIssues).toEqual([]);
    expect(changeSet.repoContext.tree).toEqual([]);
    expect(changeSet.repoContext.treeTruncated).toBe(true);
    expect(events.some((e) => e.status === 'warn' && e.message.includes('repository tree'))).toBe(true);
    expect(changeSet.files).toHaveLength(7);
  });

  it('stops on an error that matters, such as a missing pull request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ message: 'Not Found' }, 404)),
    );
    const error = await expectError(new GitHubSource().load({ kind: 'github', url: PR_URL }, makeContext()));
    expect(error.code).toBe('SOURCE_NOT_FOUND');
    expect(error.hint).toContain('token');
  });

  it('reports files that GitHub cut from the list, and commits beyond its limit', async () => {
    installFetch({ pull: { changed_files: 3500, commits: 400, additions: 100, deletions: 50 } });
    const { changeSet } = await new GitHubSource().load({ kind: 'github', url: PR_URL }, makeContext());
    expect(changeSet.stats.files).toBe(3500);
    expect(changeSet.files).toHaveLength(7);
    expect(changeSet.limits.filesCapped).toBe(true);
    expect(changeSet.limits.commitsCapped).toBe(true);
    expect(changeSet.limits.note).toContain('7 of 3500');
    expect(changeSet.limits.note).toContain('2 of 400 commits');
  });

  it('keeps hunks only for the largest changes when there are too many files', async () => {
    installFetch();
    const { changeSet } = await new GitHubSource({ limits: { maxHunkFiles: 1 } }).load(
      { kind: 'github', url: PR_URL },
      makeContext(),
    );
    const withHunks = changeSet.files.filter((f) => f.hunks.length > 0).map((f) => f.path);
    expect(withHunks).toEqual(['src/app.ts']);
    expect(changeSet.files.find((f) => f.path === 'docs/new.md')).toMatchObject({
      hunks: [],
      patchTruncated: true,
      additions: 1,
    });
    expect(changeSet.limits.filesCapped).toBe(true);
    expect(changeSet.limits.note).toContain('1 of 7');
  });

  it('marks files GitHub returned without a patch or counts as truncated', async () => {
    installFetch({
      files: [{ filename: 'src/odd.ts', status: 'modified', additions: 0, deletions: 0, changes: 0 }],
      pull: { changed_files: 1, additions: 4, deletions: 1 },
    });
    const { changeSet } = await new GitHubSource().load({ kind: 'github', url: PR_URL }, makeContext());
    expect(changeSet.files[0]).toMatchObject({ patchTruncated: true, binary: false, hunks: [] });
    // The pull request's own totals are kept even though this file's counts are zero.
    expect(changeSet.stats).toEqual({ files: 1, additions: 4, deletions: 1 });
  });

  it('rejects other inputs and bad URLs before any request', async () => {
    const { calls } = installFetch();
    const local = await expectError(
      new GitHubSource().load({ kind: 'local', repoPath: '.', base: null, head: null }, makeContext()),
    );
    expect(local.code).toBe('USAGE');
    const bad = await expectError(
      new GitHubSource().load({ kind: 'github', url: 'https://github.com/acme/widgets' }, makeContext()),
    );
    expect(bad.code).toBe('SOURCE_INVALID');
    expect(calls).toHaveLength(0);
  });
});
