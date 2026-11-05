import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigInput } from '../core/config.ts';
import type { RunContext } from '../core/context.ts';
import { isMergeStoryError, type MergeStoryError } from '../core/errors.ts';
import { testContext } from '../testing/context.ts';
import {
  DESCRIPTION_END,
  DESCRIPTION_START,
  replaceMarkedSection,
  updatePullRequestDescription,
  upsertPullRequestComment,
} from './notify.ts';
import { parsePullRequestUrl } from './pr-url.ts';

const TOKEN = 'ghp_notifyTestTokenAAAAAAAAAAAAAAAAAAAAAAAA';
const MARKER = '<!-- mergestory:v1 -->';
const REF = parsePullRequestUrl('https://github.com/acme/widgets/pull/7');

interface Call {
  url: URL;
  method: string;
  body: string | null;
}
type Handler = (call: Call) => Response | undefined;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function mockFetch(...handlers: Handler[]): { calls: Call[] } {
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
        body: typeof init?.body === 'string' ? init.body : null,
      };
      calls.push(call);
      for (const handler of handlers) {
        const response = handler(call);
        if (response) return response;
      }
      return json({ message: 'Not Found' }, 404);
    }),
  );
  return { calls };
}

function route(method: string, pathname: string, respond: (call: Call) => Response): Handler {
  return (call) => (call.method === method && call.url.pathname === pathname ? respond(call) : undefined);
}

