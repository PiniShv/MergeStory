import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clientWith,
  expectError,
  json,
  MAX_BYTES,
  MAX_COMMITS,
  memoryCache,
  mockFetch,
  route,
  SHA,
  TOKEN,
} from '../testing/github-client.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('pagination', () => {
  function files(count: number, offset = 0) {
    return Array.from({ length: count }, (_, i) => ({
      filename: `f${offset + i}.ts`,
      status: 'modified',
      additions: 1,
      deletions: 0,
      changes: 1,
      patch: '@@ -1 +1 @@\n-a\n+b',
    }));
  }

  it('follows Link headers for the file list', async () => {
    const { calls } = mockFetch((call) => {
      // GitHub's own Link headers point at the numeric repository path.
      if (!call.url.pathname.endsWith('/pulls/7/files')) return undefined;
      if (call.url.searchParams.get('page') === '2') return json(files(20, 100));
      return json(files(100), 200, {
        link: '<https://api.github.com/repositories/1/pulls/7/files?per_page=100&page=2>; rel="next", <https://api.github.com/repositories/1/pulls/7/files?per_page=100&page=2>; rel="last"',
      });
    });
    const result = await (await clientWith()).listPullRequestFiles();
    expect(result.files).toHaveLength(120);
    expect(result.capped).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url.searchParams.get('per_page')).toBe('100');
    expect(calls[1]!.url.pathname).toBe('/repositories/1/pulls/7/files');
  });

  it('stops at the cap and says so', async () => {
    mockFetch((call) => {
      if (call.url.pathname !== '/repos/acme/widgets/pulls/7/files') return undefined;
      const page = Number(call.url.searchParams.get('page') ?? '1');
      return json(files(100, (page - 1) * 100), 200, {
        link: `<https://api.github.com/repos/acme/widgets/pulls/7/files?per_page=100&page=${page + 1}>; rel="next"`,
      });
    });
    const result = await (await clientWith()).listPullRequestFiles({ maxFiles: 250 });
    expect(result.files).toHaveLength(250);
    expect(result.capped).toBe(true);
  });

  it('caps commits at 250', async () => {
    mockFetch((call) => {
      if (call.url.pathname !== '/repos/acme/widgets/pulls/7/commits') return undefined;
      const page = Number(call.url.searchParams.get('page') ?? '1');
      const commits = Array.from({ length: 100 }, (_, i) => ({
        sha: `${page}`.padStart(2, '0') + String(i).padStart(38, '0'),
        commit: { message: `c${page}-${i}\n\nbody` },
      }));
      return json(commits, 200, {
        link: `<https://api.github.com/repos/acme/widgets/pulls/7/commits?per_page=100&page=${page + 1}>; rel="next"`,
      });
    });
    const result = await (await clientWith()).listPullRequestCommits(MAX_COMMITS);
    expect(result.commits).toHaveLength(250);
    expect(result.capped).toBe(true);
    expect(result.commits[0]!.message).toBe('c1-0\n\nbody');
  });

  it('does not follow a Link header that leaves the API host', async () => {
    const { calls } = mockFetch(
      route('GET', '/repos/acme/widgets/pulls/7/files', () =>
        json(files(100), 200, { link: '<https://evil.example.com/steal?page=2>; rel="next"' }),
      ),
    );
    const client = await clientWith({ secrets: { GITHUB_TOKEN: TOKEN } });
    const result = await client.listPullRequestFiles();
    expect(result.files).toHaveLength(100);
    expect(calls.every((call) => call.url.host === 'api.github.com')).toBe(true);
  });

  it('asks again, one file at a time, for files that came back without a patch and with zero counts', async () => {
    const page = [
      ...files(2),
      { filename: 'big.ts', status: 'modified', additions: 0, deletions: 0, changes: 0 },
      { filename: 'logo.png', status: 'modified', additions: 0, deletions: 0, changes: 0 },
    ];
    const { calls } = mockFetch((call) => {
      if (call.url.pathname !== '/repos/acme/widgets/pulls/7/files') return undefined;
      if (call.url.searchParams.get('per_page') === '1') {
        expect(call.url.searchParams.get('page')).toBe('3');
        return json([
          {
            filename: 'big.ts',
            status: 'modified',
            additions: 5,
            deletions: 4,
            changes: 9,
            patch: '@@ -1 +1 @@\n-a\n+b',
          },
        ]);
      }
      return json(page);
    });
    const result = await (await clientWith()).listPullRequestFiles();
    expect(calls).toHaveLength(2);
    const big = result.files.find((f) => f.filename === 'big.ts')!;
    expect(big).toMatchObject({ additions: 5, deletions: 4, suspect: false });
    expect(big.patch).toContain('@@');
    // A PNG without a patch is simply binary, not suspect.
    expect(result.files.find((f) => f.filename === 'logo.png')).toMatchObject({
      suspect: false,
      patch: null,
    });
  });

  it('marks files it could not recover as suspect', async () => {
    mockFetch((call) => {
      if (call.url.pathname !== '/repos/acme/widgets/pulls/7/files') return undefined;
      if (call.url.searchParams.get('per_page') === '1')
        return json([{ filename: 'big.ts', status: 'modified', additions: 0, deletions: 0, changes: 0 }]);
      return json([{ filename: 'big.ts', status: 'modified', additions: 0, deletions: 0, changes: 0 }]);
    });
    const result = await (await clientWith()).listPullRequestFiles();
    expect(result.files[0]).toMatchObject({ suspect: true, patch: null });
  });
});

