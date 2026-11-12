import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ConfigInput } from '../core/config.ts';
import type { RunContext } from '../core/context.ts';
import { isMergeStoryError, type MergeStoryError } from '../core/errors.ts';
import type { LoadedSource } from '../core/providers.ts';
import type { ProgressEvent } from '../core/types.ts';
import { testContext } from '../testing/context.ts';
import { LocalGitSource, parseNameStatus, parseNumstat } from './local.ts';

// Built at run time, so the made-up token never appears whole in the source.
const SECRET_TOKEN = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
const SECRET_PASSWORD = 'hunter2hunter2';

function makeContext(overrides: ConfigInput = {}, events: ProgressEvent[] = []): RunContext {
  return testContext({ config: overrides, onProgress: (event) => events.push(event) }).ctx;
}

class TempRepo {
  readonly dir: string;

  private constructor(dir: string) {
    this.dir = dir;
  }

  /** A byte-for-byte copy of another repository (much cheaper than building one again). */
  static async copyOf(source: TempRepo): Promise<TempRepo> {
    const dir = await mkdtemp(join(tmpdir(), 'mergestory-local-'));
    await cp(source.dir, dir, { recursive: true });
    return new TempRepo(dir);
  }

  static async create(): Promise<TempRepo> {
    const dir = await mkdtemp(join(tmpdir(), 'mergestory-local-'));
    const repo = new TempRepo(dir);
    repo.git('init', '-q', '-b', 'main');
    repo.git('config', 'user.name', 'Test User');
    repo.git('config', 'user.email', 'test@example.com');
    repo.git('config', 'commit.gpgsign', 'false');
    return repo;
  }

