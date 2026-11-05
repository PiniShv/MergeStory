/**
 * A small sample change (files, diff hunks, analysis, storyboard and narration) used by the tests
 * of the visuals and render modules. Nothing here touches the disk or the network.
 */
import { STORYBOARD_VERSION, type Storyboard } from '../core/storyboard-schema.ts';
import type {
  Analysis,
  ChangedFile,
  ChangeSet,
  ContextInputs,
  DiffHunk,
  DiffLine,
  NarrationResult,
  RepoReader,
  Side,
} from '../core/types.ts';

/** A reader backed by a map. Keys are "head:path" and "base:path". */
export function memoryReader(files: Record<string, string>): RepoReader & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async readFile(path: string, side: Side): Promise<string | null> {
      reads.push(`${side}:${path}`);
      return files[`${side}:${path}`] ?? null;
    },
  };
}

const CLIENT_BASE = `import { request } from './http.ts';

export interface ClientOptions {
  baseUrl: string;
  timeoutMs: number;
}

export async function send(options: ClientOptions, path: string): Promise<Response> {
  const response = await request(options.baseUrl + path, { timeout: options.timeoutMs });
  if (!response.ok) {
    throw new Error(\`HTTP \${response.status}\`);
  }
  return response;
}
`;

const CLIENT_HEAD = `import { request } from './http.ts';
import { withRetry, HttpError } from './retry/backoff.ts';

export interface ClientOptions {
  baseUrl: string;
  timeoutMs: number;
}

export async function send(options: ClientOptions, path: string): Promise<Response> {
  return withRetry(async () => {
    const response = await request(options.baseUrl + path, { timeout: options.timeoutMs });
    if (!response.ok) {
      throw new HttpError(response.status);
    }
    return response;
  });
}
`;

const BACKOFF_HEAD = `export class HttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(\`HTTP \${status}\`);
    this.status = status;
  }

  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

/** Run \`fn\` again after a growing delay while it fails with a retryable error. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let delayMs = 200;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !(err instanceof HttpError) || !err.retryable) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs *= 2;
    }
  }
}
`;

function diffLine(
  kind: DiffLine['kind'],
  text: string,
  oldLine: number | null,
  newLine: number | null,
): DiffLine {
  return { kind, text, oldLine, newLine };
}

const CLIENT_HUNK: DiffHunk = {
  id: 'F2.H1',
  oldStart: 1,
  oldLines: 14,
  newStart: 1,
  newLines: 17,
  header: '',
  lines: [
    diffLine('ctx', "import { request } from './http.ts';", 1, 1),
    diffLine('add', "import { withRetry, HttpError } from './retry/backoff.ts';", null, 2),
    diffLine('ctx', '', 2, 3),
    diffLine('ctx', 'export interface ClientOptions {', 3, 4),
    diffLine('ctx', '  baseUrl: string;', 4, 5),
    diffLine('ctx', '  timeoutMs: number;', 5, 6),
    diffLine('ctx', '}', 6, 7),
    diffLine('ctx', '', 7, 8),
    diffLine(
      'ctx',
      'export async function send(options: ClientOptions, path: string): Promise<Response> {',
      8,
      9,
    ),
    diffLine(
      'del',
      '  const response = await request(options.baseUrl + path, { timeout: options.timeoutMs });',
      9,
      null,
    ),
    diffLine('del', '  if (!response.ok) {', 10, null),
    diffLine('del', '    throw new Error(`HTTP ${response.status}`);', 11, null),
    diffLine('del', '  }', 12, null),
    diffLine('del', '  return response;', 13, null),
    diffLine('add', '  return withRetry(async () => {', null, 10),
    diffLine(
      'add',
      '    const response = await request(options.baseUrl + path, { timeout: options.timeoutMs });',
      null,
      11,
    ),
    diffLine('add', '    if (!response.ok) {', null, 12),
    diffLine('add', '      throw new HttpError(response.status);', null, 13),
    diffLine('add', '    }', null, 14),
    diffLine('add', '    return response;', null, 15),
    diffLine('add', '  });', null, 16),
    diffLine('ctx', '}', 14, 17),
  ],
};

