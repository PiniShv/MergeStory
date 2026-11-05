/** Helpers for building change sets in tests: real unified diffs from base and head text. */
import { createPathPolicy } from '../core/path-policy.ts';
import { splitLines } from '../core/text.ts';
import type {
  ChangedFile,
  ChangeSet,
  ContextInputs,
  DiffHunk,
  DiffLine,
  FileStatus,
  RepoReader,
  Side,
} from '../core/types.ts';

export interface FixtureFile {
  path: string;
  /** Content at base. null or omitted: the file is new. */
  base?: string | null;
  /** Content at head. null: the file was deleted. */
  head?: string | null;
  status?: FileStatus;
  oldPath?: string | null;
  sensitive?: boolean;
  binary?: boolean;
  /** The language id a source would have set. Not guessed from the path: null unless a test names it. */
  language?: string | null;
}

type Op = { op: 'eq' | 'del' | 'add'; text: string };

function diffOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] =
        a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: 'eq', text: a[i]! });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ op: 'del', text: a[i++]! });
    } else {
      ops.push({ op: 'add', text: b[j++]! });
    }
  }
  while (i < n) ops.push({ op: 'del', text: a[i++]! });
  while (j < m) ops.push({ op: 'add', text: b[j++]! });
  return ops;
}

/** Unified-diff hunks (3 lines of context) between two texts. */
export function makeHunks(base: string | null, head: string | null, fileId: string, context = 3): DiffHunk[] {
  const ops = diffOps(base === null ? [] : splitLines(base), head === null ? [] : splitLines(head));
  const lines: DiffLine[] = [];
  let oldNo = 1;
  let newNo = 1;
  for (const o of ops) {
    if (o.op === 'eq') lines.push({ kind: 'ctx', text: o.text, oldLine: oldNo++, newLine: newNo++ });
    else if (o.op === 'del') lines.push({ kind: 'del', text: o.text, oldLine: oldNo++, newLine: null });
    else lines.push({ kind: 'add', text: o.text, oldLine: null, newLine: newNo++ });
  }
  const changed = lines.map((l, i) => (l.kind === 'ctx' ? -1 : i)).filter((i) => i >= 0);
  if (changed.length === 0) return [];
  const groups: { start: number; end: number }[] = [];
  for (const idx of changed) {
    const start = Math.max(0, idx - context);
    const end = Math.min(lines.length - 1, idx + context);
    const last = groups[groups.length - 1];
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
    else groups.push({ start, end });
  }
  return groups.map((g, index) => {
    const slice = lines.slice(g.start, g.end + 1);
    const oldBefore = lines.slice(0, g.start).filter((l) => l.oldLine !== null).length;
    const newBefore = lines.slice(0, g.start).filter((l) => l.newLine !== null).length;
    const oldLines = slice.filter((l) => l.oldLine !== null).length;
    const newLines = slice.filter((l) => l.newLine !== null).length;
    return {
      id: `${fileId}.H${index + 1}`,
      oldStart: oldLines > 0 ? oldBefore + 1 : oldBefore,
      oldLines,
      newStart: newLines > 0 ? newBefore + 1 : newBefore,
      newLines,
      header: '',
      lines: slice,
    };
  });
}

export interface BuiltChange {
  changeSet: ChangeSet;
  reader: RepoReader;
  /** Number of read calls the reader served, keyed "side:path". */
  reads: Map<string, number>;
}

export interface ChangeOptions {
  webUrl?: string | null;
  tree?: string[];
  pr?: Partial<NonNullable<ChangeSet['pr']>> | null;
  commits?: { subject: string; body?: string }[];
  issues?: { title: string; body?: string }[];
  readme?: string | null;
  manifests?: { path: string; excerpt: string }[];
  /** Extra files known to exist at head (not part of the change). */
  unchanged?: Record<string, string>;
  /** `privacy.excludePaths`. Like a source, the builder marks a file sensitive when its path or previous path is off limits. */
  excludePaths?: readonly string[];
}