describe('getFileContent', () => {
  const raw = (text: string | Buffer, headers: Record<string, string> = {}) =>
    new Response(text, {
      status: 200,
      headers: { 'x-github-media-type': 'github.v3; param=raw; format=json', ...headers },
    });

  it('asks for the raw media type at the given ref, with the path encoded', async () => {
    const { calls } = mockFetch((call) =>
      call.url.pathname.startsWith('/repos/acme/widgets/contents/') ? raw('hello\r\nworld\r\n') : undefined,
    );
    const client = await clientWith();
    const text = await client.getFileContent('docs/my file #1/é.md', SHA, MAX_BYTES);
    expect(text).toBe('hello\nworld\n');
    expect(calls[0]!.headers.get('accept')).toBe('application/vnd.github.raw+json');
    expect(calls[0]!.url.pathname).toBe('/repos/acme/widgets/contents/docs/my%20file%20%231/%C3%A9.md');
    expect(calls[0]!.url.searchParams.get('ref')).toBe(SHA);
  });

  it('caches content by commit id, but not by branch name', async () => {
    const cache = memoryCache();
    const { calls } = mockFetch(() => raw('cached text'));
    const client = await clientWith({ cache });
    expect(await client.getFileContent('a.txt', SHA, MAX_BYTES)).toBe('cached text');
    expect(await client.getFileContent('a.txt', SHA, MAX_BYTES)).toBe('cached text');
    expect(calls).toHaveLength(1);
    expect(cache.store.size).toBe(1);
    expect([...cache.store.keys()][0]).toMatch(/^files\/[a-f0-9]{64}$/);
    // A different commit is a different entry.
    await client.getFileContent('a.txt', 'b'.repeat(40), MAX_BYTES);
    expect(calls).toHaveLength(2);
    // Branch names can move, so they are neither read from nor written to the cache.
    await client.getFileContent('a.txt', 'main', MAX_BYTES);
    await client.getFileContent('a.txt', 'main', MAX_BYTES);
    expect(calls).toHaveLength(4);
    expect(cache.store.size).toBe(2);
  });

  it('returns null for missing, binary, oversized and listing responses', async () => {
    const client = await clientWith();
    mockFetch(() => json({ message: 'Not Found' }, 404));
    expect(await client.getFileContent('missing.txt', SHA, MAX_BYTES)).toBeNull();

    mockFetch(() => raw(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2])));
    expect(await client.getFileContent('logo.png', SHA, MAX_BYTES)).toBeNull();

    mockFetch(() => raw('x', { 'content-length': String(2 * 1024 * 1024) }));
    expect(await client.getFileContent('big.txt', SHA, MAX_BYTES)).toBeNull();

    // No Content-Length: the body is cut off once it grows past 1 MiB.
    mockFetch(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(700 * 1024).fill(97));
              controller.enqueue(new Uint8Array(700 * 1024).fill(97));
              controller.close();
            },
          }),
        ),
    );
    expect(await client.getFileContent('streamed.txt', SHA, MAX_BYTES)).toBeNull();

    // A directory or submodule comes back as a JSON listing.
    mockFetch(
      () => new Response('[]', { status: 200, headers: { 'x-github-media-type': 'github.v3; format=json' } }),
    );
    expect(await client.getFileContent('src', SHA, MAX_BYTES)).toBeNull();

    // Files over 100 MB are refused outright.
    mockFetch(() => json({ message: 'too large', errors: [{ code: 'too_large' }] }, 403));
    expect(await client.getFileContent('huge.bin', SHA, MAX_BYTES)).toBeNull();
  });

  it('accepts a file just under 1 MiB', async () => {
    mockFetch(() => raw('a'.repeat(1024 * 1024 - 10)));
    expect((await (await clientWith()).getFileContent('ok.txt', SHA, MAX_BYTES))?.length).toBe(
      1024 * 1024 - 10,
    );
  });

  it('never requests or caches sensitive or excluded paths, or unsafe ones', async () => {
    const cache = memoryCache();
    const { calls } = mockFetch(() => raw('secret'));
    const client = await clientWith({ cache, config: { privacy: { excludePaths: ['internal/'] } } });
    for (const path of [
      '.env',
      'config/.env.production',
      'keys/id_rsa',
      'certs/server.pem',
      'internal/plan.md',
      '../etc/passwd',
      '/abs.txt',
      '',
    ]) {
      expect(await client.getFileContent(path, SHA, MAX_BYTES), path).toBeNull();
    }
    expect(calls).toHaveLength(0);
    expect(cache.store.size).toBe(0);
  });

  it('lets real errors through', async () => {
    mockFetch(() => json({ message: 'Bad credentials' }, 401));
    expect((await expectError((await clientWith()).getFileContent('a.txt', SHA, MAX_BYTES))).code).toBe(
      'GITHUB_AUTH',
    );
  });
});

