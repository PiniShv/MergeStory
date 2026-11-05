import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allowedRoot, dir, gitInit, outsideDir, post, start, store } from '../testing/server.ts';

vi.mock('../sources/index.ts', async () =>
  (await import('../testing/server-sources.ts')).fakeSourcesModule(),
);

describe('POST /v1/jobs: local repositories', () => {
  const ceiling = process.env.GIT_CEILING_DIRECTORIES;
  beforeEach(() => {
    // Keep git from finding a repository above the test directory.
    process.env.GIT_CEILING_DIRECTORIES = dirname(dir);
    gitInit(join(allowedRoot, 'repo-a'));
    gitInit(join(outsideDir, 'repo-b'));
  });
  afterEach(() => {
    if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = ceiling;
  });

  it('rejects local paths when no root is allowed', async () => {
    const { base } = await start({ allowRoots: [] });
    const res = await post(base, { source: join(allowedRoot, 'repo-a') });
    expect(res.status).toBe(403);
    expect(res.json.error.hint).toContain('--allow-root');
    expect(await store.list()).toEqual([]);
  });

  it('accepts a repository inside an allowed root and passes on the real path', async () => {
    const { base } = await start();
    const res = await post(base, { source: join(allowedRoot, 'repo-a'), base: 'main', head: 'feature/x' });
    expect(res.status).toBe(202);
    const job = await store.read(res.json.id);
    expect(job.options.source).toEqual({
      kind: 'local',
      repoPath: join(allowedRoot, 'repo-a'),
      base: 'main',
      head: 'feature/x',
    });
    expect(job.options.base).toBe('main');
    expect(job.options.head).toBe('feature/x');
  });

  it('accepts the allowed root itself', async () => {
    const { base } = await start({ allowRoots: [join(allowedRoot, 'repo-a')] });
    expect((await post(base, { source: join(allowedRoot, 'repo-a') })).status).toBe(202);
  });

  it('passes on the top level of the repository for a directory inside it', async () => {
    await mkdir(join(allowedRoot, 'repo-a', 'src', 'lib'), { recursive: true });
    const { base } = await start();
    const res = await post(base, { source: join(allowedRoot, 'repo-a', 'src', 'lib') });
    expect(res.status).toBe(202);
    expect((await store.read(res.json.id)).options.source).toMatchObject({
      repoPath: join(allowedRoot, 'repo-a'),
    });
  });

  it('refuses a directory inside a root when git reads a repository above the root', async () => {
    // For example an allowed root inside a monorepo, or below a home directory that is a repository.
    const parent = join(dir, 'mono');
    await mkdir(join(parent, 'public', 'sub'), { recursive: true });
    gitInit(parent);
    const { base } = await start({ allowRoots: [join(parent, 'public')] });
    for (const source of [join(parent, 'public'), join(parent, 'public', 'sub')]) {
      const res = await post(base, { source, base: 'main', head: 'feature' });
      expect(res.status, source).toBe(403);
      expect(res.json.error.code).toBe('FORBIDDEN');
    }
    expect(await store.list()).toEqual([]);
  });

  it('refuses a work tree whose git directory is outside the roots', async () => {
    const { base } = await start();
    const outsideGit = join(outsideDir, 'repo-b', '.git');
    // A .git file that points elsewhere.
    await mkdir(join(allowedRoot, 'linked'));
    await writeFile(join(allowedRoot, 'linked', '.git'), `gitdir: ${outsideGit}\n`);
    // A .git directory that is a symbolic link.
    await mkdir(join(allowedRoot, 'symlinked'));
    await symlink(outsideGit, join(allowedRoot, 'symlinked', '.git'));
    // A linked work tree whose own git directory is inside, but whose shared one is outside.
    await mkdir(join(allowedRoot, 'worktree'));
    await mkdir(join(allowedRoot, 'worktree-meta'));
    await writeFile(join(allowedRoot, 'worktree', '.git'), `gitdir: ${join(allowedRoot, 'worktree-meta')}\n`);
    await writeFile(join(allowedRoot, 'worktree-meta', 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(join(allowedRoot, 'worktree-meta', 'commondir'), `${outsideGit}\n`);
    await writeFile(
      join(allowedRoot, 'worktree-meta', 'gitdir'),
      `${join(allowedRoot, 'worktree', '.git')}\n`,
    );
    for (const name of ['linked', 'symlinked', 'worktree']) {
      const res = await post(base, { source: join(allowedRoot, name) });
      expect(res.status, name).toBe(403);
    }
    expect(await store.list()).toEqual([]);
  });

  it('refuses a directory that is not a git work tree', async () => {
    await mkdir(join(allowedRoot, 'plain'));
    const { base } = await start();
    const res = await post(base, { source: join(allowedRoot, 'plain') });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('SOURCE_INVALID');
    expect(await store.list()).toEqual([]);
  });

  it('rejects paths outside every allowed root', async () => {
    const { base } = await start();
    const outside = [
      join(outsideDir, 'repo-b'),
      // A directory whose name only starts like the allowed root.
      join(dir, 'repos-evil', 'repo-c'),
      join(allowedRoot, '..', 'outside', 'repo-b'),
      join(allowedRoot, 'repo-a', '..', '..', 'outside'),
      '/',
      tmpdir(),
    ];
    for (const source of outside) {
      const res = await post(base, { source });
      expect(res.status, source).toBe(403);
      expect(res.json.error.code).toBe('FORBIDDEN');
    }
    expect(await store.list()).toEqual([]);
  });

  it('follows symbolic links before checking the root', async () => {
    const { base } = await start();
    await symlink(join(outsideDir, 'repo-b'), join(allowedRoot, 'link-out'));
    const res = await post(base, { source: join(allowedRoot, 'link-out') });
    expect(res.status).toBe(403);
    // A link that stays inside the root is fine and is resolved to its target.
    await symlink(join(allowedRoot, 'repo-a'), join(allowedRoot, 'link-in'));
    const ok = await post(base, { source: join(allowedRoot, 'link-in') });
    expect(ok.status).toBe(202);
    expect((await store.read(ok.json.id)).options.source).toMatchObject({
      repoPath: join(allowedRoot, 'repo-a'),
    });
  });

  it('gives the same answer for a missing path and a path outside the roots', async () => {
    const { base } = await start();
    const missing = await post(base, { source: join(allowedRoot, 'does-not-exist') });
    const outside = await post(base, { source: join(outsideDir, 'repo-b') });
    expect(missing.status).toBe(403);
    expect(missing.json).toEqual(outside.json);
  });

  it('rejects a file that is not a directory', async () => {
    const { base } = await start();
    await writeFile(join(allowedRoot, 'notes.txt'), 'x');
    expect((await post(base, { source: join(allowedRoot, 'notes.txt') })).status).toBe(403);
  });

  it('accepts several roots', async () => {
    const { base } = await start({ allowRoots: [join(allowedRoot, 'repo-a'), outsideDir] });
    expect((await post(base, { source: join(outsideDir, 'repo-b') })).status).toBe(202);
    expect((await post(base, { source: join(allowedRoot, 'repo-a') })).status).toBe(202);
    expect((await post(base, { source: join(allowedRoot) })).status).toBe(403);
  });

  it('does not check pull requests against the roots', async () => {
    const { base } = await start({ allowRoots: [] });
    for (const source of ['https://github.com/acme/widgets/pull/12', 'acme/widgets#12']) {
      const res = await post(base, { source });
      expect(res.status, source).toBe(202);
      expect((await store.read(res.json.id)).options.source).toEqual({ kind: 'github', url: source });
    }
  });

  it('refuses base and head for a pull request', async () => {
    const { base } = await start();
    const res = await post(base, { source: 'acme/widgets#12', base: 'main' });
    expect(res.status).toBe(400);
    expect(res.json.error.message).toMatch(/local repository/);
  });
});