function addedFile(id: string, path: string, content: string): ChangedFile {
  const lines = content.replace(/\n$/, '').split('\n');
  return {
    id,
    path,
    oldPath: null,
    status: 'added',
    additions: lines.length,
    deletions: 0,
    binary: false,
    language: 'typescript',
    patchTruncated: false,
    sensitive: false,
    hunks: [
      {
        id: `${id}.H1`,
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: lines.length,
        header: '',
        lines: lines.map((text, i) => diffLine('add', text, null, i + 1)),
      },
    ],
  };
}

export interface Sample {
  changeSet: ChangeSet;
  analysis: Analysis;
  inputs: ContextInputs;
  reader: ReturnType<typeof memoryReader>;
  storyboard: Storyboard;
  narration: NarrationResult;
}

/** Reader content for the sample change. */
export function sampleFiles(): Record<string, string> {
  return {
    'head:src/client.ts': CLIENT_HEAD,
    'base:src/client.ts': CLIENT_BASE,
    'head:src/retry/backoff.ts': BACKOFF_HEAD,
  };
}

export function sampleChangeSet(): ChangeSet {
  const backoff = addedFile('F1', 'src/retry/backoff.ts', BACKOFF_HEAD);
  const client: ChangedFile = {
    id: 'F2',
    path: 'src/client.ts',
    oldPath: null,
    status: 'modified',
    additions: 9,
    deletions: 5,
    binary: false,
    language: 'typescript',
    patchTruncated: false,
    sensitive: false,
    hunks: [CLIENT_HUNK],
  };
  const test: ChangedFile = {
    id: 'F3',
    path: 'src/client.test.ts',
    oldPath: null,
    status: 'modified',
    additions: 12,
    deletions: 1,
    binary: false,
    language: 'typescript',
    patchTruncated: false,
    sensitive: false,
    hunks: [],
  };
  const lock: ChangedFile = {
    id: 'F4',
    path: 'package-lock.json',
    oldPath: null,
    status: 'modified',
    additions: 4,
    deletions: 4,
    binary: false,
    language: 'json',
    patchTruncated: false,
    sensitive: false,
    hunks: [],
  };
  const files = [backoff, client, test, lock];
  return {
    source: 'github',
    repo: {
      host: 'github.com',
      owner: 'example',
      name: 'weather',
      isPrivate: true,
      defaultBranch: 'main',
      webUrl: 'https://github.com/example/weather',
    },
    base: { ref: 'main', sha: '1111111222222233333334444444555555566666' },
    head: { ref: 'feature/retry', sha: '3f9c2ab0000000000000000000000000000000ff' },
    pr: {
      number: 42,
      title: 'Retry failed forecast requests',
      body: 'Adds exponential backoff to the weather client.',
      url: 'https://github.com/example/weather/pull/42',
      author: 'octocat',
      baseRef: 'main',
      headRef: 'feature/retry',
      labels: [],
      draft: false,
      state: 'open',
    },
    linkedIssues: [],
    commits: [
      { id: 'CM1', sha: '3f9c2ab0000000000000000000000000000000ff', subject: 'Retry requests', body: '' },
    ],
    files,
    stats: {
      files: files.length,
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
    },
    limits: { filesCapped: false, commitsCapped: false, note: null },
    repoContext: { tree: [], treeTruncated: false, readmeExcerpt: null, manifests: [] },
  };
}

