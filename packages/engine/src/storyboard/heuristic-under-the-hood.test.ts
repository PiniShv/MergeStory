import { describe, expect, it } from 'vitest';
import { STORYBOARD_LIMITS } from '../core/storyboard-schema.ts';
import { expectCleanStoryboard, symbolsOffScreen } from '../testing/analysed.ts';
import { APP, byRole, codeScenes, filler, lines, make } from '../testing/heuristic.ts';
import {
  buildFixture,
  type Fixture,
  inventoryFixture,
  retryFixture,
  tinyFixture,
} from '../testing/storyboard-fixtures.ts';

describe('under the hood scenes', () => {
  it('shows the code around the most important symbol, with a focus on it', () => {
    const fx = retryFixture();
    const scenes = codeScenes(make(fx, 300));
    expect(scenes.length).toBeGreaterThanOrEqual(1);
    expect(scenes.length).toBeLessThanOrEqual(3);
    const first = scenes[0]!;
    expect(first.scene.role).toBe('under-the-hood');
    expect(first.scene.title).toBe('fetchWithBackoff in retry.ts');
    // A new file is shown as plain code.
    expect(first.visual.mode).toBe('snippet');
    expect(first.visual.ref).toMatchObject({ path: 'src/http/retry.ts', side: 'head' });
    expect(first.visual.ref.endLine - first.visual.ref.startLine + 1).toBeLessThanOrEqual(
      STORYBOARD_LIMITS.maxCodeLines,
    );
    expect(first.visual.focus.length).toBeGreaterThan(0);
    for (const range of first.visual.focus) {
      expect(range.startLine).toBeGreaterThanOrEqual(first.visual.ref.startLine);
      expect(range.endLine).toBeLessThanOrEqual(first.visual.ref.endLine);
    }
  });

  it('keeps the function in view', () => {
    const fx = retryFixture();
    const code = codeScenes(make(fx)).find((s) => s.scene.role === 'under-the-hood')!.visual;
    expect(code.ref.startLine <= 18 && code.ref.endLine >= 29).toBe(true);
  });

  it('describes the symbols on screen from symbol data, and cites the hunk and the symbols', () => {
    const fx = retryFixture();
    const scene = codeScenes(make(fx, 300))[0]!.scene;
    expect(lines(scene).slice(0, 2)).toEqual([
      'In retry.ts, the function fetchWithBackoff is new and exported.',
      'The function delayFor is new too.',
    ]);
    expect(scene.narration[0]!.evidence).toEqual([
      fx.id.hunk('src/http/retry.ts'),
      fx.id.symbol('fetchWithBackoff'),
    ]);
    expect(scene.narration[1]!.evidence).toEqual([fx.id.hunk('src/http/retry.ts'), fx.id.symbol('delayFor')]);
  });

  it('never describes a symbol whose lines are not on screen', () => {
    // The window around fetchWithBackoff does not reach MAX_RETRIES (line 4) or BASE_DELAY_MS (line 5).
    const fx = retryFixture();
    const storyboard = make(fx, 300);
    const first = codeScenes(storyboard)[0]!;
    expect(first.visual.ref.startLine).toBeGreaterThan(5);
    expect(lines(first.scene).join(' ')).not.toMatch(/the constant MAX_RETRIES (is|was)/);
    expect(symbolsOffScreen(storyboard, fx.analysis)).toEqual([]);
  });

  it('names focus notes after the symbol that changed', () => {
    const fx = retryFixture();
    const scene = codeScenes(make(fx, 300))[0]!;
    const notes = scene.visual.focus.map((f) => f.note);
    expect(notes).toContain('New function fetchWithBackoff');
    expect(notes).toContain('New function delayFor');
  });

  it('points each focus note at the line of the narration that explains it', () => {
    const fx = retryFixture();
    const { scene, visual } = codeScenes(make(fx, 300))[0]!;
    const beatOf = (note: string) => visual.focus.find((f) => f.note === note)?.beat;
    expect(beatOf('New function fetchWithBackoff')).toBe(0);
    expect(lines(scene)[beatOf('New function delayFor')!]).toBe('The function delayFor is new too.');
    expect(beatOf('Calls delayFor')).toBe(2);
    expect(lines(scene)[2]).toBe('fetchWithBackoff calls delayFor. It also uses MAX_RETRIES.');
    for (const f of visual.focus) expect(f.beat).toBeLessThan(scene.narration.length);
  });

  it('says what the code on screen calls and uses, among the other changed symbols', () => {
    const fx = retryFixture();
    const { scene, visual } = codeScenes(make(fx, 300))[0]!;
    expect(lines(scene)[2]).toBe('fetchWithBackoff calls delayFor. It also uses MAX_RETRIES.');
    expect(scene.narration[2]!.evidence).toEqual(['F1.H1', 'S1', 'S2', 'S3']);
    // Line 27 calls delayFor and line 23 reads MAX_RETRIES.
    expect(visual.focus).toContainEqual({ startLine: 27, endLine: 27, note: 'Calls delayFor', beat: 2 });
    expect(visual.focus).toContainEqual({ startLine: 23, endLine: 23, note: 'Uses MAX_RETRIES', beat: 2 });
  });

  describe('the line about what the code calls and uses', () => {
    /** A function and an interface next to each other, and a constant that the function uses from another file. */
    function configFixture(functionName: string): Fixture {
      return buildFixture({
        source: 'local',
        pr: null,
        files: [
          {
            path: 'src/retry.ts',
            head: ['export const DEFAULT_RETRY = { retries: 3, baseDelayMs: 250 };'],
            component: 'app',
          },
          {
            path: 'src/config.ts',
            base: [
              "import { RetryOptions } from './retry.ts';",
              '',
              'export interface WeatherConfig {',
              '  retry: RetryOptions;',
              '}',
              '',
              `export function ${functionName}(): WeatherConfig {`,
              '  return { retry: {} };',
              '}',
            ],
            head: [
              "import { DEFAULT_RETRY } from './retry.ts';",
              '',
              'export interface WeatherConfig {',
              '  retry: typeof DEFAULT_RETRY;',
              '  timeoutMs: number;',
              '}',
              '',
              `export function ${functionName}(): WeatherConfig {`,
              '  return { retry: DEFAULT_RETRY, timeoutMs: 5000 };',
              '}',
            ],
            component: 'app',
          },
        ],
        components: APP,
        symbols: [
          {
            name: 'DEFAULT_RETRY',
            kind: 'constant',
            change: 'added',
            file: 'src/retry.ts',
            startLine: 1,
            endLine: 1,
          },
          {
            name: 'WeatherConfig',
            kind: 'interface',
            change: 'modified',
            file: 'src/config.ts',
            startLine: 3,
            endLine: 6,
          },
          {
            name: functionName,
            kind: 'function',
            change: 'modified',
            file: 'src/config.ts',
            startLine: 8,
            endLine: 10,
          },
        ],
      });
    }

    it('names the symbol it is about, because another symbol is named on the line before it', () => {
      const scene = codeScenes(make(configFixture('loadConfig'), 300))[0]!.scene;
      expect(lines(scene)).toEqual([
        'In config.ts, the function loadConfig was changed and is exported.',
        'The interface WeatherConfig was changed too.',
        'loadConfig uses DEFAULT_RETRY.',
      ]);
    });

    it('says "the function" for a bare lowercase name, and keeps the case of other names', () => {
      const scene = codeScenes(make(configFixture('load'), 300))[0]!.scene;
      expect(lines(scene)[2]).toBe('The function load uses DEFAULT_RETRY.');
    });
  });

  it('leaves out of the code scene what the leaner levels have no room for, and keeps the symbol line', () => {
    const fx = retryFixture();
    const lean = codeScenes(make(fx, 30))[0]!;
    expect(lean.scene.narration.length).toBeLessThan(codeScenes(make(fx, 300))[0]!.scene.narration.length);
    expect(lines(lean.scene)[0]).toBe('In retry.ts, the function fetchWithBackoff is new and exported.');
  });

  it('reads a deleted file from its base side and says it was removed', () => {
    const fx = inventoryFixture();
    const scene = make(fx, 300).scenes.find(
      (s) => s.visual.type === 'code' && s.visual.ref.path === 'app/legacy/old_export.py',
    )!;
    expect(scene.visual.type === 'code' && scene.visual.ref.side).toBe('base');
    expect(scene.visual.type === 'code' && scene.visual.mode).toBe('snippet');
    expect(scene.narration[0]!.text).toBe(
      'In old_export.py, the function export_all was removed. It was public.',
    );
    expect(scene.title).toBe('export_all in old_export.py');
  });

  it('uses line counts when a hunk has no known symbol, and skips small hunks when there is code to show', () => {
    const plain = buildFixture({
      source: 'local',
      pr: null,
      files: [
        {
          path: 'config/app.yml',
          base: ['name: app', 'retries: 1'],
          head: ['name: app', 'retries: 3', 'timeout: 30', 'region: eu', 'debug: false', 'level: info'],
          component: 'app',
          language: 'yaml',
        },
      ],
      components: APP,
    });
    const scene = codeScenes(make(plain, 60))[0]!.scene;
    expect(scene.narration[0]!.text).toBe('app.yml changes here, with 5 lines added and 1 removed.');
    expect(scene.title).toBe('Inside app.yml');

    // helpers.py has a small hunk without a symbol: the scenes for the other files come first, and it is left out.
    const inventory = make(inventoryFixture(), 300);
    expect(codeScenes(inventory).map((s) => s.visual.ref.path)).not.toContain('app/utils/helpers.py');
  });

  it('never points at hidden, binary or trivial files', () => {
    const fx = retryFixture();
    for (const s of make(fx, 300).scenes) {
      if (s.visual.type !== 'code') continue;
      expect(['.env', 'assets/logo.png', 'package-lock.json']).not.toContain(s.visual.ref.path);
    }
  });

  it('shows every file once before it shows a second part of one file', () => {
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
          importance: 0.5,
        },
        {
          path: 'src/tiny.ts',
          head: ['export function four() {', '  d();', '}'],
          component: 'app',
          importance: 0.3,
        },
      ],
      components: APP,
      symbols: [
        { name: 'one', kind: 'function', change: 'added', file: 'src/big.ts', startLine: 4, endLine: 6 },
        { name: 'two', kind: 'function', change: 'added', file: 'src/big.ts', startLine: 17, endLine: 19 },
        { name: 'three', kind: 'function', change: 'added', file: 'src/small.ts', startLine: 1, endLine: 3 },
        { name: 'four', kind: 'function', change: 'added', file: 'src/tiny.ts', startLine: 1, endLine: 3 },
      ],
    });
    const paths = codeScenes(make(fx, 300)).map((s) => s.visual.ref.path);
    expect(paths.sort()).toEqual(['src/big.ts', 'src/small.ts', 'src/tiny.ts']);
  });

  it('puts the values the analysis found into words, next to the line that holds them', () => {
    const fx = buildFixture({
      source: 'local',
      pr: null,
      files: [
        {
          path: 'src/policy.ts',
          head: [
            'export const DEFAULT_RETRY = { retries: 3, maxDelayMs: 4_000 };', // 1
            '',
            'export function isRetryable(status: number): boolean {', // 3
            '  return status >= 500;',
            '}',
          ],
          component: 'app',
        },
      ],
      components: APP,
      symbols: [
        {
          name: 'DEFAULT_RETRY',
          kind: 'constant',
          change: 'added',
          file: 'src/policy.ts',
          startLine: 1,
          endLine: 1,
        },
        {
          name: 'isRetryable',
          kind: 'function',
          change: 'added',
          file: 'src/policy.ts',
          startLine: 3,
          endLine: 5,
        },
      ],
      risks: [
        {
          severity: 'low',
          category: 'performance',
          title: 'Check the changed timeout, retry or interval values',
          detail:
            'Changes a timeout, retry or interval value at src/policy.ts:1. retries: new value 3; maxDelayMs: new value 4_000.',
          files: ['src/policy.ts'],
          ref: { path: 'src/policy.ts', side: 'head', startLine: 1, endLine: 1 },
        },
      ],
    });
    const { scene, visual } = codeScenes(make(fx, 300))[0]!;
    expect(lines(scene)).toContain('DEFAULT_RETRY sets retries to 3 and maxDelayMs to 4000.');
    const at = lines(scene).indexOf('DEFAULT_RETRY sets retries to 3 and maxDelayMs to 4000.');
    expect(visual.focus).toContainEqual({
      startLine: 1,
      endLine: 1,
      note: 'Values found by the analysis',
      beat: at,
    });
    expect(scene.narration[at]!.evidence).toEqual(['R1', 'F1.H1', 'S1']);
    // The review scene says them again for the risk.
    expect(lines(byRole(make(fx, 300), 'review')[0]!).join(' ')).toContain(
      'It sets retries to 3 and maxDelayMs to 4000.',
    );
  });

  it('names the file as the subject when no symbol on screen holds the values', () => {
    const fx = buildFixture({
      source: 'local',
      pr: null,
      files: [
        {
          path: 'src/policy.ts',
          head: [
            'export function isRetryable(status: number): boolean {', // 1
            '  return status >= 500;',
            '}',
            'export const DEFAULT_RETRY = { retries: 3, maxDelayMs: 4_000 };', // 4
            'export function isFatal(status: number): boolean {', // 5
            '  return status === 401;',
            '}',
          ],
          component: 'app',
        },
      ],
      components: APP,
      symbols: [
        {
          name: 'isRetryable',
          kind: 'function',
          change: 'added',
          file: 'src/policy.ts',
          startLine: 1,
          endLine: 3,
        },
        {
          name: 'isFatal',
          kind: 'function',
          change: 'added',
          file: 'src/policy.ts',
          startLine: 5,
          endLine: 7,
        },
      ],
      risks: [
        {
          severity: 'low',
          category: 'performance',
          title: 'Check the changed timeout, retry or interval values',
          detail:
            'Changes a timeout, retry or interval value at src/policy.ts:1. retries: new value 3; maxDelayMs: new value 4_000.',
          files: ['src/policy.ts'],
          ref: { path: 'src/policy.ts', side: 'head', startLine: 4, endLine: 4 },
        },
      ],
    });
    const { scene } = codeScenes(make(fx, 300))[0]!;
    expect(lines(scene)).toContain('policy.ts sets retries to 3 and maxDelayMs to 4000.');
    expect(lines(scene).join(' ')).not.toContain('It sets');
  });

  it('cuts a function that is too long around its changed lines, and says only that it changed', () => {
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
    const { scene, visual } = codeScenes(make(fx, 150))[0]!;
    expect(visual.ref.endLine - visual.ref.startLine + 1).toBe(STORYBOARD_LIMITS.maxCodeLines);
    expect(scene.narration[0]!.text).toBe('In big.ts, the function big was changed and is exported.');
    // The signature is off screen, so the highlight points at the lines that changed.
    expect(visual.focus[0]).toMatchObject({ startLine: 40, endLine: 42, note: 'Changed function big' });
    expect(visual.mode).toBe('diff');
  });

  it('shows a snippet when the removed lines would push the new lines off screen', () => {
    const base = ['export class Swap {', ...filler(14, 'old'), '}'];
    const head = ['export class Swap {', ...filler(14, 'new'), '}'];
    const fx = buildFixture({
      source: 'local',
      pr: null,
      files: [{ path: 'src/a.ts', base, head, component: 'app' }],
      components: APP,
      symbols: [
        { name: 'Swap', kind: 'class', change: 'modified', file: 'src/a.ts', startLine: 1, endLine: 16 },
      ],
    });
    expect(codeScenes(make(fx, 150))[0]!.visual.mode).toBe('snippet');
  });
});

