/**
 * Hand-built changes for the storyboard tests. They stand in for the output of the source and
 * analyzer modules: a change set, its analysis with an evidence index, and a reader that returns
 * the real lines. Not part of the public API.
 */
import { type Config, type ConfigInput, resolveConfig } from '../core/config.ts';
import { createPathPolicy } from '../core/path-policy.ts';
import type {
  Analysis,
  ChangedFile,
  ChangeSet,
  CodeRef,
  Component,
  ComponentKind,
  ContextInputs,
  DependencyChange,
  EvidenceItem,
  FileInsight,
  FileRole,
  FileStatus,
  KeyHunk,
  Relationship,
  RepoReader,
  RiskCategory,
  RiskSeverity,
  RiskSignal,
  Side,
  SymbolChange,
  SymbolKind,
} from '../core/types.ts';
import type { ValidationDeps } from '../storyboard/types.ts';
import { makeHunks } from './change.ts';

// ---------------------------------------------------------------------------
// Specs and builder
// ---------------------------------------------------------------------------

export interface FixtureFile {
  path: string;
  oldPath?: string;
  status?: FileStatus;
  base?: string[];
  head?: string[];
  binary?: boolean;
  sensitive?: boolean;
  /** Component key from `components`. */
  component: string;
  role?: FileRole;
  language?: string | null;
  trivial?: boolean;
  truncated?: boolean;
  importance?: number;
  /** Counts to report when the patch is truncated. */
  additions?: number;
  deletions?: number;
}

export interface FixtureComponent {
  key: string;
  name: string;
  path: string;
  kind: ComponentKind;
}

export interface FixtureSymbol {
  name: string;
  kind: SymbolKind;
  change: 'added' | 'modified' | 'removed';
  file: string;
  side?: Side;
  startLine: number;
  endLine: number;
  exported?: boolean;
}

export interface FixtureRisk {
  severity: RiskSeverity;
  category: RiskCategory;
  title: string;
  detail: string;
  files?: string[];
  ref?: CodeRef | null;
}

export interface FixtureSpec {
  files: FixtureFile[];
  components: FixtureComponent[];
  symbols?: FixtureSymbol[];
  risks?: FixtureRisk[];
  relationships?: { from: string; to: string; kind: Relationship['kind']; file: string }[];
  dependencies?: (Omit<DependencyChange, 'id' | 'fileId'> & { file: string })[];
  pr?: Partial<NonNullable<ChangeSet['pr']>> | null;
  source?: 'github' | 'local';
  commits?: { subject: string; body?: string }[];
  linkedIssues?: { title: string; body: string }[];
  inputs?: Partial<ContextInputs>;
  tree?: string[];
  readme?: string | null;
  config?: ConfigInput;
  suggestedDurationSec?: number;
  architectureSignals?: string[];
}

export interface Fixture {
  changeSet: ChangeSet;
  analysis: Analysis;
  inputs: ContextInputs;
  reader: RepoReader;
  config: Config;
  deps: ValidationDeps;
  id: {
    file(path: string): string;
    hunk(path: string, n?: number): string;
    symbol(name: string): string;
    component(key: string): string;
    risk(n: number): string;
  };
}

const join = (lines: string[]): string => `${lines.join('\n')}\n`;

