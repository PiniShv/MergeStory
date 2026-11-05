import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clientWith,
  expectError,
  json,
  linked,
  MAX_ISSUES,
  makeContext,
  mockFetch,
  REF,
  route,
  TOKEN,
} from '../testing/github-client.ts';
import { GitHubClient } from './client.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('linked issues', () => {
  const issue = (number: number, extra: Record<string, unknown> = {}) => ({
    number,
    title: `Issue ${number}`,
    body: `Body of ${number}`,
    html_url: `https://github.com/acme/widgets/issues/${number}`,
    ...extra,
  });

  it('asks GraphQL when there is a token', async () => {
    const { calls } = mockFetch(
      route('POST', '/graphql', () =>
        json({
          data: {
            repository: {
              pullRequest: {
                closingIssuesReferences: {
                  nodes: [
                    {
                      number: 12,
                      title: 'Crash',
                      body: null,
                      url: 'https://github.com/acme/widgets/issues/12',
                      repository: { nameWithOwner: 'Acme/Widgets' },
                    },
                    // The token may read private repositories: their issues are never used.
                    {
                      number: 7,
                      title: 'Private plan',
                      body: 'Secret roadmap',
                      url: 'https://github.com/acme/internal-roadmap/issues/7',
                      repository: { nameWithOwner: 'acme/internal-roadmap' },
                    },
                    {
                      number: 8,
                      title: 'No repository',
                      body: 'x',
                      url: 'https://github.com/acme/widgets/issues/8',
                    },
                  ],
                },
              },
            },
          },
        }),
      ),
    );
    const issues = await linked(
      await clientWith({ secrets: { GITHUB_TOKEN: TOKEN } }),
      'no keywords here',
      MAX_ISSUES,
    );
    expect(issues).toEqual([
      { number: 12, title: 'Crash', body: '', url: 'https://github.com/acme/widgets/issues/12' },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({
      variables: { owner: 'acme', repo: 'widgets', number: 7 },
    });
  });

  it('reads "fixes #n" from the description over REST without a token, skipping pull requests and the PR itself', async () => {
    const { calls } = mockFetch(
      route('GET', '/repos/acme/widgets/issues/12', () => json(issue(12))),
      route('GET', '/repos/acme/widgets/issues/13', () => json(issue(13, { pull_request: { url: 'x' } }))),
      route('GET', '/repos/other/repo/issues/5', () =>
        json({ ...issue(5), html_url: 'https://github.com/other/repo/issues/5' }),
      ),
      route('GET', '/repos/acme/widgets/issues/20', () => json(issue(20))),
      route('GET', '/repos/acme/widgets/issues/21', () => json(issue(21))),
    );
    const body = [
      'Fixes #12.',
      'closes #13',
      'Resolves other/repo#5',
      'fixes #7',
      'Fixes #404',
      'fixes #20, fixes #21',
      '<!-- Fixes #99 -->',
      '`Fixes #98`',
    ].join('\n');
    const issues = await linked(await clientWith(), body, MAX_ISSUES);
    expect(issues.map((i) => i.number)).toEqual([12, 5]);
    // Capped at three references before any lookup, so #20 and #21 are never fetched.
    expect(calls.map((c) => c.url.pathname)).toEqual([
      '/repos/acme/widgets/issues/12',
      '/repos/acme/widgets/issues/13',
      '/repos/other/repo/issues/5',
    ]);
  });

  it('falls back to the description when GraphQL fails', async () => {
    mockFetch(
      route('POST', '/graphql', () => json({ errors: [{ message: 'nope' }] })),
      route('GET', '/repos/acme/widgets/issues/12', () => json(issue(12))),
    );
    const issues = await linked(
      await clientWith({ secrets: { GITHUB_TOKEN: TOKEN } }),
      'Fixes #12',
      MAX_ISSUES,
    );
    expect(issues.map((i) => i.number)).toEqual([12]);
  });

  it('with a token, follows only references to this repository when GraphQL fails', async () => {
    // The author of a PR on a public repository names private issues the maintainer's token can read.
    const { calls } = mockFetch(
      route('POST', '/graphql', () => json({ errors: [{ message: 'rate limited' }] })),
      route('GET', '/repos/victim-org/private-roadmap/issues/5', () => json(issue(5))),
      route('GET', '/repos/acme/private-plans/issues/3', () => json(issue(3))),
      route('GET', '/repos/acme/widgets/issues/12', () => json(issue(12))),
      route('GET', '/repos/Acme/Widgets/issues/13', () => json(issue(13))),
    );
    const body = [
      'Fixes victim-org/private-roadmap#5',
      'Fixes acme/private-plans#3',
      'Closes https://github.com/victim-org/private-roadmap/issues/6',
      'Fixes #12',
      'Fixes Acme/Widgets#13',
      'Fixes Acme/Widgets#7',
    ].join('\n');
    const issues = await linked(await clientWith({ secrets: { GITHUB_TOKEN: TOKEN } }), body, MAX_ISSUES);
    expect(issues.map((i) => i.number)).toEqual([12, 13]);
    expect(calls.map((c) => c.url.pathname)).toEqual([
      '/graphql',
      '/repos/acme/widgets/issues/12',
      '/repos/Acme/Widgets/issues/13',
    ]);
  });

  it('returns the whole issue body, so secrets can be masked before it is cut', async () => {
    mockFetch(
      route('GET', '/repos/acme/widgets/issues/12', () => json(issue(12, { body: 'x'.repeat(10_000) }))),
    );
    const [first] = await linked(await clientWith(), 'fixes #12', MAX_ISSUES);
    expect(first!.body).toHaveLength(10_000);
  });

  it('ignores links to other hosts', async () => {
    const { calls } = mockFetch();
    const issues = await linked(
      await clientWith(),
      'fixes https://evil.example.com/o/r/issues/1',
      MAX_ISSUES,
    );
    expect(issues).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('comments and writes', () => {
  const comment = (id: number, body: string, extra: Record<string, unknown> = {}) => ({
    id,
    body,
    html_url: `https://github.com/acme/widgets/pull/7#issuecomment-${id}`,
    user: { login: 'someone', type: 'User' },
    ...extra,
  });
  const MARKER = '<!-- mergestory:v1 -->';

  it('finds the marker comment across pages, but not a person quoting it', async () => {
    const { calls } = mockFetch((call) => {
      if (call.url.pathname !== '/repos/acme/widgets/issues/7/comments') return undefined;
      if (call.url.searchParams.get('page') === '2') {
        return json([
          comment(3, 'unrelated'),
          comment(4, `${MARKER}\nVideo: https://example.com/v`, {
            user: { login: 'github-actions[bot]', type: 'Bot' },
          }),
        ]);
      }
      return json([comment(1, 'LGTM'), comment(2, `> ${MARKER}\n> quoted by a person`)], 200, {
        link: '<https://api.github.com/repos/acme/widgets/issues/7/comments?per_page=100&page=2>; rel="next"',
      });
    });
    const found = await (await clientWith()).findCommentByMarker(MARKER, 'github-actions[bot]');
    expect(found?.id).toBe(4);
    expect(found?.url).toContain('issuecomment-4');
    expect(calls).toHaveLength(2);
  });

  it('only matches comments by the given account that start with the marker', async () => {
    mockFetch(
      route('GET', '/repos/acme/widgets/issues/7/comments', () =>
        json([
          comment(1, `Header\n${MARKER}`, { user: { login: 'bot[bot]', type: 'Bot' } }),
          comment(2, `${MARKER}\nlooks like ours`, { user: { login: 'mallory', type: 'User' } }),
          comment(3, `${MARKER}\nours`, { user: { login: 'Maintainer', type: 'User' } }),
        ]),
      ),
    );
    const client = await clientWith();
    expect(await client.findCommentByMarker(MARKER, 'bot[bot]')).toBeNull();
    expect((await client.findCommentByMarker(MARKER, 'maintainer'))?.id).toBe(3);
    expect(await client.findCommentByMarker(MARKER, 'someone-else')).toBeNull();
    expect(await client.findCommentByMarker('', 'maintainer')).toBeNull();
    expect(await client.findCommentByMarker(MARKER, '')).toBeNull();
  });

  it('tells which account the token belongs to, and null when it cannot', async () => {
    mockFetch(route('GET', '/user', () => json({ login: 'maintainer' })));
    expect(await (await clientWith({ secrets: { GITHUB_TOKEN: TOKEN } })).getAuthenticatedLogin()).toBe(
      'maintainer',
    );
    mockFetch(route('GET', '/user', () => json({ message: 'Resource not accessible by integration' }, 403)));
    expect(await (await clientWith({ secrets: { GITHUB_TOKEN: TOKEN } })).getAuthenticatedLogin()).toBeNull();
    expect(await (await clientWith()).getAuthenticatedLogin()).toBeNull();
  });

  it('creates and updates comments and the description, recording what was sent', async () => {
    const { calls } = mockFetch(
      route('POST', '/repos/acme/widgets/issues/7/comments', () => json(comment(10, 'new'), 201)),
      route('PATCH', '/repos/acme/widgets/issues/comments/10', () => json(comment(10, 'edited'))),
      route('PATCH', '/repos/acme/widgets/pulls/7', () => json({ number: 7 })),
    );
    const ctx = makeContext({ secrets: { GITHUB_TOKEN: TOKEN } });
    const client = await GitHubClient.create(REF, ctx);
    expect((await client.createComment('hello')).id).toBe(10);
    expect((await client.updateComment(10, 'edited')).id).toBe(10);
    await client.updatePullRequestBody('body');
    expect(calls.map((c) => [c.method, c.url.pathname])).toEqual([
      ['POST', '/repos/acme/widgets/issues/7/comments'],
      ['PATCH', '/repos/acme/widgets/issues/comments/10'],
      ['PATCH', '/repos/acme/widgets/pulls/7'],
    ]);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ body: 'hello' });
    expect(calls[0]!.headers.get('content-type')).toBe('application/json');
    expect(ctx.egress.list()).toEqual([
      { destination: 'api.github.com', purpose: 'github-comment', bytes: 5 + 6, contains: ['comment'] },
      { destination: 'api.github.com', purpose: 'github-description', bytes: 4, contains: ['comment'] },
    ]);
  });

  it('does not repeat a comment that may have been created (no retry for POST)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    let posts = 0;
    mockFetch((call) => {
      if (call.method !== 'POST') return undefined;
      posts++;
      return new Response('bad gateway', { status: 502 });
    });
    const client = await clientWith({ secrets: { GITHUB_TOKEN: TOKEN } });
    const pending = expectError(client.createComment('once'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await pending).code).toBe('GITHUB_FAILED');
    expect(posts).toBe(1);
  });

  it('refuses to write during a dry run, or without a token, and sends nothing', async () => {
    const { calls } = mockFetch();
    const dry = await clientWith({ secrets: { GITHUB_TOKEN: TOKEN }, dryRun: true });
    expect((await expectError(dry.createComment('x'))).code).toBe('NOTIFY_FAILED');
    expect((await expectError(dry.updateComment(1, 'x'))).code).toBe('NOTIFY_FAILED');
    expect((await expectError(dry.updatePullRequestBody('x'))).code).toBe('NOTIFY_FAILED');
    const anonymous = await clientWith();
    const error = await expectError(anonymous.createComment('x'));
    expect(error.code).toBe('GITHUB_AUTH');
    expect(error.hint).toContain('Pull requests: write');
    expect(calls).toHaveLength(0);
  });

  it('explains a 403 on write with the permission needed', async () => {
    mockFetch(() => json({ message: 'Resource not accessible by integration' }, 403));
    const client = await clientWith({ secrets: { GITHUB_TOKEN: TOKEN } });
    const error = await expectError(client.createComment('x'));
    expect(error.code).toBe('GITHUB_AUTH');
    expect(error.hint).toContain('Pull requests: write');
    expect(error.hint).toContain('forks');
  });
});
