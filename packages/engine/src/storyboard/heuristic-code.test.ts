import { describe, expect, it } from 'vitest';
import { diffViewSpan } from '../core/diff-view.ts';
import { STORYBOARD_LIMITS } from '../core/storyboard-schema.ts';
import { buildFixture, type Fixture, retryFixture, tinyFixture } from '../testing/storyboard-fixtures.ts';
import {
  beforeAfterOf,
  callNames,
  changedRuns,
  codeOnly,
  declarationEnd,
  findReferences,
  planWindows,
  proseName,
  sideLines,
  symbolViews,
} from './heuristic-code.ts';
import { createCtx } from './heuristic-context.ts';

const MAX = STORYBOARD_LIMITS.maxCodeLines;

const ctxOf = (fx: Fixture) => createCtx(fx.changeSet, fx.analysis, fx.inputs, fx.config);

/** Plain statements, so that a stretch of lines holds no symbol and no comment. */
const filler = (count: number, tag: string): string[] =>
  Array.from({ length: count }, (_, i) => `const ${tag}${i} = ${i};`);

const APP = [{ key: 'app', name: 'app', path: 'src', kind: 'module' as const }];

/** One new file with a constant, a long private function, an exported function and an interface, far apart. */
function serviceFixture(): Fixture {
  const head = [
    'export const LIMIT = 10;', // 1
    ...filler(8, 'a'), // 2-9
    'function helper(a: number): number {', // 10
    '  let total = 0;',
    '  for (let i = 0; i < a; i++) {',
    '    total += i;',
    '  }',
    '  if (total > LIMIT) {',
    '    total = LIMIT;',
    '  }',
    '  return total;', // 18
    '}', // 19
    ...filler(8, 'b'), // 20-27
    'export function serve(port: number): void {', // 28
    '  listen(port);',
    '  log(port);',
    '  helper(port);',
    '  done();',
    '}', // 33
    ...filler(6, 'c'), // 34-39
    'export interface Options {', // 40
    '  port: number;',
    '  host: string;',
    '  retries: number;',
    '  timeout: number;',
    '  verbose: boolean;',
    '  name: string;',
    '  tags: string[];',
    '  mode: string;',
    '  debug: boolean;',
    '  level: number;',
    '  depth: number;',
    '}', // 52
  ];
  return buildFixture({
    source: 'local',
    pr: null,
    files: [{ path: 'src/svc.ts', head, component: 'app' }],
    components: APP,
    symbols: [
      { name: 'LIMIT', kind: 'constant', change: 'added', file: 'src/svc.ts', startLine: 1, endLine: 1 },
      {
        name: 'helper',
        kind: 'function',
        change: 'added',
        file: 'src/svc.ts',
        startLine: 10,
        endLine: 19,
        exported: false,
      },
      { name: 'serve', kind: 'function', change: 'added', file: 'src/svc.ts', startLine: 28, endLine: 33 },
      { name: 'Options', kind: 'interface', change: 'added', file: 'src/svc.ts', startLine: 40, endLine: 52 },
    ],
  });
}