export function sampleAnalysis(): Analysis {
  return {
    version: 1,
    size: 's',
    meaningfulLines: 26,
    files: [
      {
        fileId: 'F1',
        path: 'src/retry/backoff.ts',
        role: 'source',
        componentId: 'M1',
        hidden: false,
        trivial: false,
        trivialReason: null,
        importance: 0.9,
        symbolIds: ['S1'],
      },
      {
        fileId: 'F2',
        path: 'src/client.ts',
        role: 'source',
        componentId: 'M2',
        hidden: false,
        trivial: false,
        trivialReason: null,
        importance: 0.8,
        symbolIds: ['S2'],
      },
      {
        fileId: 'F3',
        path: 'src/client.test.ts',
        role: 'test',
        componentId: 'M2',
        hidden: false,
        trivial: false,
        trivialReason: null,
        importance: 0.4,
        symbolIds: [],
      },
      {
        fileId: 'F4',
        path: 'package-lock.json',
        role: 'lockfile',
        componentId: 'M3',
        hidden: false,
        trivial: true,
        trivialReason: 'lockfile',
        importance: 0.05,
        symbolIds: [],
      },
    ],
    components: [
      {
        id: 'M1',
        name: 'retry',
        path: 'src/retry',
        kind: 'module',
        fileIds: ['F1'],
        additions: 22,
        deletions: 0,
        status: 'added',
      },
      {
        id: 'M2',
        name: 'client',
        path: 'src',
        kind: 'module',
        fileIds: ['F2', 'F3'],
        additions: 21,
        deletions: 6,
        status: 'modified',
      },
      {
        id: 'M3',
        name: 'dependencies',
        path: '.',
        kind: 'config',
        fileIds: ['F4'],
        additions: 4,
        deletions: 4,
        status: 'modified',
      },
    ],
    relationships: [{ from: 'M2', to: 'M1', kind: 'imports', evidence: 'F2' }],
    symbols: [],
    keyHunks: [],
    risks: [],
    dependencies: [],
    tests: { added: [], modified: ['src/client.test.ts'], removed: [] },
    languages: [{ language: 'typescript', files: 3 }],
    architectureSignals: ['New module src/retry/'],
    suggestedDurationSec: 60,
    evidence: [
      { id: 'PR', kind: 'pr', label: 'PR description', ref: null, url: null },
      { id: 'F1', kind: 'file', label: 'src/retry/backoff.ts', ref: null, url: null },
      { id: 'F2', kind: 'file', label: 'src/client.ts', ref: null, url: null },
      {
        id: 'F2.H1',
        kind: 'hunk',
        label: 'src/client.ts:8-16',
        ref: { path: 'src/client.ts', side: 'head', startLine: 8, endLine: 16 },
        url: null,
      },
      { id: 'S1', kind: 'symbol', label: 'withRetry (src/retry/backoff.ts:16-27)', ref: null, url: null },
      { id: 'M1', kind: 'component', label: 'retry', ref: null, url: null },
      { id: 'T1', kind: 'test', label: 'npm test', ref: null, url: null },
    ],
  };
}

export function sampleInputs(): ContextInputs {
  return {
    task: null,
    notes: null,
    tests: [{ id: 'T1', command: 'npm test', passed: true, summary: '42 passed', source: 'agent' }],
    screenshots: [],
  };
}