function makeContext(options: { token?: boolean; dryRun?: boolean; config?: ConfigInput } = {}): RunContext {
  return testContext({
    config: { github: { useGhCli: false }, ...options.config },
    secrets: options.token === false ? {} : { GITHUB_TOKEN: TOKEN },
    dryRun: options.dryRun,
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

const block = (content: string, newline = '\n') =>
  `${DESCRIPTION_START}${newline}${content}${newline}${DESCRIPTION_END}`;

describe('replaceMarkedSection', () => {
  it('appends the section after a blank line when the description has no markers', () => {
    expect(replaceMarkedSection('Fixes the thing.', 'Video: https://example.com/v')).toBe(
      `Fixes the thing.\n\n${block('Video: https://example.com/v')}`,
    );
    expect(replaceMarkedSection('Fixes the thing.\n\n\n', 'x')).toBe(`Fixes the thing.\n\n${block('x')}`);
  });

  it('uses just the section when the description is empty', () => {
    expect(replaceMarkedSection('', 'x')).toBe(block('x'));
    expect(replaceMarkedSection('  \n', 'x')).toBe(block('x'));
  });

  it('replaces an existing section and leaves everything else byte for byte', () => {
    const before = `Intro  \n\n## Notes\n- a\n\n${block('old video')}\n\nFooter\t\n`;
    const after = replaceMarkedSection(before, 'new video');
    expect(after).toBe(`Intro  \n\n## Notes\n- a\n\n${block('new video')}\n\nFooter\t\n`);
  });

  it('is idempotent', () => {
    const once = replaceMarkedSection('Body', 'section');
    expect(replaceMarkedSection(once, 'section')).toBe(once);
  });

  it('keeps CRLF line endings, including inside a multi-line section', () => {
    const description = 'Line one\r\nLine two';
    const result = replaceMarkedSection(description, 'a\nb');
    expect(result).toBe(`Line one\r\nLine two\r\n\r\n${block('a\r\nb', '\r\n')}`);
    expect(result.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('does not wrap a section that already carries the markers', () => {
    const wrapped = block('x');
    expect(replaceMarkedSection('Body', wrapped)).toBe(`Body\n\n${wrapped}`);
    expect(replaceMarkedSection(`Body\n\n${block('old')}`, wrapped)).toBe(`Body\n\n${wrapped}`);
  });

  it('never swallows text between a stray start marker and the real section', () => {
    const description = `${DESCRIPTION_START}\nImportant human text\n\n${block('old')}\nafter`;
    const result = replaceMarkedSection(description, 'new');
    expect(result).toBe(`${DESCRIPTION_START}\nImportant human text\n\n${block('new')}\nafter`);
  });

  it('adds a new section when only a start marker exists, and later updates only that section', () => {
    const description = `Intro\n${DESCRIPTION_START}\nhuman text`;
    const first = replaceMarkedSection(description, 'one');
    expect(first).toContain('human text');
    expect(first.endsWith(block('one'))).toBe(true);
    const second = replaceMarkedSection(first, 'two');
    expect(second).toContain('human text');
    expect(second.endsWith(block('two'))).toBe(true);
  });

  it('ignores an end marker that comes before any start marker', () => {
    const description = `${DESCRIPTION_END}\ntext`;
    const result = replaceMarkedSection(description, 'x');
    expect(result.startsWith(`${DESCRIPTION_END}\ntext`)).toBe(true);
    expect(result.endsWith(block('x'))).toBe(true);
  });
});

describe('upsertPullRequestComment', () => {
  const comment = (id: number, body: string, type = 'Bot') => ({
    id,
    body,
    html_url: `https://github.com/acme/widgets/pull/7#issuecomment-${id}`,
    user: { login: 'github-actions[bot]', type },
  });

  it('refuses to run in a dry run and sends nothing', async () => {
    const { calls } = mockFetch();
    const error = await expectError(
      upsertPullRequestComment(REF, `${MARKER}\nhi`, MARKER, makeContext({ dryRun: true })),
    );
    expect(error.code).toBe('NOTIFY_FAILED');
    expect(error.message).toContain('dry run');
    expect(calls).toHaveLength(0);
  });

  it('creates the comment when none carries the marker', async () => {
    const { calls } = mockFetch(
      route('GET', '/repos/acme/widgets/issues/7/comments', () => json([comment(1, 'LGTM', 'User')])),
      route('POST', '/repos/acme/widgets/issues/7/comments', () => json(comment(2, 'created'), 201)),
    );
    const result = await upsertPullRequestComment(REF, `${MARKER}\nVideo ready`, MARKER, makeContext());
    expect(result).toEqual({ url: 'https://github.com/acme/widgets/pull/7#issuecomment-2', created: true });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);
    expect(JSON.parse(calls[1]!.body!)).toEqual({ body: `${MARKER}\nVideo ready` });
  });

  it('adds the marker to the text when it is missing, so the next run finds the comment', async () => {
    const { calls } = mockFetch(
      route('GET', '/repos/acme/widgets/issues/7/comments', () => json([])),
      route('POST', '/repos/acme/widgets/issues/7/comments', () => json(comment(2, 'x'), 201)),
    );
    await upsertPullRequestComment(REF, 'Video ready', MARKER, makeContext());
    expect(JSON.parse(calls[1]!.body!).body).toBe(`${MARKER}\nVideo ready`);
  });

  it('updates the existing comment instead of posting another', async () => {
    const { calls } = mockFetch(
      route('GET', '/user', () => json({ login: 'github-actions[bot]' })),
      route('GET', '/repos/acme/widgets/issues/7/comments', () => json([comment(5, `${MARKER}\nold`)])),
      route('PATCH', '/repos/acme/widgets/issues/comments/5', () => json(comment(5, 'new'))),
    );
    const result = await upsertPullRequestComment(REF, `${MARKER}\nnew`, MARKER, makeContext());
    expect(result).toEqual({ url: 'https://github.com/acme/widgets/pull/7#issuecomment-5', created: false });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET', 'PATCH']);
  });

  it("never takes over someone else's comment that copies the marker", async () => {
    const { calls } = mockFetch(
      route('GET', '/user', () => json({ login: 'maintainer' })),
      route('GET', '/repos/acme/widgets/issues/7/comments', () =>
        json([comment(5, `${MARKER}\nphishing link`)]),
      ),
      route('POST', '/repos/acme/widgets/issues/7/comments', () => json(comment(6, 'fresh'), 201)),
    );
    const result = await upsertPullRequestComment(REF, `${MARKER}\nnew`, MARKER, makeContext());
    expect(result.created).toBe(true);
    expect(calls.map((c) => c.method)).not.toContain('PATCH');
  });

  it('posts a new comment when the account behind the token cannot be told', async () => {
    const { calls } = mockFetch(
      route('GET', '/user', () => json({ message: 'Resource not accessible by integration' }, 403)),
      route('POST', '/repos/acme/widgets/issues/7/comments', () => json(comment(6, 'fresh'), 201)),
    );
    const result = await upsertPullRequestComment(REF, `${MARKER}\nnew`, MARKER, makeContext());
    expect(result.created).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);
  });

  it('posts a new comment when the old one cannot be edited', async () => {
    for (const status of [403, 404]) {
      const { calls } = mockFetch(
        route('GET', '/user', () => json({ login: 'github-actions[bot]' })),
        route('GET', '/repos/acme/widgets/issues/7/comments', () => json([comment(5, `${MARKER}\nold`)])),
        route('PATCH', '/repos/acme/widgets/issues/comments/5', () => json({ message: 'nope' }, status)),
        route('POST', '/repos/acme/widgets/issues/7/comments', () => json(comment(6, 'fresh'), 201)),
      );
      const result = await upsertPullRequestComment(REF, `${MARKER}\nnew`, MARKER, makeContext());
      expect(result.created).toBe(true);
      expect(calls.map((c) => c.method)).toEqual(['GET', 'GET', 'PATCH', 'POST']);
    }
  });

  it('reports GitHub failures as NOTIFY_FAILED, keeping the hint', async () => {
    mockFetch(
      route('GET', '/repos/acme/widgets/issues/7/comments', () => json([])),
      route('POST', '/repos/acme/widgets/issues/7/comments', () =>
        json({ message: 'Resource not accessible by integration' }, 403),
      ),
    );
    const error = await expectError(upsertPullRequestComment(REF, `${MARKER}\nx`, MARKER, makeContext()));
    expect(error.code).toBe('NOTIFY_FAILED');
    expect(error.hint).toContain('Pull requests: write');
    expect(error.details).toMatchObject({ reason: 'GITHUB_AUTH', status: 403 });
    expect(error.message).not.toContain(TOKEN);
  });

  it('reports a missing token as NOTIFY_FAILED and writes nothing', async () => {
    const { calls } = mockFetch(route('GET', '/repos/acme/widgets/issues/7/comments', () => json([])));
    const error = await expectError(
      upsertPullRequestComment(REF, `${MARKER}\nx`, MARKER, makeContext({ token: false })),
    );
    expect(error.code).toBe('NOTIFY_FAILED');
    expect(error.details).toMatchObject({ reason: 'GITHUB_AUTH' });
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('rejects an empty marker and a comment that is too long, without any request', async () => {
    const { calls } = mockFetch();
    expect((await expectError(upsertPullRequestComment(REF, 'x', '  ', makeContext()))).code).toBe(
      'NOTIFY_FAILED',
    );
    const tooLong = await expectError(
      upsertPullRequestComment(REF, `${MARKER}${'x'.repeat(65_536)}`, MARKER, makeContext()),
    );
    expect(tooLong.code).toBe('NOTIFY_FAILED');
    expect(tooLong.message).toContain('65536');
    expect(calls).toHaveLength(0);
  });

  it('records the comment in the egress report', async () => {
    mockFetch(
      route('GET', '/repos/acme/widgets/issues/7/comments', () => json([])),
      route('POST', '/repos/acme/widgets/issues/7/comments', () => json(comment(2, 'x'), 201)),
    );
    const ctx = makeContext();
    await upsertPullRequestComment(REF, `${MARKER}\nhello`, MARKER, ctx);
    expect(ctx.egress.list()).toEqual([
      {
        destination: 'api.github.com',
        purpose: 'github-comment',
        bytes: Buffer.byteLength(`${MARKER}\nhello`),
        contains: ['comment'],
      },
    ]);
  });
});

describe('updatePullRequestDescription', () => {
  const pull = (body: string | null) => ({
    number: 7,
    title: 'T',
    body,
    state: 'open',
    base: { ref: 'main', sha: 'b'.repeat(40) },
    head: { ref: 'x', sha: 'a'.repeat(40) },
  });

  it('refuses to run in a dry run and sends nothing', async () => {
    const { calls } = mockFetch();
    const error = await expectError(updatePullRequestDescription(REF, 'x', makeContext({ dryRun: true })));
    expect(error.code).toBe('NOTIFY_FAILED');
    expect(calls).toHaveLength(0);
  });

  it('appends the section to the existing description', async () => {
    const { calls } = mockFetch(
      route('GET', '/repos/acme/widgets/pulls/7', () => json(pull('Existing text'))),
      route('PATCH', '/repos/acme/widgets/pulls/7', () => json({ number: 7 })),
    );
    await updatePullRequestDescription(REF, 'Video: https://example.com/v', makeContext());
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PATCH']);
    expect(JSON.parse(calls[1]!.body!)).toEqual({
      body: `Existing text\n\n${block('Video: https://example.com/v')}`,
    });
  });

  it('replaces an earlier section and handles an empty description', async () => {
    const first = mockFetch(
      route('GET', '/repos/acme/widgets/pulls/7', () => json(pull(`Intro\n\n${block('old')}\n\nOutro`))),
      route('PATCH', '/repos/acme/widgets/pulls/7', () => json({ number: 7 })),
    );
    await updatePullRequestDescription(REF, 'new', makeContext());
    expect(JSON.parse(first.calls[1]!.body!).body).toBe(`Intro\n\n${block('new')}\n\nOutro`);

    const second = mockFetch(
      route('GET', '/repos/acme/widgets/pulls/7', () => json(pull(null))),
      route('PATCH', '/repos/acme/widgets/pulls/7', () => json({ number: 7 })),
    );
    await updatePullRequestDescription(REF, 'new', makeContext());
    expect(JSON.parse(second.calls[1]!.body!).body).toBe(block('new'));
  });

  it('writes nothing when the section is already up to date', async () => {
    const { calls } = mockFetch(
      route('GET', '/repos/acme/widgets/pulls/7', () => json(pull(`Intro\n\n${block('same')}`))),
    );
    await updatePullRequestDescription(REF, 'same', makeContext());
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('refuses a description that would be too long', async () => {
    const { calls } = mockFetch(
      route('GET', '/repos/acme/widgets/pulls/7', () => json(pull('x'.repeat(65_000)))),
    );
    const error = await expectError(updatePullRequestDescription(REF, 'y'.repeat(1000), makeContext()));
    expect(error.code).toBe('NOTIFY_FAILED');
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });

  it('reports a missing token or a refused write as NOTIFY_FAILED', async () => {
    mockFetch(route('GET', '/repos/acme/widgets/pulls/7', () => json(pull('x'))));
    const anonymous = await expectError(
      updatePullRequestDescription(REF, 'y', makeContext({ token: false })),
    );
    expect(anonymous.code).toBe('NOTIFY_FAILED');

    mockFetch(
      route('GET', '/repos/acme/widgets/pulls/7', () => json(pull('x'))),
      route('PATCH', '/repos/acme/widgets/pulls/7', () =>
        json({ message: 'Resource not accessible by integration' }, 403),
      ),
    );
    const refused = await expectError(updatePullRequestDescription(REF, 'y', makeContext()));
    expect(refused.code).toBe('NOTIFY_FAILED');
    expect(refused.hint).toContain('forks');
  });
});