describe('before and after scene', () => {
  it('shows the old and the new lines of one small modified function side by side', () => {
    const fx = tinyFixture();
    const scene = byRole(make(fx, 60), 'before-after')[0]!;
    expect(scene.title).toBe('greet before and after');
    expect(scene.visual.type).toBe('before-after');
    if (scene.visual.type !== 'before-after') return;
    expect(scene.visual.before).toMatchObject({
      label: 'Before',
      kind: 'code',
      codeRef: { path: 'src/greet.ts', side: 'base', startLine: 1, endLine: 3 },
    });
    expect(scene.visual.after).toMatchObject({
      label: 'After',
      kind: 'code',
      codeRef: { path: 'src/greet.ts', side: 'head', startLine: 1, endLine: 3 },
    });
    expect(lines(scene)).toEqual([
      'Before, the function greet was 3 lines long.',
      'Now it is 3 lines long, with 1 line added and 1 removed in it.',
    ]);
    expect(scene.narration[0]!.evidence).toEqual(['F1.H1', 'S1']);
  });

  it('says what the old and the new version call, when the changed lines show it', () => {
    const fx = retryFixture();
    const scene = byRole(make(fx, 300), 'before-after')[0]!;
    expect(scene.title).toBe('get before and after');
    expect(lines(scene)).toEqual([
      'Before, the method get called fetch.',
      'Now it calls fetchWithBackoff instead.',
      'It is still 4 lines long.',
    ]);
    // The new call is a symbol of this change, so the line cites it.
    expect(scene.narration[1]!.evidence).toEqual([
      fx.id.hunk('src/http/client.ts', 2),
      fx.id.symbol('get'),
      fx.id.symbol('fetchWithBackoff'),
    ]);
    if (scene.visual.type !== 'before-after') return;
    // One import line was added above the method, so the new lines start one line further down.
    expect(scene.visual.before.codeRef).toMatchObject({ side: 'base', startLine: 10, endLine: 13 });
    expect(scene.visual.after.codeRef).toMatchObject({ side: 'head', startLine: 11, endLine: 14 });
  });

  it('replaces the code scene of that function, so it is not shown twice', () => {
    const storyboard = make(retryFixture(), 300);
    expect(byRole(storyboard, 'before-after')).toHaveLength(1);
    const clientCode = codeScenes(storyboard).filter((s) => s.visual.ref.path === 'src/http/client.ts');
    expect(clientCode).toHaveLength(0);
  });

  it('is left out when other symbols share the window with the function', () => {
    // total_with_bonus is new and format_report changed: one window holds both, so there is no side-by-side view.
    expect(byRole(make(inventoryFixture(), 300), 'before-after')).toHaveLength(0);
  });

  it('is left out when the function is too long to show on both sides', () => {
    const base = ['export function big(): void {', ...filler(28, 'v'), '}'];
    const head = base.map((line, i) => (i === 10 ? "const w = 'new';" : line));
    const fx = buildFixture({
      source: 'local',
      pr: null,
      files: [{ path: 'src/big.ts', base, head, component: 'app' }],
      components: APP,
      symbols: [
        { name: 'big', kind: 'function', change: 'modified', file: 'src/big.ts', startLine: 1, endLine: 30 },
      ],
    });
    const storyboard = make(fx, 300);
    expect(byRole(storyboard, 'before-after')).toHaveLength(0);
    expect(codeScenes(storyboard)).toHaveLength(1);
  });

  it('stays at the leanest level, because it is shorter than the code scene it replaces', () => {
    const lean = make(tinyFixture(), 1);
    expect(byRole(lean, 'before-after')).toHaveLength(1);
    expect(lines(byRole(lean, 'before-after')[0]!)).toHaveLength(2);
  });

  it('shows at most one', () => {
    const fx = buildFixture({
      source: 'local',
      pr: null,
      files: [
        {
          path: 'src/a.ts',
          base: ['export function a() {', '  one();', '}'],
          head: ['export function a() {', '  two();', '}'],
          component: 'app',
        },
        {
          path: 'src/b.ts',
          base: ['export function b() {', '  one();', '}'],
          head: ['export function b() {', '  two();', '}'],
          component: 'app',
        },
      ],
      components: APP,
      symbols: [
        { name: 'a', kind: 'function', change: 'modified', file: 'src/a.ts', startLine: 1, endLine: 3 },
        { name: 'b', kind: 'function', change: 'modified', file: 'src/b.ts', startLine: 1, endLine: 3 },
      ],
    });
    const storyboard = make(fx, 300);
    expect(byRole(storyboard, 'before-after')).toHaveLength(1);
    expect(codeScenes(storyboard)).toHaveLength(1);
  });

  it('is valid for the validator, with its code on both sides', async () => {
    const fx = tinyFixture();
    expect(await expectCleanStoryboard(fx.deps, make(fx, 60))).toEqual([]);
  });
});