  git(...args: string[]): string {
    return execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: this.dir, encoding: 'utf8' });
  }

  async write(path: string, content: string | Buffer): Promise<void> {
    const full = join(this.dir, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  }

  commit(message: string): void {
    this.git('add', '-A');
    execFileSync('git', ['commit', '-q', '-F', '-'], { cwd: this.dir, input: message, encoding: 'utf8' });
  }

  head(): string {
    return this.git('rev-parse', 'HEAD').trim();
  }

  async remove(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}

const repos: TempRepo[] = [];
async function newRepo(): Promise<TempRepo> {
  const repo = await TempRepo.create();
  repos.push(repo);
  return repo;
}

async function copyOfShared(shared: Scenario): Promise<TempRepo> {
  const repo = await TempRepo.copyOf(shared.repo);
  repos.push(repo);
  return repo;
}

/** Everything on disk under a directory, with sizes and modification times. */
function snapshot(dir: string): string {
  const lines: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(current, entry.name);
      const info = statSync(full);
      lines.push(`${full.slice(dir.length)} ${entry.isDirectory() ? 'dir' : info.size} ${info.mtimeMs}`);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return lines.join('\n');
}

const originalEnv = { ...process.env };
beforeAll(() => {
  // Keep the developer's own git settings out of the picture.
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(repos.splice(0).map((repo) => repo.remove()));
});
afterAll(() => {
  process.env.GIT_CONFIG_GLOBAL = originalEnv.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_NOSYSTEM = originalEnv.GIT_CONFIG_NOSYSTEM;
  if (originalEnv.GIT_CONFIG_GLOBAL === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  if (originalEnv.GIT_CONFIG_NOSYSTEM === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
});

interface Scenario {
  repo: TempRepo;
  baseSha: string;
  headSha: string;
}

/** main with a base commit, a feature branch with two commits, and a later commit on main. */
async function buildScenario(create: () => Promise<TempRepo> = newRepo): Promise<Scenario> {
  const repo = await create();
  await repo.write('README.md', '# Demo\n\nA demo project.\n');
  await repo.write('package.json', '{"name": "demo", "version": "1.0.0"}\n');
  await repo.write(
    'src/modified.ts',
    "export function greet(name: string): string {\n  return 'Hello, ' + name;\n}\n\nexport const VERSION = 1;\n",
  );
  await repo.write('old/name.ts', Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  await repo.write('legacy.txt', 'legacy one\nlegacy two\n');
  await repo.write('assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  await repo.write('run.sh', '#!/bin/sh\necho hi\n');
  repo.commit('Initial commit');
  const baseSha = repo.head();

  repo.git('checkout', '-q', '-b', 'feature/video');
  await repo.write('src/added.ts', 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n');
  await repo.write(
    'src/modified.ts',
    "export function greet(name: string): string {\n  return 'Hello, ' + name + '!';\n}\n\nexport const VERSION = 2;\n",
  );
  await repo.write('.env', `API_TOKEN=${SECRET_TOKEN}\nDB_PASSWORD=${SECRET_PASSWORD}\n`);
  await repo.write('internal/plan.md', '# Secret plan\nLaunch on Friday.\n');
  repo.commit('Add feature module');

  await mkdir(join(repo.dir, 'new'), { recursive: true });
  repo.git('mv', 'old/name.ts', 'new/name.ts');
  await repo.write(
    'new/name.ts',
    Array.from({ length: 10 }, (_, i) => (i === 4 ? 'line 5 edited' : `line ${i + 1}`)).join('\n') + '\n',
  );
  repo.git('rm', '-q', 'legacy.txt');
  await repo.write('assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9]));
  await chmod(join(repo.dir, 'run.sh'), 0o755);
  await repo.write('docs/guide notes.md', 'first\nsecond\n');
  await repo.write('café.txt', 'crème\n');
  repo.commit(
    'Rename, delete, retouch assets\n\nCo-authored-by: Jane Doe <jane@example.com>\nSigned-off-by: Jane Doe <jane@example.com>',
  );
  const headSha = repo.head();

  repo.git('checkout', '-q', 'main');
  await repo.write('main-only.txt', 'added on main after the branch was cut\n');
  repo.commit('Main moves on');
  repo.git('checkout', '-q', 'feature/video');
  return { repo, baseSha, headSha };
}

async function load(
  repo: TempRepo,
  input: Partial<{ base: string | null; head: string | null; repoPath: string }> = {},
  config: ConfigInput = {},
  events: ProgressEvent[] = [],
  source = new LocalGitSource(),
): Promise<LoadedSource> {
  return source.load(
    {
      kind: 'local',
      repoPath: input.repoPath ?? repo.dir,
      base: input.base ?? null,
      head: input.head ?? null,
    },
    makeContext(config, events),
  );
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

describe('parsers for git output', () => {
  it('parses name-status output, including renames, copies and odd names', () => {
    const output =
      [
        'A',
        'new.txt',
        'M',
        'dir/mod file.txt',
        'D',
        'gone.txt',
        'R090',
        'old.txt',
        'new name.txt',
        'C075',
        'a.txt',
        'b.txt',
        'T',
        'link',
      ].join('\0') + '\0';
    expect(parseNameStatus(output)).toEqual([
      { path: 'new.txt', oldPath: null, status: 'added' },
      { path: 'dir/mod file.txt', oldPath: null, status: 'modified' },
      { path: 'gone.txt', oldPath: null, status: 'deleted' },
      { path: 'new name.txt', oldPath: 'old.txt', status: 'renamed' },
      { path: 'b.txt', oldPath: 'a.txt', status: 'copied' },
      { path: 'link', oldPath: null, status: 'modified' },
    ]);
    expect(parseNameStatus('')).toEqual([]);
  });

  it('parses numstat output, including binary files, renames and tabs in names', () => {
    const output =
      ['2\t1\tsrc/a.ts', '-\t-\timg.png', '1\t1\t', 'old.txt', 'new.txt', '1\t0\twe\tird.txt'].join('\0') +
      '\0';
    const counts = parseNumstat(output);
    expect(counts.get('src/a.ts')).toEqual({ additions: 2, deletions: 1, binary: false });
    expect(counts.get('img.png')).toEqual({ additions: 0, deletions: 0, binary: true });
    expect(counts.get('new.txt')).toEqual({ additions: 1, deletions: 1, binary: false });
    expect(counts.get('we\tird.txt')).toEqual({ additions: 1, deletions: 0, binary: false });
    expect(counts.has('old.txt')).toBe(false);
  });
});

describe('LocalGitSource', () => {
  // Built once and only read by the tests that use it.
  let shared: Scenario;
  beforeAll(async () => {
    shared = await buildScenario(() => TempRepo.create());
  });
  afterAll(async () => {
    await shared.repo.remove();
  });

  it('reads the committed change against the merge base, never touching the repository', async () => {
    const { repo, baseSha, headSha } = shared;
    const statusBefore = repo.git('status', '--porcelain');
    const before = snapshot(repo.dir);

    const { changeSet } = await load(repo);

    expect(snapshot(repo.dir)).toBe(before);
    expect(repo.git('status', '--porcelain')).toBe(statusBefore);

    expect(changeSet.source).toBe('local');
    expect(changeSet.base).toEqual({ ref: 'main', sha: baseSha });
    expect(changeSet.head).toEqual({ ref: 'feature/video', sha: headSha });
    expect(changeSet.pr).toBeNull();
    expect(changeSet.linkedIssues).toEqual([]);
    expect(changeSet.limits).toEqual({ filesCapped: false, commitsCapped: false, note: null });
    expect(changeSet.repo).toMatchObject({
      host: 'local',
      owner: null,
      name: basename(repo.dir),
      isPrivate: null,
      defaultBranch: 'main',
      webUrl: null,
    });

    // The commit made on main after the branch was cut is not part of the change.
    const paths = changeSet.files.map((f) => f.path);
    expect(paths).not.toContain('main-only.txt');
    expect(paths).toEqual([
      '.env',
      'assets/logo.png',
      'café.txt',
      'docs/guide notes.md',
      'internal/plan.md',
      'legacy.txt',
      'new/name.ts',
      'run.sh',
      'src/added.ts',
      'src/modified.ts',
    ]);
    expect(changeSet.files.map((f) => f.id)).toEqual(Array.from({ length: 10 }, (_, i) => `F${i + 1}`));
    expect(changeSet.stats).toEqual({ files: 10, additions: 13, deletions: 5 });
  });

  it('describes each kind of change accurately', async () => {
    const { repo } = shared;
    const { changeSet } = await load(repo);
    const byPath = new Map(changeSet.files.map((f) => [f.path, f]));

    const modified = byPath.get('src/modified.ts')!;
    expect(modified).toMatchObject({
      status: 'modified',
      oldPath: null,
      additions: 2,
      deletions: 2,
      binary: false,
      language: 'typescript',
      patchTruncated: false,
      sensitive: false,
    });
    expect(modified.hunks).toHaveLength(1);
    expect(modified.hunks[0]).toMatchObject({
      id: `${modified.id}.H1`,
      oldStart: 1,
      oldLines: 5,
      newStart: 1,
      newLines: 5,
    });
    expect(modified.hunks[0]!.lines.map((l) => [l.kind, l.text, l.oldLine, l.newLine])).toEqual([
      ['ctx', 'export function greet(name: string): string {', 1, 1],
      ['del', "  return 'Hello, ' + name;", 2, null],
      ['add', "  return 'Hello, ' + name + '!';", null, 2],
      ['ctx', '}', 3, 3],
      ['ctx', '', 4, 4],
      ['del', 'export const VERSION = 1;', 5, null],
      ['add', 'export const VERSION = 2;', null, 5],
    ]);

    const added = byPath.get('src/added.ts')!;
    expect(added).toMatchObject({ status: 'added', additions: 3, deletions: 0 });
    expect(added.hunks[0]!.lines.map((l) => [l.kind, l.newLine])).toEqual([
      ['add', 1],
      ['add', 2],
      ['add', 3],
    ]);

    const deleted = byPath.get('legacy.txt')!;
    expect(deleted).toMatchObject({
      status: 'deleted',
      path: 'legacy.txt',
      oldPath: null,
      additions: 0,
      deletions: 2,
    });
    expect(deleted.hunks[0]!.lines.every((l) => l.kind === 'del')).toBe(true);

    const renamed = byPath.get('new/name.ts')!;
    expect(renamed).toMatchObject({ status: 'renamed', oldPath: 'old/name.ts', additions: 1, deletions: 1 });
    expect(renamed.hunks[0]!.lines.filter((l) => l.kind !== 'ctx').map((l) => [l.kind, l.text])).toEqual([
      ['del', 'line 5'],
      ['add', 'line 5 edited'],
    ]);

    const binary = byPath.get('assets/logo.png')!;
    expect(binary).toMatchObject({
      binary: true,
      additions: 0,
      deletions: 0,
      hunks: [],
      patchTruncated: false,
    });

    const modeOnly = byPath.get('run.sh')!;
    expect(modeOnly).toMatchObject({
      status: 'modified',
      additions: 0,
      deletions: 0,
      hunks: [],
      patchTruncated: false,
    });
    expect(modeOnly.language).toBe('shellscript');

    expect(byPath.get('docs/guide notes.md')).toMatchObject({
      status: 'added',
      additions: 2,
      language: 'markdown',
    });
    expect(byPath.get('café.txt')!.hunks[0]!.lines[0]!.text).toBe('crème');
  });

  it('never keeps the content of sensitive files', async () => {
    const { repo } = shared;
    const { changeSet, reader } = await load(repo);

    const env = changeSet.files.find((f) => f.path === '.env')!;
    expect(env).toMatchObject({ sensitive: true, hunks: [], additions: 2, patchTruncated: false });
    const serialised = JSON.stringify(changeSet);
    expect(serialised).not.toContain(SECRET_TOKEN);
    expect(serialised).not.toContain(SECRET_PASSWORD);
    expect(changeSet.repoContext.tree).not.toContain('.env');

    expect(await reader.readFile('.env', 'head')).toBeNull();
    expect(await reader.readFile('.env', 'base')).toBeNull();
  });

  it('treats configured exclude paths exactly like sensitive files', async () => {
    const { repo } = shared;
    const { changeSet, reader } = await load(repo, {}, { privacy: { excludePaths: ['internal/'] } });
    const plan = changeSet.files.find((f) => f.path === 'internal/plan.md')!;
    expect(plan).toMatchObject({ sensitive: true, hunks: [], additions: 2 });
    expect(JSON.stringify(changeSet)).not.toContain('Launch on Friday');
    expect(await reader.readFile('internal/plan.md', 'head')).toBeNull();
    expect(changeSet.repoContext.tree.some((entry) => entry.startsWith('internal'))).toBe(false);
    // Other files are unaffected.
    expect(changeSet.files.find((f) => f.path === 'src/added.ts')!.hunks).toHaveLength(1);

    // Without the setting the file is an ordinary one.
    const plain = await load(repo);
    expect(plain.changeSet.files.find((f) => f.path === 'internal/plan.md')).toMatchObject({
      sensitive: false,
    });
    expect(await plain.reader.readFile('internal/plan.md', 'head')).toContain('Launch on Friday');
  });

  it('treats a rename to or from a sensitive path as sensitive', async () => {
    const repo = await newRepo();
    await repo.write('README.md', 'x\n');
    await repo.write('credentials.json', `{"password": "${SECRET_PASSWORD}"}\n`);
    repo.commit('base');
    repo.git('checkout', '-q', '-b', 'topic');
    repo.git('mv', 'credentials.json', 'data.json');
    repo.commit('rename');
    const { changeSet } = await load(repo);
    expect(changeSet.files).toHaveLength(1);
    expect(changeSet.files[0]).toMatchObject({
      path: 'data.json',
      oldPath: 'credentials.json',
      sensitive: true,
      hunks: [],
    });
    expect(JSON.stringify(changeSet)).not.toContain(SECRET_PASSWORD);
  });

  it('treats a rename away from an excluded path as sensitive', async () => {
    const repo = await newRepo();
    await repo.write('README.md', 'x\n');
    await repo.write('internal/plan.md', `${'plan line\n'.repeat(10)}Launch on Friday\n`);
    repo.commit('base');
    repo.git('checkout', '-q', '-b', 'topic');
    await repo.write('internal/plan.md', `${'plan line\n'.repeat(10)}Launch later\n`);
    repo.git('mv', 'internal/plan.md', 'plan.md');
    repo.commit('rename');
    const { changeSet } = await load(repo, {}, { privacy: { excludePaths: ['internal/'] } });
    expect(changeSet.files).toHaveLength(1);
    expect(changeSet.files[0]).toMatchObject({
      path: 'plan.md',
      oldPath: 'internal/plan.md',
      sensitive: true,
      hunks: [],
    });
    expect(JSON.stringify(changeSet)).not.toContain('Launch');
  });

  it('lists commits oldest first, without author data, and cleans their messages', async () => {
    const { repo } = shared;
    const { changeSet } = await load(repo);
    expect(changeSet.commits.map((c) => [c.id, c.subject])).toEqual([
      ['CM1', 'Add feature module'],
      ['CM2', 'Rename, delete, retouch assets'],
    ]);
    expect(changeSet.commits[1]!.body).toBe('');
    for (const commit of changeSet.commits) {
      expect(Object.keys(commit).sort()).toEqual(['body', 'id', 'sha', 'subject']);
    }
    const serialised = JSON.stringify(changeSet);
    expect(serialised).not.toContain('jane@example.com');
    expect(serialised).not.toContain('Jane Doe');
    expect(serialised).not.toContain('Test User');
    expect(serialised).not.toContain('test@example.com');
  });

  it('keeps one commit when its message holds separator bytes and a fake sha', async () => {
    const repo = await newRepo();
    await repo.write('a.txt', 'a\n');
    repo.commit('first');
    const base = repo.head();
    await repo.write('a.txt', 'b\n');
    repo.commit(`fix\x1e${'a'.repeat(40)}\x1fReviewed by the CTO`);
    const { changeSet } = await load(repo, { base, head: repo.head() });
    expect(changeSet.commits).toHaveLength(1);
    expect(changeSet.commits[0]!.sha).toBe(repo.head());
    expect(changeSet.commits[0]!.subject).toContain('fix');
  });

  it('builds the repository context', async () => {
    const { repo } = shared;
    const { changeSet } = await load(repo);
    const context = changeSet.repoContext;
    expect(context.readmeExcerpt).toContain('# Demo');
    expect(context.manifests).toEqual([
      { path: 'package.json', excerpt: '{"name": "demo", "version": "1.0.0"}' },
    ]);
    expect(context.tree).toEqual(
      expect.arrayContaining(['README.md', 'package.json', 'src/', 'docs/', 'new/']),
    );
    expect(context.tree).not.toContain('main-only.txt');
    expect(context.treeTruncated).toBe(false);
  });

  it('reads file contents at both sides, read-only', async () => {
    const { repo } = shared;
    const { reader } = await load(repo);
    expect(await reader.readFile('src/modified.ts', 'base')).toContain("'Hello, ' + name");
    expect(await reader.readFile('src/modified.ts', 'head')).toContain("'Hello, ' + name + '!'");
    // Base is the merge base: a file added later on main is not there, and neither is an added file.
    expect(await reader.readFile('main-only.txt', 'head')).toBeNull();
    expect(await reader.readFile('src/added.ts', 'base')).toBeNull();
    expect(await reader.readFile('legacy.txt', 'head')).toBeNull();
    expect(await reader.readFile('legacy.txt', 'base')).toBe('legacy one\nlegacy two\n');
    // Renamed files are read at their old path on the base side.
    expect(await reader.readFile('old/name.ts', 'base')).toContain('line 5\n');
    // Binary files, directories, missing files and unsafe paths all read as null.
    expect(await reader.readFile('assets/logo.png', 'head')).toBeNull();
    expect(await reader.readFile('src', 'head')).toBeNull();
    expect(await reader.readFile('nope.txt', 'head')).toBeNull();
    expect(await reader.readFile('../outside.txt', 'head')).toBeNull();
    expect(await reader.readFile('/etc/passwd', 'head')).toBeNull();
    expect(await reader.readFile('', 'head')).toBeNull();
  });

  it('returns null for files over 1 MiB and normalises line endings', async () => {
    const repo = await newRepo();
    await repo.write('README.md', 'x\n');
    repo.commit('base');
    repo.git('checkout', '-q', '-b', 'topic');
    await repo.write('big.txt', `${'a'.repeat(1024 * 1024)}\nmore\n`);
    await repo.write('crlf.txt', '\ufeffone\r\ntwo\r\n');
    repo.commit('add');
    const { reader } = await load(repo);
    expect(await reader.readFile('big.txt', 'head')).toBeNull();
    expect(await reader.readFile('crlf.txt', 'head')).toBe('one\ntwo\n');
  });

  it('handles CRLF files, a missing final newline, and names that look like options or wildcards', async () => {
    const repo = await newRepo();
    await repo.write('README.md', 'x\n');
    await repo.write('crlf.txt', 'a\r\nb\r\nc\r\n');
    await repo.write('nonl.txt', 'one\ntwo');
    repo.commit('base');
    repo.git('checkout', '-q', '-b', 'topic');
    await repo.write('crlf.txt', 'a\r\nB\r\nc\r\n');
    await repo.write('nonl.txt', 'one\ntwo!');
    await repo.write('-rf.txt', 'dash\n');
    await repo.write('a[1].txt', 'bracket\n');
    await repo.write('*.md', 'star\n');
    await repo.write('a1.txt', 'would match a[1].txt as a glob\n');
    repo.commit('change');
    const { changeSet } = await load(repo);
    const byPath = new Map(changeSet.files.map((f) => [f.path, f]));

    expect(byPath.get('crlf.txt')!.hunks[0]!.lines.map((l) => l.text)).toEqual(['a', 'b', 'B', 'c']);
    expect(
      byPath
        .get('nonl.txt')!
        .hunks[0]!.lines.filter((l) => l.kind !== 'ctx')
        .map((l) => l.text),
    ).toEqual(['two', 'two!']);
    for (const name of ['-rf.txt', 'a[1].txt', '*.md', 'a1.txt']) {
      const file = byPath.get(name)!;
      expect(file.hunks, name).toHaveLength(1);
      expect(file.patchTruncated, name).toBe(false);
    }
    expect(byPath.get('a[1].txt')!.hunks[0]!.lines[0]!.text).toBe('bracket');
    expect(byPath.get('*.md')!.hunks[0]!.lines[0]!.text).toBe('star');
  });

  it('accepts explicit refs, and reduces an explicit base to the merge base', async () => {
    const { repo, baseSha, headSha } = shared;
    const viaBranch = await load(repo, { base: 'main', head: 'feature/video' });
    expect(viaBranch.changeSet.base).toEqual({ ref: 'main', sha: baseSha });
    expect(viaBranch.changeSet.head).toEqual({ ref: 'feature/video', sha: headSha });
    expect(viaBranch.changeSet.files.map((f) => f.path)).not.toContain('main-only.txt');

    const short = baseSha.slice(0, 10);
    const viaSha = await load(repo, { base: short, head: headSha });
    expect(viaSha.changeSet.base).toEqual({ ref: short, sha: baseSha });
    expect(viaSha.changeSet.head.sha).toBe(headSha);
    expect(viaSha.changeSet.commits).toHaveLength(2);

    // A narrower range: just the last commit.
    const last = await load(repo, { base: `${headSha}~1`, head: 'HEAD' });
    expect(last.changeSet.commits.map((c) => c.subject)).toEqual(['Rename, delete, retouch assets']);
    expect(last.changeSet.files.map((f) => f.path)).not.toContain('src/added.ts');
  });

  it('reads github.com remotes without keeping credentials', async () => {
    const repo = await copyOfShared(shared);
    repo.git(
      'remote',
      'add',
      'origin',
      'https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/acme/widgets.git',
    );
    const { changeSet } = await load(repo);
    expect(changeSet.repo).toMatchObject({
      host: 'github.com',
      owner: 'acme',
      name: 'widgets',
      isPrivate: null,
      webUrl: 'https://github.com/acme/widgets',
    });
    expect(JSON.stringify(changeSet)).not.toContain('ghp_');

    repo.git('remote', 'set-url', 'origin', 'git@gitlab.com:acme/widgets.git');
    const other = await load(repo);
    expect(other.changeSet.repo).toMatchObject({ host: 'local', owner: null, webUrl: null });
  });

  it('finds the default branch through origin/HEAD when there is no local main', async () => {
    const { baseSha } = shared;
    const repo = await copyOfShared(shared);
    repo.git('update-ref', 'refs/remotes/origin/trunk', baseSha);
    repo.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
    repo.git('branch', '-q', '-m', 'main', 'old-main');
    const { changeSet } = await load(repo);
    expect(changeSet.base).toEqual({ ref: 'trunk', sha: baseSha });
    expect(changeSet.repo.defaultBranch).toBe('trunk');
  });

  it('falls back to master', async () => {
    const { baseSha } = shared;
    const repo = await copyOfShared(shared);
    repo.git('branch', '-q', '-m', 'main', 'master');
    const { changeSet } = await load(repo);
    expect(changeSet.base).toEqual({ ref: 'master', sha: baseSha });
  });

  it('works from a subdirectory of the repository', async () => {
    const { repo, baseSha } = shared;
    const { changeSet } = await load(repo, { repoPath: join(repo.dir, 'src') });
    expect(changeSet.base.sha).toBe(baseSha);
    expect(changeSet.files).toHaveLength(10);
    expect(changeSet.repo.name).toBe(basename(repo.dir));
  });

  it('warns about uncommitted changes and leaves them out', async () => {
    const repo = await copyOfShared(shared);
    await repo.write('src/modified.ts', 'export const uncommitted = true;\n');
    await repo.write('untracked.txt', 'new\n');
    const events: ProgressEvent[] = [];
    const { changeSet } = await load(repo, {}, {}, events);
    const warning = events.find((e) => e.status === 'warn');
    expect(warning?.message).toMatch(/2 uncommitted changes/);
    expect(JSON.stringify(changeSet)).not.toContain('uncommitted = true');
    expect(changeSet.files.map((f) => f.path)).not.toContain('untracked.txt');
  });

  it('does not warn when the working tree is clean', async () => {
    const { repo } = shared;
    const events: ProgressEvent[] = [];
    await load(repo, {}, {}, events);
    expect(events.filter((e) => e.status === 'warn')).toEqual([]);
  });

  it('is not affected by hostile git configuration or environment', async () => {
    const repo = await copyOfShared(shared);
    const baseline = JSON.stringify((await load(repo)).changeSet);
    const marker = join(repo.dir, '..', `fsmonitor-ran-${basename(repo.dir)}`);
    await writeFile(
      join(tmpdir(), `mergestory-hook-${basename(repo.dir)}.sh`),
      `#!/bin/sh\ntouch '${marker}'\nprintf '\\0'\n`,
      { mode: 0o755 },
    );
    for (const [key, value] of [
      ['diff.noprefix', 'true'],
      ['diff.mnemonicPrefix', 'true'],
      ['diff.srcPrefix', 'x/'],
      ['diff.dstPrefix', 'y/'],
      ['diff.renames', 'false'],
      ['diff.external', 'false'],
      ['diff.suppressBlankEmpty', 'true'],
      ['diff.context', '9'],
      ['diff.submodule', 'log'],
      ['core.quotepath', 'true'],
      ['core.pager', 'false'],
      ['log.showSignature', 'true'],
      ['i18n.logOutputEncoding', 'ISO-8859-1'],
      ['core.fsmonitor', join(tmpdir(), `mergestory-hook-${basename(repo.dir)}.sh`)],
    ] as const) {
      repo.git('config', '--local', key, value);
    }
    // A stray GIT_DIR (as set inside a git hook) must not redirect git to another repository.
    const other = await newRepo();
    vi.stubEnv('GIT_DIR', join(other.dir, '.git'));
    vi.stubEnv('GIT_WORK_TREE', other.dir);
    vi.stubEnv('GIT_EXTERNAL_DIFF', 'false');
    const hostile = JSON.stringify((await load(repo)).changeSet);
    expect(hostile).toBe(baseline);
    expect(existsSync(marker)).toBe(false);
    await rm(join(tmpdir(), `mergestory-hook-${basename(repo.dir)}.sh`), { force: true });
  });

  it('never runs a diff or text conversion program that .gitattributes names', async () => {
    const repo = await copyOfShared(shared);
    const baseline = JSON.stringify((await load(repo)).changeSet);
    const marker = join(repo.dir, '..', `textconv-ran-${basename(repo.dir)}`);
    const script = join(tmpdir(), `mergestory-textconv-${basename(repo.dir)}.sh`);
    await writeFile(script, `#!/bin/sh\ntouch '${marker}'\necho converted\n`, { mode: 0o755 });
    await repo.write('.git/info/attributes', '* diff=evil\n');
    repo.git('config', '--local', 'diff.evil.textconv', script);
    repo.git('config', '--local', 'diff.evil.command', script);
    const hostile = JSON.stringify((await load(repo)).changeSet);
    expect(hostile).toBe(baseline);
    expect(existsSync(marker)).toBe(false);
    await rm(script, { force: true });
  });

  describe('limits', () => {
    async function repoWithFiles(sizes: Record<string, number>): Promise<TempRepo> {
      const repo = await newRepo();
      await repo.write('README.md', 'x\n');
      repo.commit('base');
      repo.git('checkout', '-q', '-b', 'topic');
      for (const [name, lines] of Object.entries(sizes)) {
        await repo.write(
          name,
          Array.from({ length: lines }, (_, i) => `${name} line ${i + 1}`).join('\n') + '\n',
        );
      }
      repo.commit('many files');
      return repo;
    }

    it('keeps hunks for the files with the most changed lines, and says so', async () => {
      const repo = await repoWithFiles({ 'a.txt': 1, 'b.txt': 5, 'c.txt': 3, 'd.txt': 2 });
      const { changeSet } = await load(repo, {}, {}, [], new LocalGitSource({ limits: { maxHunkFiles: 2 } }));
      const withHunks = changeSet.files.filter((f) => f.hunks.length > 0).map((f) => f.path);
      expect(withHunks).toEqual(['b.txt', 'c.txt']);
      const dropped = changeSet.files.filter((f) => f.hunks.length === 0);
      expect(dropped.map((f) => f.path)).toEqual(['a.txt', 'd.txt']);
      expect(dropped.every((f) => f.patchTruncated)).toBe(true);
      // Metadata stays complete.
      expect(dropped.map((f) => f.additions)).toEqual([1, 2]);
      expect(changeSet.stats).toEqual({ files: 4, additions: 11, deletions: 0 });
      expect(changeSet.limits.filesCapped).toBe(true);
      expect(changeSet.limits.note).toContain('2 of 4');
    });

    it('leaves out the hunks of a file that is too large on its own', async () => {
      const repo = await repoWithFiles({ 'big.txt': 60, 'small.txt': 3 });
      const { changeSet } = await load(
        repo,
        {},
        {},
        [],
        new LocalGitSource({ limits: { maxFilePatchLines: 50 } }),
      );
      const big = changeSet.files.find((f) => f.path === 'big.txt')!;
      expect(big).toMatchObject({ hunks: [], patchTruncated: true, additions: 60 });
      expect(changeSet.files.find((f) => f.path === 'small.txt')!.hunks).toHaveLength(1);
      expect(changeSet.limits.note).toContain('more than 50 changed lines');
    });

    it('leaves out the hunks of a file that changed type', async () => {
      const repo = await newRepo();
      await repo.write('a.txt', 'one\ntwo\n');
      repo.commit('base');
      const base = repo.head();
      await rm(join(repo.dir, 'a.txt'));
      await symlink('elsewhere', join(repo.dir, 'a.txt'));
      repo.commit('replace with a link');
      const { changeSet } = await load(repo, { base, head: repo.head() });
      const file = changeSet.files.find((f) => f.path === 'a.txt')!;
      expect(file.hunks).toEqual([]);
      expect(file.patchTruncated).toBe(true);
    });

    it('keeps the hunks of a text file whose content has a line that looks like a diff header', async () => {
      const repo = await newRepo();
      await repo.write('a.txt', 'one\n');
      repo.commit('base');
      const base = repo.head();
      await repo.write('a.txt', 'one\ndiff --git a/x b/x\n');
      repo.commit('add a line');
      const { changeSet } = await load(repo, { base, head: repo.head() });
      const file = changeSet.files.find((f) => f.path === 'a.txt')!;
      expect(file.hunks).toHaveLength(1);
      expect(file.patchTruncated).toBe(false);
    });

    it('caps the number of files listed but still reports the full totals', async () => {
      const repo = await repoWithFiles({ 'a.txt': 1, 'b.txt': 1, 'c.txt': 1, 'd.txt': 1, 'e.txt': 1 });
      const { changeSet } = await load(repo, {}, {}, [], new LocalGitSource({ limits: { maxFiles: 3 } }));
      expect(changeSet.files.map((f) => f.path)).toEqual(['a.txt', 'b.txt', 'c.txt']);
      expect(changeSet.stats).toEqual({ files: 5, additions: 5, deletions: 0 });
      expect(changeSet.limits.filesCapped).toBe(true);
      expect(changeSet.limits.note).toContain('first 3 of 5');
    });

    it('keeps the oldest commits when there are too many', async () => {
      const repo = await newRepo();
      await repo.write('README.md', 'x\n');
      repo.commit('base');
      repo.git('checkout', '-q', '-b', 'topic');
      for (let i = 1; i <= 5; i++) {
        await repo.write(`f${i}.txt`, `${i}\n`);
        repo.commit(`commit ${i}`);
      }
      const { changeSet } = await load(repo, {}, {}, [], new LocalGitSource({ limits: { maxCommits: 2 } }));
      expect(changeSet.commits.map((c) => [c.id, c.subject])).toEqual([
        ['CM1', 'commit 1'],
        ['CM2', 'commit 2'],
      ]);
      expect(changeSet.limits.commitsCapped).toBe(true);
      expect(changeSet.limits.note).toContain('oldest 2 of 5');
    });
  });

  describe('errors', () => {
    it('rejects refs that start with a dash without running git on them', async () => {
      const { repo } = shared;
      const target = join(tmpdir(), `mergestory-injected-${basename(repo.dir)}`);
      for (const ref of [`--output=${target}`, '-h', '--upload-pack=x']) {
        const error = await expectError(load(repo, { base: ref }));
        expect(error.code).toBe('SOURCE_INVALID');
        expect(error.hint).toBeTruthy();
        const headError = await expectError(load(repo, { head: ref }));
        expect(headError.code).toBe('SOURCE_INVALID');
      }
      expect(existsSync(target)).toBe(false);
    });

    it('reports an unknown ref', async () => {
      const { repo } = shared;
      const error = await expectError(load(repo, { base: 'no-such-branch' }));
      expect(error.code).toBe('SOURCE_NOT_FOUND');
      expect(error.message).toContain('no-such-branch');
      expect(error.hint).toContain('git fetch');
    });

    it('reports a path that is not a git work tree, does not exist, or is a file', async () => {
      const plain = await mkdtemp(join(tmpdir(), 'mergestory-plain-'));
      try {
        const notRepo = await expectError(
          new LocalGitSource().load(
            { kind: 'local', repoPath: plain, base: null, head: null },
            makeContext(),
          ),
        );
        expect(notRepo.code).toBe('SOURCE_INVALID');
        expect(notRepo.hint).toBeTruthy();
        const missing = await expectError(
          new LocalGitSource().load(
            { kind: 'local', repoPath: join(plain, 'missing'), base: null, head: null },
            makeContext(),
          ),
        );
        expect(missing.code).toBe('SOURCE_NOT_FOUND');
        await writeFile(join(plain, 'file.txt'), 'x');
        const file = await expectError(
          new LocalGitSource().load(
            { kind: 'local', repoPath: join(plain, 'file.txt'), base: null, head: null },
            makeContext(),
          ),
        );
        expect(file.code).toBe('SOURCE_INVALID');
      } finally {
        await rm(plain, { recursive: true, force: true });
      }
    });

    it('reports a repository without commits', async () => {
      const repo = await newRepo();
      const error = await expectError(load(repo));
      expect(error.code).toBe('SOURCE_NOT_FOUND');
      expect(error.hint).toContain('no commits');
    });

    it('reports nothing to explain when head has nothing beyond the base', async () => {
      const repo = await newRepo();
      await repo.write('README.md', 'x\n');
      repo.commit('only commit');
      const error = await expectError(load(repo));
      expect(error.code).toBe('SOURCE_INVALID');
      expect(error.message).toContain('no committed changes');
      expect(error.hint).toContain('Commit your work');
    });

    it('asks for --base when no default branch can be found', async () => {
      const repo = await newRepo();
      repo.git('checkout', '-q', '-b', 'trunk');
      await repo.write('README.md', 'x\n');
      repo.commit('one');
      await repo.write('b.txt', 'y\n');
      repo.commit('two');
      const error = await expectError(load(repo));
      expect(error.code).toBe('SOURCE_INVALID');
      expect(error.hint).toContain('--base');
      const ok = await load(repo, { base: 'HEAD~1' });
      expect(ok.changeSet.files.map((f) => f.path)).toEqual(['b.txt']);
    });

    it('refuses a GitHub input', async () => {
      const error = await expectError(
        new LocalGitSource().load({ kind: 'github', url: 'https://github.com/a/b/pull/1' }, makeContext()),
      );
      expect(error.code).toBe('USAGE');
    });
  });

  describe('branches that exist only on the remote, as in a CI checkout', () => {
    /** A clone with no local branch at all: HEAD is detached and only origin/<name> exists. */
    async function ciDashboard(): Promise<string> {
      const clone = await mkdtemp(join(tmpdir(), 'mergestory-ci-'));
      execFileSync('git', ['clone', '-q', shared.repo.dir, clone]);
      const git = (...args: string[]) => execFileSync('git', ['-C', clone, ...args], { encoding: 'utf8' });
      git('checkout', '-q', '--detach', 'origin/feature/video');
      for (const branch of git('branch', '--format=%(refname:short)').split('\n')) {
        if (branch && !branch.startsWith('(')) git('branch', '-q', '-D', branch);
      }
      expect(git('branch', '--list').trim()).toMatch(/^\* \(HEAD detached/);
      return clone;
    }

    it('finds --base main as origin/main, says so, and gives the same change as a normal clone', async () => {
      const clone = await ciDashboard();
      try {
        const events: ProgressEvent[] = [];
        const ci = await new LocalGitSource().load(
          { kind: 'local', repoPath: clone, base: 'main', head: null },
          makeContext({}, events),
        );
        const normal = await load(shared.repo, { base: 'main' });
        expect(ci.changeSet.files.map((f) => f.path)).toEqual(normal.changeSet.files.map((f) => f.path));
        expect(ci.changeSet.base).toEqual(normal.changeSet.base);
        expect(ci.changeSet.base.ref).toBe('main');
        expect(events.map((e) => e.message)).toContain('There is no local "main", so origin/main is used.');
      } finally {
        await rm(clone, { recursive: true, force: true });
      }
    });

    it('does the same for --head, and still accepts the origin/ spelling', async () => {
      const clone = await ciDashboard();
      try {
        const fromHead = await new LocalGitSource().load(
          { kind: 'local', repoPath: clone, base: 'main', head: 'feature/video' },
          makeContext(),
        );
        const explicit = await new LocalGitSource().load(
          { kind: 'local', repoPath: clone, base: 'origin/main', head: 'origin/feature/video' },
          makeContext(),
        );
        expect(fromHead.changeSet.files.map((f) => f.path)).toEqual(
          explicit.changeSet.files.map((f) => f.path),
        );
        expect(fromHead.changeSet.head.ref).toBe('feature/video');
      } finally {
        await rm(clone, { recursive: true, force: true });
      }
    });

    it('prefers a local branch over the remote one, without a message', async () => {
      const events: ProgressEvent[] = [];
      await load(shared.repo, { base: 'main' }, {}, events);
      expect(events.some((e) => e.message.includes('origin/main'))).toBe(false);
    });

    it('still reports a name that exists nowhere, with a hint that fits a checkout like this', async () => {
      const clone = await ciDashboard();
      try {
        const error = await expectError(
          new LocalGitSource().load(
            { kind: 'local', repoPath: clone, base: 'no-such-branch', head: null },
            makeContext(),
          ),
        );
        expect(error.code).toBe('SOURCE_NOT_FOUND');
        expect(error.hint).toContain('git fetch origin <branch>');
        expect(error.hint).toContain('fetch-depth: 0');
      } finally {
        await rm(clone, { recursive: true, force: true });
      }
    });
  });

  describe('the run folder', () => {
    function contextWithRunDir(runDir: string): RunContext {
      return testContext({ runDir }).ctx;
    }
    const loadWith = (repoPath: string, runDir: string) =>
      new LocalGitSource().load(
        { kind: 'local', repoPath, base: null, head: null },
        contextWithRunDir(runDir),
      );

    it('may not be inside the repository, which the source checks even when the source is a subfolder', async () => {
      const { repo } = shared;
      const before = snapshot(repo.dir);
      for (const [path, runDir] of [
        [repo.dir, join(repo.dir, 'out')],
        [join(repo.dir, 'src'), join(repo.dir, 'src', 'out')],
        [join(repo.dir, 'src'), join(repo.dir, 'other', 'deep', 'out')],
        [repo.dir, repo.dir],
      ] as const) {
        const error = await expectError(loadWith(path, runDir));
        expect(error.code, runDir).toBe('USAGE');
        expect(error.message).toBe('The run folder is inside the repository being explained.');
        expect(error.hint).toContain('--out');
      }
      expect(snapshot(repo.dir)).toBe(before);
    });

    it('may not be reached through a link either', async () => {
      const { repo } = shared;
      const outside = await mkdtemp(join(tmpdir(), 'mergestory-link-'));
      try {
        await symlink(join(repo.dir, 'src'), join(outside, 'link'));
        const error = await expectError(loadWith(repo.dir, join(outside, 'link', 'out')));
        expect(error.code).toBe('USAGE');
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it('may be next to the repository, or above it, and need not exist yet', async () => {
      const { repo } = shared;
      const beside = join(tmpdir(), `mergestory-beside-${basename(repo.dir)}`, 'runs', 'r1');
      await expect(loadWith(repo.dir, beside)).resolves.toBeDefined();
      await expect(loadWith(repo.dir, join(repo.dir, '..'))).resolves.toBeDefined();
      expect(existsSync(beside)).toBe(false);
    });
  });
});