export function sampleStoryboard(): Storyboard {
  const line = (text: string, evidence: string[] = []) => ({ text, evidence });
  return {
    version: STORYBOARD_VERSION,
    title: 'Retry failed forecast requests',
    summary: 'The weather client now retries failed requests with a growing delay.',
    style: 'hybrid',
    language: 'en',
    uncertainties: [],
    reviewChecklist: [],
    scenes: [
      {
        id: 's1',
        role: 'mission',
        title: 'The change',
        narration: [line('This pull request makes forecast requests retry when the server is busy.', ['PR'])],
        visual: {
          type: 'title',
          kicker: 'Pull request #42',
          heading: 'Retry failed forecast requests',
          subheading: 'example/weather',
          chips: ['client', 'retry'],
        },
        visualDescription: 'Title card',
        transition: 'fade',
        targetSeconds: null,
      },
      {
        id: 's2',
        role: 'mission',
        title: 'Why it matters',
        narration: [
          line('Forecast calls failed on short outages.', ['PR']),
          line('The goal is to retry only errors that can recover.', ['PR']),
        ],
        visual: {
          type: 'mission',
          problem: 'One failed request meant a failed forecast.',
          goal: 'Retry recoverable errors with a growing delay.',
          points: [
            { text: 'Only 429 and 5xx are retried', beat: 1 },
            { text: 'At most four attempts', beat: 1 },
          ],
        },
        visualDescription: 'Problem and goal',
        transition: 'slide',
        targetSeconds: null,
      },
      {
        id: 's3',
        role: 'big-picture',
        title: 'What changed',
        narration: [line('Two source files changed and one is new.', ['F1', 'F2'])],
        visual: { type: 'files', highlightPaths: ['src/retry/backoff.ts', 'src/client.ts'], caption: null },
        visualDescription: 'Changed files',
        transition: 'fade',
        targetSeconds: null,
      },
      {
        id: 's4',
        role: 'big-picture',
        title: 'How it fits',
        narration: [
          line('The client now calls the new retry module.', ['M1', 'F2']),
          line('The retry module wraps the existing HTTP layer.', ['M1']),
        ],
        visual: {
          type: 'architecture',
          direction: 'LR',
          nodes: [
            {
              id: 'client',
              label: 'Forecast client',
              detail: 'src/client.ts',
              kind: 'module',
              status: 'modified',
              beat: 0,
              evidence: ['F2'],
            },
            {
              id: 'retry',
              label: 'Retry',
              detail: 'withRetry',
              kind: 'module',
              status: 'added',
              beat: 0,
              evidence: ['F1'],
            },
            {
              id: 'http',
              label: 'HTTP layer',
              detail: null,
              kind: 'external',
              status: 'unchanged',
              beat: 1,
              evidence: [],
            },
          ],
          edges: [
            { from: 'client', to: 'retry', label: 'wraps calls', status: 'added', beat: 0 },
            { from: 'retry', to: 'http', label: null, status: 'added', beat: 1 },
          ],
        },
        visualDescription: 'Diagram',
        transition: 'zoom',
        targetSeconds: null,
      },
      {
        id: 's5',
        role: 'under-the-hood',
        title: 'The client change',
        narration: [
          line('The request is wrapped in a retry call.', ['F2.H1']),
          line('Failures now raise a typed error.', ['F2.H1']),
        ],
        visual: {
          type: 'code',
          ref: { path: 'src/client.ts', side: 'head', startLine: 8, endLine: 16 },
          mode: 'diff',
          focus: [
            { startLine: 10, endLine: 10, note: 'Wrapped in withRetry', beat: 0 },
            { startLine: 13, endLine: 13, note: 'Typed error', beat: 1 },
          ],
          caption: null,
        },
        visualDescription: 'Diff',
        transition: 'wipe',
        targetSeconds: null,
      },
      {
        id: 's6',
        role: 'before-after',
        title: 'Before and after',
        narration: [line('Before, one failure ended the call. Now the call is retried.', ['F2'])],
        visual: {
          type: 'before-after',
          before: {
            label: 'Before',
            kind: 'code',
            codeRef: { path: 'src/client.ts', side: 'base', startLine: 8, endLine: 14 },
            bullets: [],
            terminal: [],
            screenshotId: null,
          },
          after: {
            label: 'After',
            kind: 'terminal',
            codeRef: null,
            bullets: [],
            terminal: [
              { kind: 'command', text: 'send("/forecast")', beat: 0 },
              { kind: 'output', text: 'retry 1 after 200 ms', beat: 0 },
              { kind: 'output', text: '200 OK', beat: 0 },
            ],
            screenshotId: null,
          },
          caption: null,
        },
        visualDescription: 'Before and after',
        transition: 'fade',
        targetSeconds: null,
      },
      {
        id: 's7',
        role: 'review',
        title: 'Tests',
        narration: [line('The author reports that all tests pass.', ['T1'])],
        visual: {
          type: 'terminal',
          title: 'npm test',
          lines: [
            { kind: 'command', text: 'npm test', beat: 0 },
            { kind: 'output', text: '42 passed', beat: 0 },
          ],
        },
        visualDescription: 'Test output',
        transition: 'fade',
        targetSeconds: null,
      },
      {
        id: 's8',
        role: 'conclusion',
        title: 'Summary',
        narration: [line('Failed forecast requests are now retried safely.', ['PR'])],
        visual: {
          type: 'summary',
          points: [
            { text: 'Retries recoverable errors', beat: 0 },
            { text: 'Growing delay between attempts', beat: 0 },
          ],
          closing: 'Review the retry limits.',
        },
        visualDescription: 'Summary',
        transition: 'fade',
        targetSeconds: null,
      },
    ],
  };
}

/** Narration where every beat is `secondsPerBeat` long. */
export function sampleNarration(storyboard: Storyboard, secondsPerBeat = 2.2): NarrationResult {
  return {
    provider: 'none',
    voice: null,
    clips: storyboard.scenes.flatMap((scene) =>
      scene.narration.map((line, beatIndex) => ({
        sceneId: scene.id,
        beatIndex,
        text: line.text,
        spokenText: line.text,
        audioPath: null,
        durationSec: secondsPerBeat,
        cached: false,
      })),
    ),
  };
}

export function sample(): Sample {
  const storyboard = sampleStoryboard();
  return {
    changeSet: sampleChangeSet(),
    analysis: sampleAnalysis(),
    inputs: sampleInputs(),
    reader: memoryReader(sampleFiles()),
    storyboard,
    narration: sampleNarration(storyboard),
  };
}