describe('planWindows: the anchor', () => {
  it('prefers an exported function to a bigger private one, a constant and an interface', () => {
    const [window] = planWindows(ctxOf(serviceFixture()), 1);
    expect(window?.anchor?.name).toBe('serve');
    expect([window?.from, window?.to]).toEqual([28, 33]);
    expect(window?.inView.map((v) => v.name)).toEqual(['serve']);
    expect(window?.side).toBe('head');
    expect(window?.secondary).toBe(false);
  });

  it('puts a private function before an exported constant', () => {
    const fx = buildFixture({
      source: 'local',
      pr: null,
      files: [{ path: 'src/a.ts', head: [...filler(12, 'a'), ...filler(12, 'b')], component: 'app' }],
      components: APP,
      symbols: [
        { name: 'LIMIT', kind: 'constant', change: 'added', file: 'src/a.ts', startLine: 1, endLine: 6 },
        {
          name: 'prepare',
          kind: 'function',
          change: 'added',
          file: 'src/a.ts',
          startLine: 14,
          endLine: 16,
          exported: false,
        },
      ],
    });
    expect(planWindows(ctxOf(fx), 1)[0]?.anchor?.name).toBe('prepare');
  });

  it('counts the lines a change touches, not the length of the symbol', () => {
    // Both functions are in one hunk. The one with more changed lines wins, although the other is as long.
    const base = [
      'export function quiet() {',
      '  return 1;',
      '  // quiet a',
      '}',
      '',
      'export function loud() {',
      '  return 10;',
      '  // loud a',
      '  // loud b',
      '}',
    ];
    const head = [...base];
    head[1] = '  return 2;';
    head[6] = '  return 20;';
    head[7] = '  // loud a2';
    head[8] = '  // loud b2';
    const fx = buildFixture({
      source: 'local',
      pr: null,
      files: [{ path: 'src/a.ts', base, head, component: 'app' }],
      components: APP,
      symbols: [
        { name: 'quiet', kind: 'function', change: 'modified', file: 'src/a.ts', startLine: 1, endLine: 4 },
        { name: 'loud', kind: 'function', change: 'modified', file: 'src/a.ts', startLine: 6, endLine: 10 },
      ],
    });
    expect(fx.changeSet.files[0]!.hunks).toHaveLength(1);
    expect(planWindows(ctxOf(fx), 1)[0]?.anchor?.name).toBe('loud');
  });

  it('describes a class by the members that changed, unless the class is new', () => {
    const body = (extra: string[]): string[] => [
      'export class Box {',
      '  width = 1;',
      ...extra,
      '  size(): number {',
      '    return this.width;',
      '  }',
      '}',
    ];
    const symbols = (change: 'added' | 'modified') => [
      { name: 'Box', kind: 'class' as const, change, file: 'src/box.ts', startLine: 1, endLine: 7 },
      { name: 'Box.size', kind: 'method' as const, change, file: 'src/box.ts', startLine: 3, endLine: 5 },
    ];
    const modified = buildFixture({
      source: 'local',
      pr: null,
      files: [
        {
          path: 'src/box.ts',
          base: body([]),
          head: body([]).map((l) => l.replace('this.width', 'this.width * 2')),
          component: 'app',
        },
      ],
      components: APP,
      symbols: symbols('modified'),
    });
    const [changed] = planWindows(ctxOf(modified), 1);
    expect(changed?.anchor?.name).toBe('Box.size');
    expect(changed?.inView.map((v) => v.name)).toEqual(['Box.size']);

    const added = buildFixture({
      source: 'local',
      pr: null,
      files: [{ path: 'src/box.ts', head: body([]), component: 'app' }],
      components: APP,
      symbols: symbols('added'),
    });
    const [created] = planWindows(ctxOf(added), 1);
    expect(created?.anchor?.name).toBe('Box');
    expect(created?.inView.map((v) => v.name)).toEqual(['Box']);
  });

  it('leaves out a class that is too big to show when something inside it changed', () => {
    const head = [
      'export class Client {',
      ...filler(2, 'f'),
      '  async getForecast(): Promise<void> {', // 4
      ...filler(8, 'm'),
      '  }', // 13
      ...filler(20, 'g'),
      '}', // 34
    ];
    const base = head.map((line, i) => (i === 6 ? 'const old = 0;' : line));
    const fx = buildFixture({
      source: 'local',
      pr: null,
      files: [{ path: 'src/client.ts', base, head, component: 'app' }],
      components: APP,
      symbols: [
        {
          name: 'Client',
          kind: 'class',
          change: 'modified',
          file: 'src/client.ts',
          startLine: 1,
          endLine: 34,
        },
        {
          name: 'Client.getForecast',
          kind: 'method',
          change: 'modified',
          file: 'src/client.ts',
          startLine: 4,
          endLine: 13,
        },
      ],
    });
    const [window] = planWindows(ctxOf(fx), 1);
    expect(window?.anchor?.name).toBe('Client.getForecast');
    expect(window?.inView.map((v) => v.name)).toEqual(['Client.getForecast']);
  });
});

