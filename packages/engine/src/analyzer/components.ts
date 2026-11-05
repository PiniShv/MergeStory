/**
 * Component (module) grouping. A component is the unit shown as one box in an architecture view:
 * a monorepo package, or the first meaningful directory under a source root.
 */

import { basename, dirname } from '../core/posix.ts';
import type { ChangedFile, Component, ComponentKind, FileRole } from '../core/types.ts';
import { SOURCE_ROOTS } from './roles.ts';

export interface ComponentInput {
  file: ChangedFile;
  role: FileRole;
  trivial: boolean;
}

export interface ComponentGrouping {
  components: Component[];
  /** File id -> component id. */
  byFile: Map<string, string>;
  /** Owning component of any repository path (changed or not), or null when no changed component owns it. */
  componentForPath(path: string): string | null;
}

interface Located {
  key: string;
  name: string;
  path: string;
}

const MONOREPO_PREFIXES = new Set(['packages', 'apps', 'services', 'libs', 'crates', 'modules', 'cmd']);
const WRAPPER_DIRS = new Set(['features', 'modules', 'domains']);
const TEST_DIRS = new Set(['__tests__', '__mocks__', 'tests', 'test', 'spec', 'specs', 'e2e', 'testdata']);
const DOC_DIRS = new Set(['docs', 'doc', 'documentation']);
const REVERSE_DOMAIN = new Set([
  'com',
  'org',
  'net',
  'io',
  'de',
  'fr',
  'uk',
  'nl',
  'jp',
  'cn',
  'in',
  'br',
  'ch',
]);
const ROOT: Located = { key: '.', name: 'Project root', path: '.' };

const KIND_KEYWORDS: [ComponentKind, RegExp][] = [
  ['api', /^(api|apis|routes?|controllers?|handlers?|endpoints?)$/],
  ['ui', /^(components?|ui|pages?|views?|screens?)$/],
  ['data', /^(db|database|models?|migrations?|schemas?|repositories|repository)$/],
  ['cli', /^(cli|bin|cmd|commands?)$/],
  ['infra', /^(infra|infrastructure|terraform|k8s|kubernetes|helm|deploy|deployment)$/],
  ['tests', /^(tests?|__tests__|spec|specs|e2e)$/],
  ['docs', /^(docs?|documentation)$/],
  ['config', /^(config|configs|configuration)$/],
];

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\\/\-_.\s]+/)
    .filter(Boolean);
}

function kindFromTokens(segments: string[]): ComponentKind | null {
  for (const segment of segments) {
    const parts = tokens(segment);
    for (const [kind, pattern] of KIND_KEYWORDS) {
      if (pattern.test(segment.toLowerCase()) || parts.some((p) => pattern.test(p))) return kind;
    }
  }
  return null;
}

/**
 * First meaningful directory below a source root: skips the JVM layout (src/main/java) and
 * reverse-domain package prefixes (com/acme). Returns the skipped segments and the ones kept.
 */
function meaningfulUnder(dirs: string[]): { skipped: string[]; kept: string[] } | null {
  let i = 0;
  if (dirs[0] === 'main' && ['java', 'kotlin', 'scala', 'groovy'].includes(dirs[1] ?? '')) i = 2;
  if (REVERSE_DOMAIN.has(dirs[i] ?? '') && dirs.length - i >= 3) i += 2;
  const first = dirs[i];
  if (first === undefined) return null;
  const skipped = dirs.slice(0, i);
  if (WRAPPER_DIRS.has(first) && dirs[i + 1] !== undefined)
    return { skipped, kept: [first, dirs[i + 1] as string] };
  return { skipped, kept: [first] };
}

/** Where a path lives, by layout alone. */
function locate(path: string): Located {
  const dirs = path.split('/').slice(0, -1);
  const first = dirs[0];
  if (first === undefined) return ROOT;
  if (MONOREPO_PREFIXES.has(first) && dirs.length >= 2) {
    const second = dirs[1] as string;
    return { key: `${first}/${second}`, name: second, path: `${first}/${second}` };
  }
  if (SOURCE_ROOTS.has(first)) {
    const meaningful = meaningfulUnder(dirs.slice(1));
    if (meaningful) {
      const full = [first, ...meaningful.skipped, ...meaningful.kept].join('/');
      return { key: full, name: meaningful.kept[meaningful.kept.length - 1] as string, path: full };
    }
  }
  return { key: first, name: first, path: first };
}

function stripTestDirs(path: string): string {
  const parts = path.split('/');
  return parts.filter((p, i) => i === parts.length - 1 || !TEST_DIRS.has(p.toLowerCase())).join('/');
}

function fileStem(path: string, testSuffixes: boolean): string {
  let name = basename(path)
    .toLowerCase()
    .replace(/\.[^.]+$/, '');
  if (testSuffixes)
    name = name
      .replace(/\.(test|spec)$/, '')
      .replace(/(_test|_spec|-test|-spec)$/, '')
      .replace(/^test_/, '');
  return name;
}

interface Placement extends Located {
  ci?: boolean;
}