export function buildChange(files: FixtureFile[], options: ChangeOptions = {}): BuiltChange {
  const contents = new Map<string, string>();
  const reads = new Map<string, number>();
  const isProtected = createPathPolicy(options.excludePaths ?? []);
  const changed: ChangedFile[] = files.map((f, index) => {
    const id = `F${index + 1}`;
    const base = f.base ?? null;
    const head = f.head === undefined ? (f.status === 'deleted' ? null : '') : f.head;
    const status: FileStatus = f.status ?? (base === null ? 'added' : head === null ? 'deleted' : 'modified');
    const hunks = f.binary ? [] : makeHunks(base, head, id);
    if (base !== null) contents.set(`base:${f.oldPath ?? f.path}`, base);
    if (head !== null) contents.set(`head:${f.path}`, head);
    return {
      id,
      path: f.path,
      oldPath: f.oldPath ?? null,
      status,
      additions: hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === 'add').length, 0),
      deletions: hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === 'del').length, 0),
      binary: f.binary ?? false,
      language: f.language ?? null,
      hunks,
      patchTruncated: false,
      sensitive: f.sensitive ?? (isProtected(f.path) || (!!f.oldPath && isProtected(f.oldPath))),
    };
  });
  for (const [path, text] of Object.entries(options.unchanged ?? {})) contents.set(`head:${path}`, text);
  const tree = options.tree ?? [
    ...new Set([...changed.map((f) => f.path), ...Object.keys(options.unchanged ?? {})]),
  ];
  const changeSet: ChangeSet = {
    source: 'github',
    repo: {
      host: 'github.com',
      owner: 'example',
      name: 'weather',
      isPrivate: false,
      defaultBranch: 'main',
      webUrl: options.webUrl === undefined ? 'https://github.com/example/weather' : options.webUrl,
    },
    base: { ref: 'main', sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' },
    head: { ref: 'feature/x', sha: 'f6e5d4c3b2a1908172635445362718091a2b3c4d' },
    pr:
      options.pr === null
        ? null
        : {
            number: 42,
            title: 'Add retry to the HTTP client',
            body: 'Retries failed requests.',
            url: 'https://github.com/example/weather/pull/42',
            author: 'octocat',
            baseRef: 'main',
            headRef: 'feature/x',
            labels: [],
            draft: false,
            state: 'open',
            ...options.pr,
          },
    linkedIssues: (options.issues ?? []).map((issue, i) => ({
      id: `IS${i + 1}`,
      number: 10 + i,
      title: issue.title,
      body: issue.body ?? '',
      url: `https://github.com/example/weather/issues/${10 + i}`,
    })),
    commits: (options.commits ?? []).map((c, i) => ({
      id: `CM${i + 1}`,
      sha: `${(i + 1).toString(16).repeat(40).slice(0, 40)}`,
      subject: c.subject,
      body: c.body ?? '',
    })),
    files: changed,
    stats: {
      files: changed.length,
      additions: changed.reduce((n, f) => n + f.additions, 0),
      deletions: changed.reduce((n, f) => n + f.deletions, 0),
    },
    limits: { filesCapped: false, commitsCapped: false, note: null },
    repoContext: {
      tree,
      treeTruncated: false,
      readmeExcerpt: options.readme ?? null,
      manifests: options.manifests ?? [],
    },
  };
  const reader: RepoReader = {
    async readFile(path: string, side: Side): Promise<string | null> {
      const key = `${side}:${path}`;
      reads.set(key, (reads.get(key) ?? 0) + 1);
      return contents.get(key) ?? null;
    },
  };
  return { changeSet, reader, reads };
}

export function emptyInputs(overrides: Partial<ContextInputs> = {}): ContextInputs {
  return { task: null, notes: null, tests: [], screenshots: [], ...overrides };
}