export function buildFixture(spec: FixtureSpec): Fixture {
  const config = resolveConfig({ skipFile: true, env: {}, overrides: spec.config });
  // Like the sources, mark a file sensitive when its path or its previous path is off limits.
  const isProtected = createPathPolicy(config.privacy.excludePaths);
  const contents = new Map<string, string>();
  const fileIds = new Map<string, string>();
  const files: ChangedFile[] = spec.files.map((f, index) => {
    const id = `F${index + 1}`;
    fileIds.set(f.path, id);
    const status: FileStatus = f.status ?? (f.base && f.head ? 'modified' : f.head ? 'added' : 'deleted');
    if (f.base) contents.set(`base:${f.oldPath ?? f.path}`, join(f.base));
    if (f.head && !f.binary) contents.set(`head:${f.path}`, join(f.head));
    const hunks =
      f.binary || f.truncated
        ? []
        : makeHunks(f.base ? join(f.base) : null, f.head ? join(f.head) : null, id);
    const lines = hunks.flatMap((h) => h.lines);
    return {
      id,
      path: f.path,
      oldPath: f.oldPath ?? null,
      status,
      additions: f.binary
        ? 0
        : f.truncated
          ? (f.additions ?? 0)
          : lines.filter((l) => l.kind === 'add').length,
      deletions: f.binary
        ? 0
        : f.truncated
          ? (f.deletions ?? 0)
          : lines.filter((l) => l.kind === 'del').length,
      binary: f.binary ?? false,
      language: f.language === undefined ? 'typescript' : f.language,
      hunks,
      patchTruncated: f.truncated ?? false,
      sensitive: f.sensitive ?? (isProtected(f.path) || (f.oldPath !== undefined && isProtected(f.oldPath))),
    };
  });

  const componentIds = new Map<string, string>();
  for (const [index, c] of spec.components.entries()) componentIds.set(c.key, `M${index + 1}`);
  const fileComponent = new Map(spec.files.map((f) => [f.path, f.component]));

  const symbols: SymbolChange[] = (spec.symbols ?? []).map((s, index) => ({
    id: `S${index + 1}`,
    name: s.name,
    kind: s.kind,
    change: s.change,
    fileId: fileIds.get(s.file)!,
    path: s.file,
    side: s.side ?? (s.change === 'removed' ? 'base' : 'head'),
    startLine: s.startLine,
    endLine: s.endLine,
    exported: s.exported ?? true,
  }));

  const insights: FileInsight[] = spec.files.map((f, index) => ({
    fileId: fileIds.get(f.path)!,
    path: f.path,
    role: f.role ?? 'source',
    componentId: componentIds.get(f.component)!,
    hidden: files[index]!.sensitive,
    trivial: f.trivial ?? false,
    trivialReason: f.trivial ? 'not explained in depth' : null,
    importance: f.importance ?? (f.trivial ? 0.05 : 0.6),
    symbolIds: symbols.filter((s) => s.path === f.path).map((s) => s.id),
  }));

  const components: Component[] = spec.components.map((c) => {
    const own = files.filter((f) => fileComponent.get(f.path) === c.key);
    const statuses = new Set(own.map((f) => f.status));
    return {
      id: componentIds.get(c.key)!,
      name: c.name,
      path: c.path,
      kind: c.kind,
      fileIds: own.map((f) => f.id),
      additions: own.reduce((sum, f) => sum + f.additions, 0),
      deletions: own.reduce((sum, f) => sum + f.deletions, 0),
      status:
        statuses.size === 1 && statuses.has('added')
          ? 'added'
          : statuses.size === 1 && statuses.has('deleted')
            ? 'removed'
            : 'modified',
    };
  });

  const keyHunks: KeyHunk[] = [];
  for (const file of files) {
    const insight = insights.find((i) => i.fileId === file.id)!;
    if (insight.trivial || file.binary || file.sensitive) continue;
    for (const hunk of file.hunks) {
      const side: Side = hunk.newLines > 0 ? 'head' : 'base';
      keyHunks.push({
        id: hunk.id,
        fileId: file.id,
        path: file.path,
        side,
        startLine: side === 'head' ? hunk.newStart : hunk.oldStart,
        endLine: side === 'head' ? hunk.newStart + hunk.newLines - 1 : hunk.oldStart + hunk.oldLines - 1,
        score: Math.round((insight.importance + (file.additions + file.deletions) / 200) * 100) / 100,
        reasons: ['changed lines in a source file'],
      });
    }
  }
  keyHunks.sort((a, b) => b.score - a.score);

  const risks: RiskSignal[] = (spec.risks ?? []).map((r, index) => ({
    id: `R${index + 1}`,
    severity: r.severity,
    category: r.category,
    title: r.title,
    detail: r.detail,
    evidence: (r.files ?? []).map((p) => fileIds.get(p)!),
    ref: r.ref ?? null,
  }));

  const dependencies: DependencyChange[] = (spec.dependencies ?? []).map((d, index) => {
    const { file, ...rest } = d;
    return { ...rest, id: `D${index + 1}`, fileId: fileIds.get(file)! };
  });

  const relationships: Relationship[] = (spec.relationships ?? []).map((r) => ({
    from: componentIds.get(r.from)!,
    to: componentIds.get(r.to)!,
    kind: r.kind,
    evidence: fileIds.get(r.file)!,
  }));

  const pr =
    spec.pr === null
      ? null
      : spec.pr
        ? {
            number: 42,
            title: 'Change',
            body: '',
            url: 'https://github.com/example/weather/pull/42',
            author: 'octocat',
            baseRef: 'main',
            headRef: 'feature/change',
            labels: [],
            draft: false,
            state: 'open' as const,
            ...spec.pr,
          }
        : null;
  const commits = (spec.commits ?? []).map((c, index) => ({
    id: `CM${index + 1}`,
    sha: `${index + 1}`.repeat(40).slice(0, 40),
    subject: c.subject,
    body: c.body ?? '',
  }));
  const linkedIssues = (spec.linkedIssues ?? []).map((issue, index) => ({
    id: `IS${index + 1}`,
    number: 10 + index,
    title: issue.title,
    body: issue.body,
    url: `https://github.com/example/weather/issues/${10 + index}`,
  }));
  const source = spec.source ?? (pr ? 'github' : 'local');

  const changeSet: ChangeSet = {
    source,
    repo: {
      host: source === 'github' ? 'github.com' : 'local',
      owner: source === 'github' ? 'example' : null,
      name: source === 'github' ? 'weather' : 'inventory',
      isPrivate: source === 'github' ? true : null,
      defaultBranch: 'main',
      webUrl: source === 'github' ? 'https://github.com/example/weather' : null,
    },
    base: { ref: 'main', sha: 'a'.repeat(40) },
    head: { ref: pr?.headRef ?? 'feature/change', sha: 'b'.repeat(40) },
    pr,
    linkedIssues,
    commits,
    files,
    stats: {
      files: files.length,
      additions: files.reduce((sum, f) => sum + f.additions, 0),
      deletions: files.reduce((sum, f) => sum + f.deletions, 0),
    },
    limits: { filesCapped: false, commitsCapped: false, note: null },
    repoContext: {
      tree: spec.tree ?? files.map((f) => f.path),
      treeTruncated: false,
      readmeExcerpt: spec.readme ?? null,
      manifests: [],
    },
  };

  const inputs: ContextInputs = { task: null, notes: null, tests: [], screenshots: [], ...spec.inputs };

  const evidence: EvidenceItem[] = [];
  if (pr)
    evidence.push({
      id: 'PR',
      kind: 'pr',
      label: 'Pull request title and description',
      ref: null,
      url: pr.url,
    });
  if (inputs.task)
    evidence.push({ id: 'TASK', kind: 'task', label: 'Task description', ref: null, url: null });
  if (inputs.notes)
    evidence.push({ id: 'NOTES', kind: 'notes', label: 'Implementation notes', ref: null, url: null });
  for (const t of inputs.tests)
    evidence.push({ id: t.id, kind: 'test', label: `Test: ${t.command}`, ref: null, url: null });
  for (const issue of linkedIssues)
    evidence.push({
      id: issue.id,
      kind: 'issue',
      label: `Issue #${issue.number}`,
      ref: null,
      url: issue.url,
    });
  for (const commit of commits)
    evidence.push({ id: commit.id, kind: 'commit', label: commit.subject, ref: null, url: null });
  for (const file of files) {
    evidence.push({ id: file.id, kind: 'file', label: file.path, ref: null, url: null });
    for (const hunk of file.hunks) {
      const side: Side = hunk.newLines > 0 ? 'head' : 'base';
      const startLine = side === 'head' ? hunk.newStart : hunk.oldStart;
      const endLine = side === 'head' ? hunk.newStart + hunk.newLines - 1 : hunk.oldStart + hunk.oldLines - 1;
      evidence.push({
        id: hunk.id,
        kind: 'hunk',
        label: `${file.path}:${startLine}-${endLine}`,
        ref: { path: file.path, side, startLine, endLine },
        url: null,
      });
    }
  }
  for (const s of symbols) {
    evidence.push({
      id: s.id,
      kind: 'symbol',
      label: `${s.name} (${s.kind})`,
      ref: { path: s.path, side: s.side, startLine: s.startLine, endLine: s.endLine },
      url: null,
    });
  }
  for (const c of components)
    evidence.push({ id: c.id, kind: 'component', label: c.name, ref: null, url: null });
  for (const r of risks) evidence.push({ id: r.id, kind: 'risk', label: r.title, ref: r.ref, url: null });
  for (const d of dependencies)
    evidence.push({ id: d.id, kind: 'dependency', label: `${d.name} ${d.change}`, ref: null, url: null });
  for (const s of inputs.screenshots)
    evidence.push({ id: s.id, kind: 'screenshot', label: s.caption, ref: null, url: null });
  evidence.push({ id: 'REPO', kind: 'repo', label: 'Repository structure', ref: null, url: null });

  const analysis: Analysis = {
    version: 1,
    size: files.length > 8 ? 'm' : 's',
    meaningfulLines: files
      .filter((f) => !insights.find((i) => i.fileId === f.id)!.trivial)
      .reduce((sum, f) => sum + f.additions + f.deletions, 0),
    files: insights,
    components,
    relationships,
    symbols,
    keyHunks,
    risks,
    dependencies,
    tests: {
      added: spec.files
        .filter((f) => f.role === 'test' && (f.status ?? (f.base ? 'modified' : 'added')) === 'added')
        .map((f) => f.path),
      modified: spec.files.filter((f) => f.role === 'test' && f.base && f.head).map((f) => f.path),
      removed: [],
    },
    languages: [{ language: 'typescript', files: files.length }],
    architectureSignals: spec.architectureSignals ?? [],
    suggestedDurationSec: spec.suggestedDurationSec ?? 60,
    evidence,
  };

  const reader: RepoReader = {
    async readFile(path, side) {
      return contents.get(`${side}:${path}`) ?? null;
    },
  };
  const hunkId = (path: string, n = 1): string => `${fileIds.get(path)!}.H${n}`;

  return {
    changeSet,
    analysis,
    inputs,
    reader,
    config,
    deps: { changeSet, analysis, inputs, reader, config },
    id: {
      file: (path) => fileIds.get(path) ?? `?${path}`,
      hunk: hunkId,
      symbol: (name) => symbols.find((s) => s.name === name)?.id ?? `?${name}`,
      component: (key) => componentIds.get(key) ?? `?${key}`,
      risk: (n) => `R${n}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture 1: a GitHub pull request in a TypeScript service
// ---------------------------------------------------------------------------

const RETRY_SOURCE = [
  "import { setTimeout as sleep } from 'node:timers/promises';",
  '',
  '/** Maximum number of attempts for one request. */',
  'export const MAX_RETRIES = 3;',
  'const BASE_DELAY_MS = 200;',
  '',
  'export interface RetryOptions {',
  '  attempts?: number;',
  '  baseDelayMs?: number;',
  '}',
  '',
  '/** Delay before the given retry, doubling each time. */',
  'export function delayFor(attempt: number, baseDelayMs = BASE_DELAY_MS): number {',
  '  return baseDelayMs * 2 ** attempt;',
  '}',
  '',
  '/** Retry a request on server errors with exponential backoff. */',
  'export async function fetchWithBackoff(',
  '  input: string,',
  '  init: RequestInit = {},',
  '  options: RetryOptions = {},',
  '): Promise<Response> {',
  '  const attempts = options.attempts ?? MAX_RETRIES;',
  '  for (let attempt = 0; ; attempt++) {',
  '    const response = await fetch(input, init);',
  '    if (response.status < 500 || attempt >= attempts - 1) return response;',
  '    await sleep(delayFor(attempt, options.baseDelayMs));',
  '  }',
  '}',
];

const CLIENT_BASE = [
  "import { logger } from '../log.ts';",
  '',
  'export class ApiClient {',
  '  readonly baseUrl: string;',
  '',
  '  constructor(baseUrl: string) {',
  '    this.baseUrl = baseUrl;',
  '  }',
  '',
  '  async get(path: string): Promise<Response> {',
  "    logger.debug('GET ' + path);",
  '    return fetch(this.baseUrl + path);',
  '  }',
  '}',
];

const CLIENT_HEAD = [
  "import { logger } from '../log.ts';",
  "import { fetchWithBackoff } from './retry.ts';",
  '',
  'export class ApiClient {',
  '  readonly baseUrl: string;',
  '',
  '  constructor(baseUrl: string) {',
  '    this.baseUrl = baseUrl;',
  '  }',
  '',
  '  async get(path: string): Promise<Response> {',
  "    logger.debug('GET ' + path);",
  '    return fetchWithBackoff(this.baseUrl + path);',
  '  }',
  '}',
];

const RETRY_TEST = [
  "import { describe, expect, it } from 'vitest';",
  "import { delayFor } from './retry.ts';",
  '',
  "describe('delayFor', () => {",
  "  it('doubles the delay for each attempt', () => {",
  '    expect(delayFor(0, 100)).toBe(100);',
  '    expect(delayFor(1, 100)).toBe(200);',
  '    expect(delayFor(2, 100)).toBe(400);',
  '  });',
  '});',
];

/** A pull request that adds a retry helper and uses it in the API client. */
export function retryFixture(overrides: Partial<FixtureSpec> = {}): Fixture {
  return buildFixture({
    pr: {
      title: 'Add retry with backoff to the HTTP client',
      body: 'Requests to the weather API now retry when the server answers with a 5xx status.\n\n## Test plan\n- Added unit tests for the delay calculation.\n',
    },
    commits: [{ subject: 'Add retry helper' }, { subject: 'Use the retry helper in ApiClient' }],
    readme: 'Weather service for the weather system.',
    files: [
      { path: 'src/http/retry.ts', head: RETRY_SOURCE, component: 'http', importance: 0.9 },
      {
        path: 'src/http/client.ts',
        base: CLIENT_BASE,
        head: CLIENT_HEAD,
        component: 'http',
        importance: 0.7,
      },
      { path: 'src/http/retry.test.ts', head: RETRY_TEST, component: 'tests', role: 'test', importance: 0.4 },
      {
        path: 'docs/retry.md',
        head: ['# Retry', '', 'Server errors are retried with a growing delay.'],
        component: 'docs',
        role: 'docs',
        language: 'markdown',
        importance: 0.2,
      },
      {
        path: 'package-lock.json',
        status: 'modified',
        truncated: true,
        additions: 120,
        deletions: 80,
        component: 'root',
        role: 'lockfile',
        language: 'json',
        trivial: true,
      },
      {
        path: '.env',
        base: ['API_TOKEN=placeholder-value'],
        head: ['API_TOKEN=another-placeholder'],
        component: 'root',
        role: 'config',
        sensitive: true,
        language: null,
      },
      {
        path: 'assets/logo.png',
        binary: true,
        status: 'modified',
        component: 'root',
        role: 'asset',
        language: null,
        trivial: true,
      },
    ],
    components: [
      { key: 'http', name: 'http', path: 'src/http', kind: 'module' },
      { key: 'tests', name: 'http tests', path: 'src/http', kind: 'tests' },
      { key: 'docs', name: 'docs', path: 'docs', kind: 'docs' },
      { key: 'root', name: 'project files', path: '.', kind: 'config' },
    ],
    symbols: [
      {
        name: 'fetchWithBackoff',
        kind: 'function',
        change: 'added',
        file: 'src/http/retry.ts',
        startLine: 18,
        endLine: 29,
      },
      {
        name: 'delayFor',
        kind: 'function',
        change: 'added',
        file: 'src/http/retry.ts',
        startLine: 13,
        endLine: 15,
      },
      {
        name: 'MAX_RETRIES',
        kind: 'constant',
        change: 'added',
        file: 'src/http/retry.ts',
        startLine: 4,
        endLine: 4,
      },
      {
        name: 'get',
        kind: 'method',
        change: 'modified',
        file: 'src/http/client.ts',
        startLine: 11,
        endLine: 14,
        exported: false,
      },
    ],
    relationships: [{ from: 'tests', to: 'http', kind: 'tests', file: 'src/http/retry.test.ts' }],
    risks: [
      {
        severity: 'medium',
        category: 'error-handling',
        title: 'Retries on every server error',
        detail: 'fetchWithBackoff retries any response with a status of 500 or above.',
        files: ['src/http/retry.ts'],
        ref: { path: 'src/http/retry.ts', side: 'head', startLine: 18, endLine: 29 },
      },
      {
        severity: 'low',
        category: 'dependency',
        title: 'Lockfile changed',
        detail: 'package-lock.json has 120 added and 80 removed lines.',
        files: ['package-lock.json'],
      },
      {
        severity: 'high',
        category: 'config',
        title: 'Environment file changed',
        detail: 'A file that holds settings was changed. Its content is not shown.',
        files: ['.env'],
        ref: { path: '.env', side: 'head', startLine: 1, endLine: 1 },
      },
    ],
    dependencies: [
      {
        ecosystem: 'npm',
        name: 'undici',
        change: 'updated',
        from: '6.0.0',
        to: '6.1.0',
        dev: false,
        file: 'package-lock.json',
      },
    ],
    inputs: {
      task: 'Make weather requests survive short server outages.',
      tests: [{ id: 'T1', command: 'npm test', passed: true, summary: '12 tests passed', source: 'agent' }],
      screenshots: [
        {
          id: 'SS1',
          path: '/nonexistent/forecast.png',
          caption: 'Forecast page after the change',
          moment: 'after',
        },
      ],
    },
    architectureSignals: ['New module src/http/retry.ts'],
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Fixture 2: a local change in a Python project (no PR, no task, no risks)
// ---------------------------------------------------------------------------

const REPORT_BASE = [
  'from decimal import Decimal',
  '',
  '',
  'def format_report(number, lines):',
  '    """Return the report as text."""',
  '    out = [f"Report {number}"]',
  '    for name, price in lines:',
  '        out.append(f"{name}: {price}")',
  '    out.append(f"Total: {sum(price for _, price in lines)}")',
  '    return "\\n".join(out)',
  '',
  '',
  'def parse_score(text):',
  '    return Decimal(text.strip())',
];

const REPORT_HEAD = [
  'from decimal import Decimal',
  '',
  'BONUS_RATE = Decimal("0.2")',
  '',
  '',
  'def total_with_bonus(lines):',
  '    """Return the sum of all line prices plus the bonus."""',
  '    base_total = sum(price for _, price in lines)',
  '    return base_total * (1 + BONUS_RATE)',
  '',
  '',
  'def format_report(number, lines):',
  '    """Return the report as text."""',
  '    out = [f"Report {number}"]',
  '    for name, price in lines:',
  '        out.append(f"{name}: {price}")',
  '    out.append(f"Total: {total_with_bonus(lines)}")',
  '    return "\\n".join(out)',
  '',
  '',
  'def parse_score(text):',
  '    return Decimal(text.strip())',
];

const LEGACY_BASE = [
  'import csv',
  '',
  '',
  'def export_all(rows, path):',
  '    with open(path, "w", newline="") as handle:',
  '        writer = csv.writer(handle)',
  '        for row in rows:',
  '            writer.writerow(row)',
];

const MISC_BASE = [
  'def slugify(text):',
  '    return text.lower().replace(" ", "-")',
  '',
  'def unused():',
  '    return None',
];
const HELPERS_HEAD = ['def slugify(text):', '    return text.lower().replace(" ", "-")'];

/** A local change: edits, a deletion, a rename, docs and a new test. */
export function inventoryFixture(overrides: Partial<FixtureSpec> = {}): Fixture {
  return buildFixture({
    source: 'local',
    pr: null,
    commits: [{ subject: 'Add a bonus to reports and drop the legacy export' }],
    files: [
      {
        path: 'app/reports/report.py',
        base: REPORT_BASE,
        head: REPORT_HEAD,
        component: 'reports',
        language: 'python',
        importance: 0.9,
      },
      {
        path: 'app/legacy/old_export.py',
        base: LEGACY_BASE,
        status: 'deleted',
        component: 'legacy',
        language: 'python',
        importance: 0.5,
      },
      {
        path: 'app/utils/helpers.py',
        oldPath: 'app/utils/misc.py',
        status: 'renamed',
        base: MISC_BASE,
        head: HELPERS_HEAD,
        component: 'utils',
        language: 'python',
        importance: 0.4,
      },
      {
        path: 'README.md',
        base: ['# Inventory'],
        head: ['# Inventory', '', 'The bonus is added to every report.'],
        component: 'docs',
        role: 'docs',
        language: 'markdown',
        importance: 0.2,
      },
      {
        path: 'tests/test_report.py',
        head: [
          'from app.reports.report import total_with_bonus',
          '',
          'def test_total():',
          '    assert total_with_bonus([("a", 10)]) == 12',
        ],
        component: 'tests',
        role: 'test',
        language: 'python',
        importance: 0.4,
      },
    ],
    components: [
      { key: 'reports', name: 'reports', path: 'app/forecast', kind: 'module' },
      { key: 'legacy', name: 'legacy', path: 'app/legacy', kind: 'module' },
      { key: 'utils', name: 'utils', path: 'app/utils', kind: 'module' },
      { key: 'docs', name: 'docs', path: '.', kind: 'docs' },
      { key: 'tests', name: 'tests', path: 'tests', kind: 'tests' },
    ],
    symbols: [
      {
        name: 'total_with_bonus',
        kind: 'function',
        change: 'added',
        file: 'app/reports/report.py',
        startLine: 6,
        endLine: 9,
      },
      {
        name: 'format_report',
        kind: 'function',
        change: 'modified',
        file: 'app/reports/report.py',
        startLine: 12,
        endLine: 18,
      },
      {
        name: 'export_all',
        kind: 'function',
        change: 'removed',
        file: 'app/legacy/old_export.py',
        side: 'base',
        startLine: 4,
        endLine: 8,
      },
    ],
    relationships: [{ from: 'tests', to: 'reports', kind: 'tests', file: 'tests/test_report.py' }],
    inputs: { notes: 'Moved the helpers into one module and dropped the unused legacy export.' },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Fixture 3: one small change in one component
// ---------------------------------------------------------------------------

/** A single-file change: no architecture, no risks, no PR text. */
export function tinyFixture(overrides: Partial<FixtureSpec> = {}): Fixture {
  return buildFixture({
    source: 'local',
    pr: null,
    files: [
      {
        path: 'src/greet.ts',
        base: ['export function greet(name: string): string {', '  return "Hello " + name;', '}'],
        head: ['export function greet(name: string): string {', '  return "Hello, " + name + "!";', '}'],
        component: 'app',
      },
    ],
    components: [{ key: 'app', name: 'app', path: 'src', kind: 'module' }],
    symbols: [
      { name: 'greet', kind: 'function', change: 'modified', file: 'src/greet.ts', startLine: 1, endLine: 3 },
    ],
    ...overrides,
  });
}