export function groupComponents(inputs: readonly ComponentInput[]): ComponentGrouping {
  const placements = new Map<string, Placement>();
  const pending: ComponentInput[] = [];

  for (const input of inputs) {
    const { file, role } = input;
    if (role === 'ci') {
      placements.set(file.id, {
        key: 'ci',
        name: 'CI',
        path: file.path.split('/')[0]?.startsWith('.') ? (file.path.split('/')[0] as string) : '.',
        ci: true,
      });
    } else if (role === 'test' && stripTestDirs(file.path) !== file.path) {
      pending.push(input);
    } else if (DOC_DIRS.has(file.path.split('/')[0] ?? '') && file.path.includes('/')) {
      pending.push(input);
    } else {
      placements.set(file.id, locate(file.path));
    }
  }

  const byKey = new Map<string, Located>();
  const byName = new Map<string, string[]>();
  const byStem = new Map<string, string[]>();
  const stemOwner = (stem: string, key: string): void => {
    byStem.set(stem, [...(byStem.get(stem) ?? []), key]);
  };
  for (const input of inputs) {
    const p = placements.get(input.file.id);
    if (!p) continue;
    byKey.set(p.key, p);
    const nameKey = p.name.toLowerCase();
    if (!(byName.get(nameKey) ?? []).includes(p.key))
      byName.set(nameKey, [...(byName.get(nameKey) ?? []), p.key]);
    if (input.role !== 'test') stemOwner(fileStem(input.file.path, false), p.key);
  }

  const unique = (keys: string[] | undefined): string | null => {
    const set = [...new Set(keys ?? [])];
    return set.length === 1 ? (set[0] as string) : null;
  };

  for (const input of pending) {
    const { file, role } = input;
    const original = locate(file.path);
    if (role === 'test') {
      const stripped = locate(stripTestDirs(file.path));
      const topIsTestDir = TEST_DIRS.has(file.path.split('/')[0]?.toLowerCase() ?? '');
      // A test at the repository root of its test folder says nothing about the root component.
      const named = stripped.key !== ROOT.key;
      const folded =
        (named && byKey.has(stripped.key) ? stripped.key : null) ??
        (named ? unique(byName.get(stripped.name.toLowerCase())) : null) ??
        unique(byStem.get(fileStem(file.path, true)));
      if (folded) placements.set(file.id, byKey.get(folded) as Located);
      else placements.set(file.id, topIsTestDir ? original : stripped);
    } else {
      const folded =
        unique(byName.get(fileStem(file.path, false))) ?? unique(byStem.get(fileStem(file.path, false)));
      placements.set(file.id, folded ? (byKey.get(folded) as Located) : original);
    }
  }

  // Duplicate short names (packages/api and services/api) fall back to the full path.
  const nameCounts = new Map<string, Set<string>>();
  for (const p of placements.values()) {
    const set = nameCounts.get(p.name) ?? new Set<string>();
    set.add(p.key);
    nameCounts.set(p.name, set);
  }

  interface Bucket {
    located: Placement;
    inputs: ComponentInput[];
  }
  const buckets = new Map<string, Bucket>();
  for (const input of inputs) {
    const p = placements.get(input.file.id) as Placement;
    const bucket = buckets.get(p.key) ?? { located: p, inputs: [] };
    bucket.inputs.push(input);
    buckets.set(p.key, bucket);
  }

  const churn = (b: Bucket): number =>
    b.inputs.reduce((n, i) => n + (i.trivial ? 0 : i.file.additions + i.file.deletions), 0);
  const ordered = [...buckets.values()].sort(
    (a, b) => churn(b) - churn(a) || a.located.path.localeCompare(b.located.path),
  );

  const components: Component[] = [];
  const keyToId = new Map<string, string>();
  const byFile = new Map<string, string>();
  ordered.forEach((bucket, index) => {
    const id = `M${index + 1}`;
    const { located } = bucket;
    const files = bucket.inputs.map((i) => i.file);
    const name = (nameCounts.get(located.name)?.size ?? 0) > 1 && !located.ci ? located.path : located.name;
    components.push({
      id,
      name,
      path: located.path,
      kind: inferKind(located, bucket.inputs),
      fileIds: files.map((f) => f.id),
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
      status: files.every((f) => f.status === 'added')
        ? 'added'
        : files.every((f) => f.status === 'deleted')
          ? 'removed'
          : 'modified',
    });
    keyToId.set(located.key, id);
    for (const f of files) byFile.set(f.id, id);
  });

  const pathToFile = new Map(inputs.map((i) => [i.file.path, i.file.id]));
  return {
    components,
    byFile,
    componentForPath(path: string): string | null {
      const fileId = pathToFile.get(path);
      if (fileId) return byFile.get(fileId) ?? null;
      return keyToId.get(locate(path).key) ?? null;
    },
  };
}

function inferKind(located: Placement, inputs: ComponentInput[]): ComponentKind {
  const roles = inputs.map((i) => i.role);
  if (roles.every((r) => r === 'test')) return 'tests';
  if (roles.every((r) => r === 'docs')) return 'docs';
  if (roles.every((r) => r === 'asset')) return 'ui';
  if (located.ci || roles.every((r) => r === 'ci')) return 'infra';
  if (roles.every((r) => r === 'config' || r === 'dependency-manifest' || r === 'lockfile')) return 'config';
  if (located.key === '.' && !roles.some((r) => r === 'source' || r === 'migration')) return 'config';

  const fromName = kindFromTokens(located.path.split('/'));
  if (fromName) return fromName;

  // Pick a kind when most source files sit in directories that name one (src/components/...).
  const sources = inputs.filter((i) => i.role === 'source' || i.role === 'migration');
  if (sources.length > 0 && sources.every((i) => /\.(tf|hcl)$/.test(i.file.path))) return 'infra';
  if (sources.length > 0) {
    const counts = new Map<ComponentKind, number>();
    for (const input of sources) {
      const rel = dirname(input.file.path)
        .split('/')
        .slice(located.path === '.' ? 0 : located.path.split('/').length);
      const kind = kindFromTokens(rel);
      if (kind && kind !== 'tests' && kind !== 'docs' && kind !== 'config')
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    for (const [kind, n] of counts) if (n / sources.length >= 0.6) return kind;
  }

  const container = located.path.split('/')[0] ?? '';
  if (container === 'services' || container === 'apps') return 'service';
  if (container === 'packages' || container === 'libs' || container === 'crates') return 'package';
  return 'module';
}
