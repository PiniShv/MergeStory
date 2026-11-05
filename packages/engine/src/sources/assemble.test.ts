import { describe, expect, it } from 'vitest';
import type { ConfigInput } from '../core/config.ts';
import type { DiffHunk } from '../core/types.ts';
import { testContext } from '../testing/context.ts';
import { assembleChangeSet, fileId, type RawChange, type RawFile } from './assemble.ts';
import { DEFAULT_SOURCE_LIMITS } from './limits.ts';

function context(config: ConfigInput = {}) {
  return testContext({ config }).ctx;
}

function file(path: string, extra: Partial<RawFile> = {}): RawFile {
  return {
    path,
    oldPath: null,
    status: 'modified',
    additions: 1,
    deletions: 1,
    binary: false,
    unreadable: false,
    hasHunks: true,
    ...extra,
  };
}

const HUNK: DiffHunk = {
  id: 'F1.H1',
  oldStart: 1,
  oldLines: 1,
  newStart: 1,
  newLines: 1,
  header: '',
  lines: [{ kind: 'add', text: 'x', oldLine: null, newLine: 1 }],
};

function change(files: RawFile[], extra: Partial<RawChange> = {}): RawChange {
  return {
    source: 'local',
    repo: { host: 'local', owner: null, name: 'r', isPrivate: null, defaultBranch: null, webUrl: null },
    base: { ref: 'main', sha: 'a'.repeat(40) },
    head: { ref: 'topic', sha: 'b'.repeat(40) },
    pr: null,
    issues: [],
    files,
    filesCapped: false,
    totals: null,
    commits: { items: [], total: 0, capped: false },
    tree: { paths: [], truncated: false },
    loadHunks: async (selected) => new Map(selected.map((index) => [index, [HUNK]])),
    loadFile: async (path) => `content of ${path}`,
    notes: {
      filesCapped: (shown, total) => `files ${shown}/${total}`,
      withoutPatch: (count) => `no patch for ${count}`,
      commitsCapped: (shown, total) => `commits ${shown}/${total}`,
    },
    ...extra,
  };
}

describe('assembleChangeSet and the privacy rule', () => {
  it('marks a built-in sensitive path, an excluded path and a rename away from either as sensitive', async () => {
    const { changeSet, reader } = await assembleChangeSet(
      change([
        file('.env', { status: 'added' }),
        file('internal/plan.md'),
        file('public/plan.md', { status: 'renamed', oldPath: 'internal/plan.md' }),
        file('data.json', { status: 'renamed', oldPath: 'credentials.json' }),
        file('src/app.ts'),
      ]),
      context({ privacy: { excludePaths: ['internal/'] } }),
      DEFAULT_SOURCE_LIMITS,
    );
    expect(changeSet.files.map((f) => [f.path, f.sensitive, f.hunks.length])).toEqual([
      ['.env', true, 0],
      ['internal/plan.md', true, 0],
      ['public/plan.md', true, 0],
      ['data.json', true, 0],
      ['src/app.ts', false, 1],
    ]);
    expect(await reader.readFile('.env', 'head')).toBeNull();
    expect(await reader.readFile('internal/plan.md', 'head')).toBeNull();
    expect(await reader.readFile('src/app.ts', 'head')).toBe('content of src/app.ts');
  });

  it('does not ask the source for the hunks of a protected file', async () => {
    const asked: number[][] = [];
    await assembleChangeSet(
      change([file('.env'), file('src/a.ts')], {
        loadHunks: async (selected) => {
          asked.push([...selected]);
          return new Map();
        },
      }),
      context(),
      DEFAULT_SOURCE_LIMITS,
    );
    expect(asked).toEqual([[1]]);
  });
});

describe('assembleChangeSet files, totals and notes', () => {
  it('numbers files, flags missing hunks and counts files without a patch', async () => {
    const { changeSet } = await assembleChangeSet(
      change([
        file('a.ts'),
        file('big.ts', { hasHunks: false }),
        file('odd.ts', { additions: 0, deletions: 0, unreadable: true, hasHunks: false }),
        file('logo.png', { additions: 0, deletions: 0, binary: true, hasHunks: false }),
      ]),
      context(),
      DEFAULT_SOURCE_LIMITS,
    );
    expect(changeSet.files.map((f) => [f.id, f.patchTruncated])).toEqual([
      [fileId(0), false],
      ['F2', true],
      ['F3', true],
      ['F4', false],
    ]);
    expect(changeSet.limits.note).toBe('no patch for 2');
  });

  it('lists the first files only, and says so', async () => {
    const files = [file('a.ts'), file('b.ts'), file('c.ts')];
    const { changeSet } = await assembleChangeSet(change(files), context(), {
      ...DEFAULT_SOURCE_LIMITS,
      maxFiles: 2,
    });
    expect(changeSet.files).toHaveLength(2);
    expect(changeSet.stats).toEqual({ files: 3, additions: 3, deletions: 3 });
    expect(changeSet.limits).toMatchObject({ filesCapped: true, note: 'files 2/3' });
  });

  it('prefers the totals a source reports, and notes a capped commit list', async () => {
    const { changeSet } = await assembleChangeSet(
      change([file('a.ts')], {
        totals: { files: 5, additions: 50, deletions: 20 },
        commits: { items: [{ sha: 'c'.repeat(40), message: 'Subject\n\nBody' }], total: 4, capped: false },
      }),
      context(),
      DEFAULT_SOURCE_LIMITS,
    );
    expect(changeSet.stats).toEqual({ files: 5, additions: 50, deletions: 20 });
    expect(changeSet.commits).toEqual([{ id: 'CM1', sha: 'c'.repeat(40), subject: 'Subject', body: 'Body' }]);
    expect(changeSet.limits).toEqual({
      filesCapped: true,
      commitsCapped: true,
      note: 'files 1/5 commits 1/4',
    });
  });
});