describe('planWindows: the range', () => {
  it('packs symbols that lie close together and keeps their order', () => {
    const head = [
      'export const LIMIT = 3;', // 1
      '', // 2
      'export function first(): void {', // 3
      '  work();',
      '}', // 5
      '',
      'export function second(): void {', // 7
      '  work();',
      '}', // 9
    ];
    const fx = buildFixture({
      source: 'local',
      pr: null,
      files: [{ path: 'src/a.ts', head, component: 'app' }],
      components: APP,
      symbols: [
        { name: 'LIMIT', kind: 'constant', change: 'added', file: 'src/a.ts', startLine: 1, endLine: 1 },
        { name: 'first', kind: 'function', change: 'added', file: 'src/a.ts', startLine: 3, endLine: 5 },
        { name: 'second', kind: 'function', change: 'added', file: 'src/a.ts', startLine: 7, endLine: 9 },
      ],
    });
    const [window] = planWindows(ctxOf(fx), 1);
    expect([window?.from, window?.to]).toEqual([1, 9]);
    expect(window?.inView.map((v) => v.name)).toEqual(['LIMIT', 'first', 'second']);
  });

  it('shows at most three symbols and never more than 18 lines', () => {
    const head = filler(40, 'x');
    const fx = buildFixture({
      source: 'local',
      pr: null,
      files: [{ path: 'src/a.ts', head, component: 'app' }],
      components: APP,
      symbols: Array.from({ length: 6 }, (_, i) => ({
        name: `fn${i}`,
        kind: 'function' as const,
        change: 'added' as const,
        file: 'src/a.ts',
        startLine: 1 + i * 3,
        endLine: 3 + i * 3,
      })),
    });
    for (const window of planWindows(ctxOf(fx), 3)) {
      expect(window.inView.length).toBeLessThanOrEqual(3);
      expect(window.to - window.from + 1).toBeLessThanOrEqual(MAX);
    }
  });

  it('does not pack symbols that are far apart', () => {
    const [window] = planWindows(ctxOf(serviceFixture()), 1);
    expect(window?.inView.map((v) => v.name)).toEqual(['serve']);
  });

  it('shows the comment lines directly above a function with it', () => {
    const head = [
      'import { x } from "./x";',
      '',
      '/** Waits, then asks again. */',
      '// Keep this short.',
      'export function retry(): void {',
      '  again();',
      '}',
    ];
    const fx = buildFixture({
      source: 'local',
      pr: null,
      files: [{ path: 'src/a.ts', head, component: 'app' }],
      components: APP,
      symbols: [
        { name: 'retry', kind: 'function', change: 'added', file: 'src/a.ts', startLine: 5, endLine: 7 },
      ],
    });
    const [window] = planWindows(ctxOf(fx), 1);
    expect([window?.from, window?.to]).toEqual([3, 7]);
  });

  it('cuts a function that is too long around the lines that changed', () => {
    const base = ['export function big(): void {', ...filler(58, 'v'), '}'];
    const head = base.map((line, i) => (i >= 39 && i <= 41 ? `const w${i} = 'new';` : line));
    const fx = buildFixture({
      source: 'local',
      pr: null,
      files: [{ path: 'src/big.ts', base, head, component: 'app' }],
      components: APP,
      symbols: [
        { name: 'big', kind: 'function', change: 'modified', file: 'src/big.ts', startLine: 1, endLine: 60 },
      ],
    });
    const [window] = planWindows(ctxOf(fx), 1);
    expect(window?.anchor?.name).toBe('big');
    expect(window!.to - window!.from + 1).toBe(MAX);
    expect(window!.from).toBeLessThanOrEqual(40);
    expect(window!.to).toBeGreaterThanOrEqual(42);
    // The signature is not on screen, so the focus has to point at the lines that changed.
    expect(window!.from).toBeGreaterThan(1);
  });

  it('keeps the signature of a long function on screen when the change starts near the top', () => {
    const base = ['export function big(): void {', ...filler(58, 'v'), '}'];
    const head = base.map((line, i) => (i === 2 ? "const w = 'new';" : line));
    const fx = buildFixture({
      source: 'local',
      pr: null,
      files: [{ path: 'src/big.ts', base, head, component: 'app' }],
      components: APP,
      symbols: [
        { name: 'big', kind: 'function', change: 'modified', file: 'src/big.ts', startLine: 1, endLine: 60 },
      ],
    });
    const [window] = planWindows(ctxOf(fx), 1);
    expect(window?.from).toBe(1);
    expect(window?.to).toBe(MAX);
  });
});

