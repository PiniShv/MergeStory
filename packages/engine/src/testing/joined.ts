/**
 * Two small repositories as loaded sources (a change that the real analyzer has read, with a reader
 * that guards its paths like a real source), for the tests of a change in several repositories.
 * Not part of the public API.
 */
import { analyze } from '../analyzer/index.ts';
import { createPathPolicy } from '../core/path-policy.ts';
import type { ChangeSet } from '../core/types.ts';
import type { LoadedSource } from '../sources/join.ts';
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
