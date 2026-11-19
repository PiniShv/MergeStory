/**
 * Two small repositories as loaded sources (a change that the real analyzer has read, with a reader
 * that guards its paths like a real source), for the tests of a change in several repositories.
 * Not part of the public API.
 */
import { analyze } from '../analyzer/index.ts';
import { createPathPolicy } from '../core/path-policy.ts';
import type { Analysis, ChangeSet } from '../core/types.ts';
import { EVIDENCE_ORIGIN, type LoadedSource } from '../sources/join.ts';
import { createGuardedReader } from '../sources/reader.ts';
import { buildChange, type ChangeOptions, emptyInputs, type FixtureFile } from './change.ts';
import { testContext } from './context.ts';

export const TOTAL_BASE = 'export function total(order) {\n  return order.sum;\n}\n';

/** The service: the same relative path as the storefront has, a test, a key file and a manifest. */
export const ORDERS_FILES: FixtureFile[] = [
  {
    path: 'src/total.js',
    language: 'javascript',
    base: TOTAL_BASE,
    head: 'export function total(order) {\n  return { cents: order.cents };\n}\n',
  },
  {
    path: 'src/total.test.js',
    language: 'javascript',
    base: null,
    head: "import { total } from './total.js';\ntotal({ cents: 1 });\n",
  },
  { path: '.env', base: 'A=1\n', head: 'A=2\n' },
  {
    path: 'package.json',
    base: '{"name":"orders-api","dependencies":{}}\n',
    head: '{"name":"orders-api","dependencies":{"zod":"^3.0.0"}}\n',
  },
];

export const STORE_FILES: FixtureFile[] = [
  {
    path: 'src/total.js',
    language: 'javascript',
    base: TOTAL_BASE,
    head: 'export function total(order) {\n  return order.total.cents / 100;\n}\n',
  },
  {
    path: 'src/page.ts',
    language: 'typescript',
    base: null,
    head: 'export const page = (n: number): string => `Total ${n}`;\n',
  },
];

/**
 * What is wrong with a joined analysis: an id that something points at and that is not in the
 * evidence, an id of a repository without its letter, a path that is neither a file of the change
 * nor inside a folder of a source. Empty when it is complete.
 */
export function joinProblems(changeSet: ChangeSet, analysis: Analysis): string[] {
  const parts = changeSet.parts ?? [];
  const known = new Set(analysis.evidence.map((e) => e.id));
  const problems: string[] = [];
  // An id the caller supplied (the task, notes, tests, reproduction, pictures, logs) has no letter.
  const fromRun = new Set(
    analysis.evidence.filter((e) => EVIDENCE_ORIGIN[e.kind] === 'run').map((e) => e.id),
  );
  const letters = new RegExp(`^(?:${parts.map((p) => p.label).join('|')})\\.`);
  const id = (where: string, value: string): void => {
    if (!known.has(value)) problems.push(`${where}: ${value} is not in the evidence`);
    if (!letters.test(value) && !fromRun.has(value)) problems.push(`${where}: ${value} has no letter`);
  };
  const files = new Set(changeSet.files.flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path])));
  const folders = parts.map((p) => `${p.folder}/`);
  const path = (where: string, value: string): void => {
    if (
      !files.has(value) &&
      !folders.some((f) => value.startsWith(f)) &&
      !parts.some((p) => p.folder === value)
    )
      problems.push(`${where}: ${value} is not in a folder of a source`);
  };
  for (const f of changeSet.files) {
    id('file', f.id);
    path('file', f.path);
    for (const h of f.hunks) id('hunk', h.id);
  }
  for (const c of changeSet.commits) id('commit', c.id);
  for (const i of changeSet.linkedIssues) id('issue', i.id);
  for (const f of analysis.files) {
    id('insight', f.fileId);
    id('insight', f.componentId);
    f.symbolIds.forEach((s) => id('insight', s));
    path('insight', f.path);
  }
  for (const m of analysis.components) {
    id('component', m.id);
    m.fileIds.forEach((x) => id('component', x));
    path('component', m.path);
  }
  for (const r of analysis.relationships) [r.from, r.to, r.evidence].forEach((x) => id('relationship', x));
  for (const s of analysis.symbols) {
    id('symbol', s.id);
    id('symbol', s.fileId);
    path('symbol', s.path);
  }
  for (const k of analysis.keyHunks) {
    id('key hunk', k.id);
    id('key hunk', k.fileId);
    path('key hunk', k.path);
  }
  for (const r of analysis.risks) {
    id('risk', r.id);
    r.evidence.forEach((x) => id('risk', x));
    if (r.ref) path('risk', r.ref.path);
  }
  for (const d of analysis.dependencies) {
    id('dependency', d.id);
    id('dependency', d.fileId);
  }
  for (const t of [...analysis.tests.added, ...analysis.tests.modified, ...analysis.tests.removed])
    path('test', t);
  for (const e of analysis.evidence) {
    if (e.ref) path('evidence', e.ref.path);
    if (!known.has(e.id)) problems.push(`evidence ${e.id} is missing`);
  }
  return problems;
}

export const JOINED_INPUTS = emptyInputs({ task: 'Fix the total' });

export interface SourceOptions extends ChangeOptions {
  name: string;
  owner?: string | null;
  isPrivate?: boolean | null;
  headSha?: string;
  prNumber?: number | null;
  note?: string;
}

export async function loadSource(files: FixtureFile[], options: SourceOptions): Promise<LoadedSource> {
  const { name, owner = 'acme', isPrivate = false, headSha, prNumber = 1, note, ...change } = options;
  const { ctx } = testContext();
  const built = buildChange(files, {
    excludePaths: ctx.config.privacy.excludePaths,
    pr: prNumber === null ? null : { number: prNumber },
    ...change,
  });
  const changeSet: ChangeSet = {
    ...built.changeSet,
    // A source keeps no hunks of a file that is off limits.
    files: built.changeSet.files.map((f) => (f.sensitive ? { ...f, hunks: [] } : f)),
    repo: { ...built.changeSet.repo, name, owner, isPrivate },
    head: { ...built.changeSet.head, sha: headSha ?? built.changeSet.head.sha },
    limits: { filesCapped: false, commitsCapped: false, note: note ?? null },
  };
  const reader = createGuardedReader({
    isProtected: createPathPolicy([]),
    load: (path, side) => built.reader.readFile(path, side),
  });
  const analysis = await analyze(changeSet, reader, JOINED_INPUTS, ctx);
  return { changeSet, reader, analysis };
}

export const orders = (more: Partial<SourceOptions> = {}): Promise<LoadedSource> =>
  loadSource(ORDERS_FILES, {
    name: 'orders-api',
    commits: [{ subject: 'Return cents' }],
    issues: [{ title: 'Wrong total' }],
    readme: '# Orders\n',
    manifests: [{ path: 'package.json', excerpt: '{}' }],
    ...more,
  });

export const store = (more: Partial<SourceOptions> = {}): Promise<LoadedSource> =>
  loadSource(STORE_FILES, {
    name: 'storefront',
    prNumber: 7,
    commits: [{ subject: 'Show cents' }],
    readme: '# Store\n',
    ...more,
  });