describe('planWindows: the choice of windows', () => {
  it('gives a second window to a hunk with a symbol that the first one leaves out', () => {
    const windows = planWindows(ctxOf(serviceFixture()), 3);
    // One hunk gives two windows at most. The more important one comes first.
    expect(windows.map((w) => w.anchor?.name)).toEqual(['serve', 'helper']);
    expect(windows.map((w) => w.secondary)).toEqual([false, true]);
    expect(windows[1]!.score).toBeLessThan(windows[0]!.score);
    expect(windows[1]!.to).toBeLessThan(windows[0]!.from);
  });

  it('never describes a symbol in two windows', () => {
    const windows = planWindows(ctxOf(serviceFixture()), 4);
    const ids = windows.flatMap((w) => w.inView.map((v) => v.symbol.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every file one window before it gives one file two', () => {
    const fx = buildFixture({
      source: 'local',
      pr: null,
      files: [
        {
          path: 'src/big.ts',
          head: [
            ...filler(3, 'a'),
            'export function one() {',
            '  a();',
            '}',
            ...filler(10, 'b'),
            'export function two() {',
            '  b();',
            '}',
          ],
          component: 'app',
          importance: 0.9,
        },
        {
          path: 'src/small.ts',
          head: ['export function three() {', '  c();', '}'],
          component: 'app',
          importance: 0.3,
        },
      ],
      components: APP,
      symbols: [
        { name: 'one', kind: 'function', change: 'added', file: 'src/big.ts', startLine: 4, endLine: 6 },
        { name: 'two', kind: 'function', change: 'added', file: 'src/big.ts', startLine: 17, endLine: 19 },
        { name: 'three', kind: 'function', change: 'added', file: 'src/small.ts', startLine: 1, endLine: 3 },
      ],
    });
    const windows = planWindows(ctxOf(fx), 2);
    expect(windows.map((w) => w.file.path).sort()).toEqual(['src/big.ts', 'src/small.ts']);
  });

  it('keeps the windows of one file together, the best file first', () => {
    const fx = buildFixture({
      source: 'local',
      pr: null,
      files: [
        {
          path: 'src/a.ts',
          head: [
            'export function a1() {',
            '  x();',
            '}',
            ...filler(10, 'a'),
            'export function a2() {',
            '  y();',
            '}',
          ],
          component: 'app',
          importance: 0.5,
        },
        {
          path: 'src/b.ts',
          head: ['export function b1() {', '  z();', '}'],
          component: 'app',
          importance: 0.9,
        },
      ],
      components: APP,
      symbols: [
        { name: 'a1', kind: 'function', change: 'added', file: 'src/a.ts', startLine: 1, endLine: 3 },
        { name: 'a2', kind: 'function', change: 'added', file: 'src/a.ts', startLine: 14, endLine: 16 },
        { name: 'b1', kind: 'function', change: 'added', file: 'src/b.ts', startLine: 1, endLine: 3 },
      ],
    });
    expect(planWindows(ctxOf(fx), 3).map((w) => [w.file.path, w.anchor?.name])).toEqual([
      ['src/b.ts', 'b1'],
      ['src/a.ts', 'a1'],
      ['src/a.ts', 'a2'],
    ]);
  });

  it('shows source files and leaves out tests, docs and small hunks that no symbol explains', () => {
    const fx = retryFixture();
    const paths = planWindows(ctxOf(fx), 5).map((w) => w.file.path);
    expect(paths).not.toContain('src/http/retry.test.ts');
    expect(paths).not.toContain('docs/retry.md');
    expect(paths).not.toContain('package-lock.json');
    expect(paths).not.toContain('.env');
    // client.ts has an import hunk with one added line: only the hunk with the method is shown.
    expect(planWindows(ctxOf(fx), 5).filter((w) => w.file.path === 'src/http/client.ts')).toHaveLength(1);
  });

  it('falls back to tests when the change has no other code, and to small hunks when there is nothing else', () => {
    const testsOnly = buildFixture({
      source: 'local',
      pr: null,
      files: [
        {
          path: 'src/a.test.ts',
          head: ["it('works', () => {", '  run();', '});'],
          component: 'app',
          role: 'test',
        },
      ],
      components: APP,
    });
    expect(planWindows(ctxOf(testsOnly), 2).map((w) => w.file.path)).toEqual(['src/a.test.ts']);

    const small = tinyFixture({ symbols: [] });
    const [window] = planWindows(ctxOf(small), 1);
    expect(window?.anchor).toBeNull();
    expect(window?.file.path).toBe('src/greet.ts');
  });

  it('plans nothing for no windows, no files or files nobody may see', () => {
    expect(planWindows(ctxOf(tinyFixture()), 0)).toEqual([]);
    const empty = buildFixture({ source: 'local', pr: null, files: [], components: [] });
    expect(planWindows(ctxOf(empty), 3)).toEqual([]);
    const hidden = retryFixture({ config: { privacy: { excludePaths: ['src/'] } } });
    expect(planWindows(ctxOf(hidden), 3).every((w) => !w.file.path.startsWith('src/'))).toBe(true);
  });

  it('reads the base side of a deleted file', () => {
    const fx = buildFixture({
      source: 'local',
      pr: null,
      files: [
        { path: 'src/old.ts', base: ['export function gone(): void {', '  x();', '}'], component: 'app' },
      ],
      components: APP,
      symbols: [
        { name: 'gone', kind: 'function', change: 'removed', file: 'src/old.ts', startLine: 1, endLine: 3 },
      ],
    });
    const [window] = planWindows(ctxOf(fx), 1);
    expect(window?.side).toBe('base');
    expect(window?.mode).toBe('snippet');
    expect(window?.anchor?.name).toBe('gone');
  });
});

describe('planWindows: snippet or diff', () => {
  it('uses a snippet for a new file and a diff for a small edit', () => {
    const created = planWindows(ctxOf(serviceFixture()), 1)[0];
    expect(created?.mode).toBe('snippet');
    const edited = planWindows(ctxOf(tinyFixture()), 1)[0];
    expect(edited?.mode).toBe('diff');
  });

  it('uses a snippet when the removed lines would not fit on screen next to the new ones', () => {
    const base = ['export function swap(): void {', ...filler(14, 'old'), '}'];
    const head = ['export function swap(): void {', ...filler(14, 'new'), '}'];
    const fx = buildFixture({
      source: 'local',
      pr: null,
      files: [{ path: 'src/a.ts', base, head, component: 'app' }],
      components: APP,
      symbols: [
        { name: 'swap', kind: 'function', change: 'modified', file: 'src/a.ts', startLine: 1, endLine: 16 },
      ],
    });
    const file = fx.changeSet.files[0]!;
    expect(diffViewSpan(file, 'head', 1, 16)?.length).toBeGreaterThan(MAX);
    expect(planWindows(ctxOf(fx), 1)[0]?.mode).toBe('snippet');
  });
});

describe('beforeAfterOf', () => {
  it('maps the head lines of a modified function to the same function at base', () => {
    const fx = tinyFixture();
    const ctx = ctxOf(fx);
    const file = fx.changeSet.files[0]!;
    const view = symbolViews(ctx, file, 'head')[0]!;
    expect(beforeAfterOf(file, view)).toMatchObject({ base: [1, 3], head: [1, 3] });
  });

  it('follows lines that moved because something was added above them', () => {
    const fx = retryFixture();
    const ctx = ctxOf(fx);
    const file = fx.changeSet.files.find((f) => f.path === 'src/http/client.ts')!;
    const view = symbolViews(ctx, file, 'head').find((v) => v.name === 'get')!;
    // One import line was added above the method.
    expect(beforeAfterOf(file, view)).toMatchObject({ base: [10, 13], head: [11, 14] });
  });

  it('gives nothing for a function that is new, removed, too long or not a function', () => {
    const fx = retryFixture();
    const ctx = ctxOf(fx);
    const created = fx.changeSet.files.find((f) => f.path === 'src/http/retry.ts')!;
    const addedView = symbolViews(ctx, created, 'head').find((v) => v.name === 'delayFor')!;
    expect(beforeAfterOf(created, addedView)).toBeNull();

    const base = ['export function big(): void {', ...filler(28, 'v'), '}'];
    const head = base.map((line, i) => (i === 10 ? "const w = 'new';" : line));
    const long = buildFixture({
      source: 'local',
      pr: null,
      files: [{ path: 'src/big.ts', base, head, component: 'app' }],
      components: APP,
      symbols: [
        { name: 'big', kind: 'function', change: 'modified', file: 'src/big.ts', startLine: 1, endLine: 30 },
      ],
    });
    const longCtx = ctxOf(long);
    const longFile = long.changeSet.files[0]!;
    expect(beforeAfterOf(longFile, symbolViews(longCtx, longFile, 'head')[0]!)).toBeNull();

    const constant = buildFixture({
      source: 'local',
      pr: null,
      files: [
        { path: 'src/a.ts', base: ['export const A = 1;'], head: ['export const A = 2;'], component: 'app' },
      ],
      components: APP,
      symbols: [
        { name: 'A', kind: 'constant', change: 'modified', file: 'src/a.ts', startLine: 1, endLine: 1 },
      ],
    });
    const constantCtx = ctxOf(constant);
    const constantFile = constant.changeSet.files[0]!;
    expect(beforeAfterOf(constantFile, symbolViews(constantCtx, constantFile, 'head')[0]!)).toBeNull();
  });

  it('gives nothing when the first line of the function changed, because the two sides may not match', () => {
    const fx = buildFixture({
      source: 'local',
      pr: null,
      files: [
        {
          path: 'src/a.ts',
          base: ['export function run(a: number): void {', '  go(a);', '}'],
          head: ['export function run(a: number, b: number): void {', '  go(a);', '}'],
          component: 'app',
        },
      ],
      components: APP,
      symbols: [
        { name: 'run', kind: 'function', change: 'modified', file: 'src/a.ts', startLine: 1, endLine: 3 },
      ],
    });
    const ctx = ctxOf(fx);
    const file = fx.changeSet.files[0]!;
    expect(beforeAfterOf(file, symbolViews(ctx, file, 'head')[0]!)).toBeNull();
  });
});

describe('reading the lines of a window', () => {
  it('finds where a declaration ends', () => {
    const fx = buildFixture({
      source: 'local',
      pr: null,
      files: [
        {
          path: 'src/a.ts',
          head: [
            'export async function withRetry<T>(',
            '  operation: () => Promise<T>,',
            '  options: Options = DEFAULTS,',
            '): Promise<T> {',
            '  return operation();',
            '}',
            'export const LIMIT = { a: 1 };',
            'def_py = 1',
          ],
          component: 'app',
        },
      ],
      components: APP,
    });
    const lines = sideLines(fx.changeSet.files[0]!, 'head');
    const symbol = (startLine: number, endLine: number) => ({
      id: 'S1',
      name: 'x',
      kind: 'function' as const,
      change: 'added' as const,
      fileId: 'F1',
      path: 'src/a.ts',
      side: 'head' as const,
      startLine,
      endLine,
      exported: true,
    });
    expect(declarationEnd(lines, symbol(1, 6))).toBe(4);
    expect(declarationEnd(lines, symbol(7, 7))).toBe(7);
    // Lines the diff does not carry cannot be read, so the declaration is one line.
    expect(declarationEnd(lines, symbol(40, 50))).toBe(40);
  });

  it('removes strings and comments before looking for names', () => {
    expect(codeOnly("const a = 'helper(1)'; // helper(2)")).toBe('const a = ""; ');
    expect(codeOnly('  // helper(3)')).toBe('');
    expect(codeOnly(' * helper(4)')).toBe('');
    expect(codeOnly('x = call(1)  # call(2) here')).toBe('x = call(1) ');
    expect(codeOnly('const t = `a ${b} helper(5)`;')).toBe('const t = "";');
    // A minified line is not searched at all.
    expect(codeOnly(`x(${'a'.repeat(3000)})`)).toBe('');
  });

  it('lists the plain function calls of some lines, not method calls or keywords', () => {
    const fx = buildFixture({
      source: 'local',
      pr: null,
      files: [
        {
          path: 'src/a.ts',
          head: ['if (ready(x)) {', '  logger.debug(shout("a"));', '  return await load(a, retry(b));', '}'],
          component: 'app',
        },
      ],
      components: APP,
    });
    const lines = sideLines(fx.changeSet.files[0]!, 'head');
    expect(callNames(lines, { from: 1, to: 4 }, ['add'])).toEqual(['ready', 'shout', 'load', 'retry']);
    expect(callNames(lines, { from: 1, to: 1 }, ['add'])).toEqual(['ready']);
    expect(callNames(lines, { from: 1, to: 4 }, ['del'])).toEqual([]);
  });

  it('merges changed lines into runs, across a single line that did not change', () => {
    expect(changedRuns([2, 3, 4, 6, 10, 11], 1, 20)).toEqual([
      [2, 6],
      [10, 11],
    ]);
    expect(changedRuns([2, 3, 4, 6, 10, 11], 3, 10)).toEqual([
      [3, 6],
      [10, 10],
    ]);
    expect(changedRuns([2, 5], 1, 20)).toEqual([
      [2, 2],
      [5, 5],
    ]);
    expect(changedRuns([], 1, 5)).toEqual([]);
  });

  it('says a bare lowercase name with its kind', () => {
    expect(proseName('method', 'get')).toBe('the method get');
    expect(proseName('function', 'withRetry')).toBe('withRetry');
    expect(proseName('constant', 'MAX_RETRIES')).toBe('MAX_RETRIES');
    expect(proseName('class', 'Cart.total')).toBe('Cart.total');
  });
});

describe('findReferences', () => {
  function fixture(): Fixture {
    const head = [
      'export const LIMIT = 5;', // 1
      'export function helper(a: number): number {', // 2
      '  return a + LIMIT;',
      '}', // 4
      'export class Widget {}', // 5
      'export function main(a: number): Widget {', // 6
      '  // helper(1) is mentioned only in this comment',
      "  const text = 'LIMIT';",
      '  const total = helper(a) + other.helper(a);',
      '  if (total > LIMIT) {',
      '    return new Widget();',
      '  }',
      '  return build(total);',
      '}', // 14
    ];
    return buildFixture({
      source: 'local',
      pr: null,
      files: [{ path: 'src/a.ts', head, component: 'app' }],
      components: APP,
      symbols: [
        { name: 'LIMIT', kind: 'constant', change: 'added', file: 'src/a.ts', startLine: 1, endLine: 1 },
        { name: 'helper', kind: 'function', change: 'added', file: 'src/a.ts', startLine: 2, endLine: 4 },
        { name: 'Widget', kind: 'class', change: 'added', file: 'src/a.ts', startLine: 5, endLine: 5 },
        { name: 'main', kind: 'function', change: 'added', file: 'src/a.ts', startLine: 6, endLine: 14 },
        { name: 'ab', kind: 'function', change: 'added', file: 'src/a.ts', startLine: 20, endLine: 22 },
      ],
    });
  }

  it('finds the changed symbols that the added lines call, create or use, with the first line of each', () => {
    const fx = fixture();
    const ctx = ctxOf(fx);
    const file = fx.changeSet.files[0]!;
    const main = symbolViews(ctx, file, 'head').find((v) => v.name === 'main')!;
    const found = findReferences(ctx, file, main, { from: 1, to: 14 });
    expect(found.map((r) => [r.name, r.kind, r.line])).toEqual([
      ['helper', 'calls', 9],
      ['Widget', 'creates', 11],
      ['LIMIT', 'uses', 10],
    ]);
  });

  it('counts only the lines on screen', () => {
    const fx = fixture();
    const ctx = ctxOf(fx);
    const file = fx.changeSet.files[0]!;
    const main = symbolViews(ctx, file, 'head').find((v) => v.name === 'main')!;
    const found = findReferences(ctx, file, main, { from: 6, to: 9 });
    // The signature mentions Widget as a type, and line 9 calls helper. Line 11, which creates a Widget, is off screen.
    expect(found.map((r) => [r.name, r.kind, r.line])).toEqual([
      ['helper', 'calls', 9],
      ['Widget', 'uses', 6],
    ]);
  });

  it('keeps to the number it is asked for, and ignores names that are too short or mentioned only in comments', () => {
    const fx = fixture();
    const ctx = ctxOf(fx);
    const file = fx.changeSet.files[0]!;
    const main = symbolViews(ctx, file, 'head').find((v) => v.name === 'main')!;
    expect(findReferences(ctx, file, main, { from: 1, to: 14 }, 1)).toHaveLength(1);
    expect(findReferences(ctx, file, main, { from: 1, to: 14 }).map((r) => r.name)).not.toContain('ab');
  });

  it('does not look for references in the old version of a removed symbol', () => {
    const fx = buildFixture({
      source: 'local',
      pr: null,
      files: [
        {
          path: 'src/old.ts',
          base: ['export function gone(): void {', '  helper();', '}'],
          component: 'app',
        },
      ],
      components: APP,
      symbols: [
        { name: 'gone', kind: 'function', change: 'removed', file: 'src/old.ts', startLine: 1, endLine: 3 },
        {
          name: 'helper',
          kind: 'function',
          change: 'removed',
          file: 'src/old.ts',
          startLine: 9,
          endLine: 10,
        },
      ],
    });
    const ctx = ctxOf(fx);
    const file = fx.changeSet.files[0]!;
    const gone = symbolViews(ctx, file, 'base').find((v) => v.name === 'gone')!;
    expect(findReferences(ctx, file, gone, { from: 1, to: 3 })).toEqual([]);
  });
});

describe('symbolViews', () => {
  it('counts the lines of each symbol that the change touches', () => {
    const fx = retryFixture();
    const ctx = ctxOf(fx);
    const file = fx.changeSet.files.find((f) => f.path === 'src/http/retry.ts')!;
    const views = symbolViews(ctx, file, 'head');
    expect(views.find((v) => v.name === 'delayFor')?.changed).toBe(3);
    expect(views.find((v) => v.name === 'MAX_RETRIES')?.changed).toBe(1);
  });

  it('leaves out symbols whose name may not be said', () => {
    const fx = retryFixture({ config: { privacy: { excludePaths: ['src/http/retry*'] } } });
    const ctx = ctxOf(fx);
    const file = fx.changeSet.files.find((f) => f.path === 'src/http/retry.ts')!;
    expect(symbolViews(ctx, file, 'head')).toEqual([]);
  });
});