describe('getTree', () => {
  it('lists entries and reports truncation', async () => {
    const { calls } = mockFetch(
      route('GET', `/repos/acme/widgets/git/trees/${SHA}`, (call) =>
        json({
          truncated: call.url.searchParams.has('recursive'),
          tree: [
            { path: 'src', type: 'tree' },
            { path: 'src/a.ts', type: 'blob' },
            { path: 'third_party/lib', type: 'commit' },
            { path: 'odd', type: 'weird' },
          ],
        }),
      ),
    );
    const client = await clientWith();
    const recursive = await client.getTree(SHA, { recursive: true });
    expect(recursive.truncated).toBe(true);
    expect(recursive.entries).toEqual([
      { path: 'src', type: 'tree' },
      { path: 'src/a.ts', type: 'blob' },
      { path: 'third_party/lib', type: 'commit' },
    ]);
    expect(calls[0]!.url.searchParams.get('recursive')).toBe('1');
    expect((await client.getTree(SHA)).truncated).toBe(false);
    expect(calls[1]!.url.searchParams.has('recursive')).toBe(false);
  });

  it('treats an empty repository as an empty tree', async () => {
    mockFetch(() => json({ message: 'Git Repository is empty.' }, 409));
    expect(await (await clientWith()).getTree(SHA, { recursive: true })).toEqual({
      entries: [],
      truncated: false,
    });
  });
});
