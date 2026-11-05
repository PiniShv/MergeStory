import { describe, expect, it } from 'vitest';
import type { Storyboard } from '../core/storyboard-schema.ts';
import { STORYBOARD_LIMITS } from '../core/storyboard-schema.ts';
import { countWords } from '../core/text.ts';
import { expectCleanStoryboard } from '../testing/analysed.ts';
import { APP, byRole, codeScenes, lines, make, narration, words } from '../testing/heuristic.ts';
import {
  buildFixture,
  type Fixture,
  inventoryFixture,
  retryFixture,
  tinyFixture,
} from '../testing/storyboard-fixtures.ts';

describe('quoting the author', () => {
  const notes = [
    '- Retries live in a small reusable helper, src/retry.ts (withRetry), so other calls can use it later.',
    '- Backoff uses "full jitter": a random wait between 0 and min(maxDelayMs, baseDelayMs * 2^attempt).',
    '- All tests pass and the helper is production-ready.',
  ].join('\n');

  function noted(overrides: Record<string, unknown> = {}): Fixture {
    return buildFixture({
      source: 'local',
      pr: null,
      files: [
        {
          path: 'src/retry.ts',
          head: [
            'export function withRetry(run: () => void): void {', // 1
            '  run();',
            '}',
            '',
            'export function backoffDelay(attempt: number): number {', // 5
            '  return Math.random() * attempt;',
            '}',
          ],
          component: 'app',
        },
      ],
      components: APP,
      symbols: [
        {
          name: 'withRetry',
          kind: 'function',
          change: 'added',
          file: 'src/retry.ts',
          startLine: 1,
          endLine: 3,
        },
        {
          name: 'backoffDelay',
          kind: 'function',
          change: 'added',
          file: 'src/retry.ts',
          startLine: 5,
          endLine: 7,
        },
      ],
      inputs: { notes },
      ...overrides,
    });
  }

  it('quotes the note that names a symbol on screen, with its source', () => {
    const fx = noted();
    const { scene } = codeScenes(make(fx, 300))[0]!;
    const quote = lines(scene).find((line) => line.startsWith('The notes say:'));
    expect(quote).toBe(
      'The notes say: Retries live in a small reusable helper, src/retry.ts (withRetry), so other calls can use it later.',
    );
    const at = lines(scene).indexOf(quote!);
    expect(scene.narration[at]!.evidence).toEqual(['NOTES', 'F1.H1', 'S1']);
  });

  it('shortens a note that is mostly code, never repeats a claim, and says where the notes come from', () => {
    const storyboard = make(noted(), 300);
    const text = narration(storyboard);
    expect(text).not.toContain('production-ready');
    expect(text).not.toContain('All tests pass');
    expect(text).not.toContain('2^attempt');
    expect(storyboard.uncertainties.some((u) => u.includes('the author’s words'))).toBe(true);
  });

  it('quotes a note once only', () => {
    const storyboard = make(noted(), 300);
    const quotes = storyboard.scenes
      .flatMap((s) => lines(s))
      .filter((line) => line.startsWith('The notes say:'));
    expect(new Set(quotes).size).toBe(quotes.length);
  });

  it('does not quote anything when no note names the code on screen', () => {
    const fx = noted({ inputs: { notes: '- The weather was nice while this was written.' } });
    expect(narration(make(fx, 300))).not.toContain('The notes say');
    expect(make(fx, 300).uncertainties).toHaveLength(1);
  });

  it('quotes sentences of the description that name the code, as the description', () => {
    const fx = noted({
      pr: {
        title: 'Add retry',
        body: 'This adds a helper. The function backoffDelay picks a random wait for each attempt.',
      },
      inputs: { notes: null },
    });
    const text = narration(make(fx, 300));
    expect(text).toContain(
      'The description says: The function backoffDelay picks a random wait for each attempt.',
    );
  });

  it('is valid, and leaves quotes out at the leanest level', async () => {
    const fx = noted();
    expect(await expectCleanStoryboard(fx.deps, make(fx, 300))).toEqual([]);
    expect(narration(make(fx, 1))).not.toContain('The notes say');
  });
});

describe('review scene', () => {
  it('lists the top risks first by severity and cites the risk ids', () => {
    const fx = retryFixture();
    const storyboard = make(fx, 150);
    const scene = storyboard.scenes.find((s) => s.role === 'review')!;
    expect(scene.visual.type).toBe('checklist');
    if (scene.visual.type !== 'checklist') return;
    expect(scene.visual.items.map((i) => i.title)).toEqual([
      'Environment file changed',
      'Retries on every server error',
      'Lockfile changed',
    ]);
    expect(scene.visual.items.map((i) => i.severity)).toEqual(['high', 'medium', 'low']);
    expect(scene.visual.items[0]!.evidence[0]).toBe('R3');
    expect(scene.narration[0]!.text).toBe('The analysis found 3 review signals: 1 high, 1 medium and 1 low.');
    expect(scene.narration[1]!.text).toBe('First: Environment file changed. The analysis rates it high.');
    expect(storyboard.reviewChecklist).toHaveLength(3);
  });

  it('says where a risk is, as a symbol or a file the video may name', () => {
    const scene = make(retryFixture(), 150).scenes.find((s) => s.role === 'review')!;
    expect(scene.narration[2]!.text).toBe(
      'Second: Retries on every server error, in retry.ts. The analysis rates it medium.',
    );
    // A risk in a file nobody may see says nothing about where it is.
    expect(scene.narration[1]!.text).not.toContain(', in ');
  });

  it('names the symbols that a public API risk affects, and the values of a risk about values', () => {
    const fx = buildFixture({
      source: 'local',
      pr: null,
      files: [
        {
          path: 'src/a.ts',
          base: ['export function f(a: number) {}'],
          head: ['export function f(a: number, b: number) {}'],
          component: 'app',
        },
      ],
      components: APP,
      symbols: [
        { name: 'f', kind: 'function', change: 'modified', file: 'src/a.ts', startLine: 1, endLine: 1 },
      ],
      risks: [
        {
          severity: 'medium',
          category: 'public-api',
          title: 'Confirm callers still match the changed signatures',
          detail: 'Changes the signature of 1 exported symbol at src/a.ts:1. Affected: f.',
          files: ['src/a.ts'],
          ref: { path: 'src/a.ts', side: 'head', startLine: 1, endLine: 1 },
        },
        {
          severity: 'low',
          category: 'performance',
          title: 'Check the changed timeout, retry or interval values',
          detail: 'Changes a timeout, retry or interval value at src/a.ts:1. timeoutMs: 5000 to 30_000.',
          files: ['src/a.ts'],
          ref: { path: 'src/a.ts', side: 'head', startLine: 1, endLine: 1 },
        },
      ],
    });
    const scene = byRole(make(fx, 300), 'review')[0]!;
    expect(lines(scene)[1]).toBe(
      'First: Confirm callers still match the changed signatures. The analysis rates it medium. It affects f.',
    );
    expect(lines(scene)[2]).toBe(
      'Second: Check the changed timeout, retry or interval values, in a.ts. It changes timeoutMs from 5000 to 30000.',
    );
  });

  it('puts risks with values or names to say before other risks of the same severity', () => {
    const fx = buildFixture({
      source: 'local',
      pr: null,
      files: [{ path: 'src/a.ts', head: ['export const A = 1;'], component: 'app' }],
      components: APP,
      risks: [
        {
          severity: 'low',
          category: 'complexity',
          title: 'Check the new TODO notes',
          detail: 'Adds a TODO note at src/a.ts:1.',
          files: ['src/a.ts'],
        },
        {
          severity: 'low',
          category: 'performance',
          title: 'Check the changed timeout, retry or interval values',
          detail: 'Changes a timeout, retry or interval value at src/a.ts:1. retries: new value 3.',
          files: ['src/a.ts'],
        },
      ],
    });
    const scene = byRole(make(fx, 300), 'review')[0]!;
    expect(scene.visual.type === 'checklist' && scene.visual.items.map((i) => i.title)).toEqual([
      'Check the changed timeout, retry or interval values',
      'Check the new TODO notes',
    ]);
  });

  it('drops a code reference to a hidden file but keeps one to a changed source file', () => {
    const fx = retryFixture();
    const scene = make(fx, 150).scenes.find((s) => s.role === 'review')!;
    if (scene.visual.type !== 'checklist') throw new Error('expected a checklist');
    const byTitle = Object.fromEntries(scene.visual.items.map((i) => [i.title, i.ref]));
    expect(byTitle['Environment file changed']).toBeNull();
    expect(byTitle['Retries on every server error']).toMatchObject({
      path: 'src/http/retry.ts',
      side: 'head',
    });
  });

  it('points beats at the line that names each item', () => {
    const fx = retryFixture();
    const scene = make(fx, 150).scenes.find((s) => s.role === 'review')!;
    if (scene.visual.type !== 'checklist') throw new Error('expected a checklist');
    expect(scene.visual.items.map((i) => i.beat)).toEqual([1, 2, 3]);
  });

  it('puts what the notes ask reviewers to check first, as the notes’ words', () => {
    const fx = retryFixture({
      inputs: {
        task: 'x',
        notes:
          '- Worth a careful review: retrying a request is only safe because of the attempt limit; and the timeout applies per attempt.',
      },
    });
    const scene = byRole(make(fx, 300), 'review')[0]!;
    expect(lines(scene)[1]).toBe(
      'The notes flag this for review: retrying a request is only safe because of the attempt limit; and the timeout applies per attempt.',
    );
    expect(scene.visual.type === 'checklist' && scene.visual.items[0]).toMatchObject({
      title: 'Retrying a request is only safe because of the attempt limit',
      detail: 'The timeout applies per attempt.',
      severity: 'medium',
      ref: null,
      beat: 1,
      evidence: ['NOTES'],
    });
    // The risks follow, and the item beats still point at their own lines.
    expect(scene.visual.type === 'checklist' && scene.visual.items.map((i) => i.beat)).toEqual([1, 2, 3, 4]);
    expect(lines(make(fx, 300).scenes.at(-1)!).join(' ')).toContain(
      'Start the review with: Retrying a request is only safe because of the attempt limit.',
    );
  });

  it('uses the largest changes when the analysis has no risks', () => {
    const fx = inventoryFixture();
    const scene = make(fx).scenes.find((s) => s.role === 'review')!;
    expect(scene.narration[0]!.text).toBe(
      'The largest changes are in report.py, old_export.py and test_report.py.',
    );
    expect(scene.narration[0]!.evidence.length).toBe(3);
    if (scene.visual.type !== 'checklist') throw new Error('expected a checklist');
    expect(scene.visual.items.every((i) => i.severity === 'info')).toBe(true);
  });

  it('does not repeat the count when there is one signal', () => {
    const fx = buildFixture({
      source: 'local',
      pr: null,
      files: [{ path: 'src/a.ts', head: ['export const A = 1;'], component: 'app' }],
      components: APP,
      risks: [
        {
          severity: 'low',
          category: 'complexity',
          title: 'Check the new TODO notes',
          detail: 'Adds a TODO note at src/a.ts:1.',
          files: ['src/a.ts'],
        },
      ],
    });
    expect(lines(byRole(make(fx, 300), 'review')[0]!)[0]).toBe('The analysis found 1 review signal.');
  });
});

describe('conclusion scene', () => {
  it('sums up what was added and modified by name, and the first thing to review', () => {
    const fx = retryFixture();
    const scenes = make(fx, 150).scenes;
    const last = scenes[scenes.length - 1]!;
    expect(last.role).toBe('conclusion');
    expect(last.narration[0]!.text).toBe(
      'In short, the change adds fetchWithBackoff, delayFor and MAX_RETRIES, and modifies the method get.',
    );
    expect(last.narration[0]!.evidence).toEqual(['S1', 'S2', 'S3', 'S4']);
    expect(last.narration.map((l) => l.text).join(' ')).toContain(
      'Start the review with: Environment file changed.',
    );
    expect(last.visual.type === 'summary' && last.visual.points.map((p) => p.text)).toContain(
      'New: fetchWithBackoff, delayFor, MAX_RETRIES',
    );
  });

  it('falls back to the components when no symbol is known', () => {
    const fx = retryFixture({ symbols: [] });
    const last = make(fx, 150).scenes.at(-1)!;
    expect(last.narration[0]!.text).toBe(
      'To sum up, the change touches 7 files in http, http tests and docs.',
    );
  });

  it('reports a test result only as reported by the caller, and cites it', () => {
    const fx = retryFixture();
    const last = make(fx, 150).scenes.at(-1)!;
    const line = last.narration.find((l) => l.text.includes('reported'))!;
    expect(line.text).toBe('The coding agent reported that npm test passed.');
    expect(line.evidence).toEqual(['T1']);
    expect(last.visual.type === 'summary' && last.visual.points.map((p) => p.text)).toContain(
      'Reported run: passed (the coding agent)',
    );
  });

  it('says plainly when a reported test run did not pass', () => {
    const fx = retryFixture({
      inputs: {
        task: 'x',
        tests: [{ id: 'T1', command: 'npm test', passed: false, summary: '2 failed', source: 'ci' }],
      },
    });
    const last = make(fx, 150).scenes.at(-1)!;
    expect(last.narration.map((l) => l.text)).toContain('CI reported that npm test did not pass.');
    expect(last.visual.type === 'summary' && last.visual.points.map((p) => p.text)).toContain(
      'Reported run: did not pass (CI)',
    );
  });

  it('names the test files when nobody reported a result', () => {
    const fx = inventoryFixture();
    const last = make(fx, 150).scenes.at(-1)!;
    expect(last.narration.map((l) => l.text)).toContain('Tests were added in test_report.py.');
  });

  it('never mentions test results that nobody reported', () => {
    const fx = inventoryFixture();
    const text = narration(make(fx, 150));
    expect(text).not.toMatch(/pass|green|coverage/i);
  });

  it('describes the change in the summary by name', () => {
    expect(make(retryFixture(), 150).summary).toBe(
      'The change adds fetchWithBackoff, delayFor and MAX_RETRIES, and modifies the method get, in 7 files (+165 −82). The description says: Requests to the weather API now retry when the server answers with a 5xx status.',
    );
  });
});

describe('reported runs', () => {
  type Source = 'agent' | 'ci' | 'user';
  const run = (command: string, passed: boolean, source: Source = 'agent') => ({
    command,
    passed,
    summary: passed ? 'ok' : '1 failed',
    source,
  });
  const withRuns = (...runs: ReturnType<typeof run>[]): Fixture =>
    retryFixture({ inputs: { task: 'x', tests: runs.map((r, i) => ({ id: `T${i + 1}`, ...r })) } });
  const reportLine = (storyboard: Storyboard) =>
    storyboard.scenes.at(-1)!.narration.find((l) => l.evidence.some((id) => /^T\d+$/.test(id)))!;
  const points = (storyboard: Storyboard): string[] => {
    const visual = storyboard.scenes.at(-1)!.visual;
    return visual.type === 'summary' ? visual.points.map((p) => p.text) : [];
  };

  it('says every reported run, with the ones that did not pass first, and cites all of them', () => {
    const fx = withRuns(run('npm run lint', true), run('npm test', false), run('npm run build', true));
    const board = make(fx, 150);
    const line = reportLine(board);
    expect(line.text).toBe(
      'The coding agent reported 3 runs. Did not pass: npm test. Passed: npm run lint and npm run build.',
    );
    expect(line.evidence).toEqual(['T1', 'T2', 'T3']);
    expect(points(board)).toContain('Reported runs: 1 of 3 did not pass (the coding agent)');
  });

  it('never calls a mixed set passed, and never puts a number in front of "passed"', () => {
    const sets = [
      [run('npm run lint', true), run('npm test', false)],
      [run('npm test', true), run('npm run e2e', false)],
      [run('npm test', false), run('npm run lint', false)],
      [run('npm test', true), run('npm run lint', true), run('npm run build', true)],
    ];
    for (const set of sets) {
      const board = make(withRuns(...set), 150);
      const text = [reportLine(board).text, ...points(board)].join('\n');
      expect(text).not.toMatch(/\d\s+passed|\ball (?:the )?tests|\btests? pass/i);
      if (set.some((r) => !r.passed)) expect(text).toMatch(/did not pass|none of them passed/);
    }
  });

  it('says a single result in one short sentence', () => {
    expect(reportLine(make(withRuns(run('npm test', true)), 150)).text).toBe(
      'The coding agent reported that npm test passed.',
    );
    expect(reportLine(make(withRuns(run('pytest -q', false, 'user')), 150)).text).toBe(
      'The author reported that pytest -q did not pass.',
    );
  });

  it('says when all runs passed and when none did', () => {
    expect(reportLine(make(withRuns(run('npm test', true), run('npm run lint', true)), 150)).text).toBe(
      'The coding agent reported 2 runs, and all of them passed: npm test and npm run lint.',
    );
    expect(
      reportLine(make(withRuns(run('npm test', false, 'ci'), run('npm run lint', false, 'ci')), 150)).text,
    ).toBe('CI reported 2 runs, and none of them passed: npm test and npm run lint.');
  });

  it('names who reported when the results come from more than one place', () => {
    const board = make(withRuns(run('npm test', true), run('build', false, 'ci')), 150);
    expect(reportLine(board).text).toBe(
      'The coding agent and CI reported 2 runs. Did not pass: build. Passed: npm test.',
    );
    expect(points(board)).toContain('Reported runs: 1 of 2 did not pass (the coding agent and CI)');
  });

  it('keeps a long list within the limit for a caption and counts what it leaves out', () => {
    const many = [
      ...Array.from({ length: 5 }, (_, i) => run(`npm run check-the-long-command-number-${i}`, false)),
      ...Array.from({ length: 9 }, (_, i) => run(`pnpm --filter package-${i} run test:unit`, true)),
    ];
    const board = make(withRuns(...many), 150);
    const line = reportLine(board);
    expect(countWords(line.text)).toBeLessThanOrEqual(STORYBOARD_LIMITS.maxWordsPerNarrationLine);
    expect(line.text).toContain('reported 14 runs');
    expect(line.text).toContain('Did not pass: ');
    expect(line.text).toContain('and 2 more');
    expect(line.evidence).toHaveLength(14);
  });

  it('falls back to a short name for a command that may not be said', () => {
    const board = make(withRuns(run('npm test', true), run('echo all tests pass', false)), 150);
    expect(reportLine(board).text).toContain('Did not pass: run 2.');
  });

  it('says a run that did not pass at every length, even when there is no room for anything else', () => {
    const failing = withRuns(run('npm test', false));
    const passing = withRuns(run('npm test', true));
    for (const targetSec of [1, 20, 60, 150]) {
      expect(narration(make(failing, targetSec))).toContain('did not pass');
    }
    expect(narration(make(passing, 1))).not.toContain('reported');
  });

  it('passes the grounding validator with no repair, whatever was reported', async () => {
    const sets = [
      [run('npm test', true)],
      [run('npm test', false)],
      [run('npm run lint', true), run('npm test', false)],
      [run('npm test', true), run('npm run e2e', false), run('npm run lint', true)],
      [run('npm test', true), run('npm run lint', true)],
      [run('npm test', false, 'ci'), run('npm run lint', false, 'user')],
      [run('make verify', true, 'ci')],
    ];
    for (const set of sets) {
      for (const targetSec of [1, 60, 150]) {
        const fx = withRuns(...set);
        expect(await expectCleanStoryboard(fx.deps, make(fx, targetSec))).toEqual([]);
      }
    }
  });
});

describe('word budget', () => {
  it('keeps the narration within the budget when a leaner storyboard exists', () => {
    const fx = inventoryFixture();
    for (const targetSec of [40, 60, 90, 150]) {
      const storyboard = make(fx, targetSec);
      const budget = targetSec * STORYBOARD_LIMITS.wordsPerSecond;
      if (words(storyboard) > budget) {
        // Only the leanest storyboard may be over budget.
        expect(words(storyboard)).toBe(words(make(fx, 1)));
      }
    }
  });

  it('gives longer targets at least as much to say', () => {
    const fx = retryFixture();
    expect(words(make(fx, 30))).toBeLessThanOrEqual(words(make(fx, 60)));
    expect(words(make(fx, 60))).toBeLessThanOrEqual(words(make(fx, 150)));
    expect(make(fx, 20).scenes.length).toBeLessThanOrEqual(make(fx, 150).scenes.length);
  });

  it('keeps every line short enough to read and every scene within the line limit', () => {
    for (const create of [() => retryFixture(), () => inventoryFixture(), () => tinyFixture()]) {
      for (const targetSec of [20, 60, 300]) {
        for (const s of make(create(), targetSec).scenes) {
          expect(s.narration.length).toBeGreaterThanOrEqual(1);
          expect(s.narration.length).toBeLessThanOrEqual(STORYBOARD_LIMITS.maxNarrationLinesPerScene);
          for (const line of s.narration) {
            expect(countWords(line.text)).toBeLessThanOrEqual(STORYBOARD_LIMITS.maxWordsPerNarrationLine);
            expect(line.evidence.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it('uses between two and ten scenes with unique ids', () => {
    for (const create of [() => retryFixture(), () => inventoryFixture(), () => tinyFixture()]) {
      for (const targetSec of [1, 20, 300]) {
        const { scenes } = make(create(), targetSec);
        expect(scenes.length).toBeGreaterThanOrEqual(STORYBOARD_LIMITS.minScenes);
        expect(scenes.length).toBeLessThanOrEqual(STORYBOARD_LIMITS.maxScenes);
        expect(new Set(scenes.map((s) => s.id)).size).toBe(scenes.length);
      }
    }
  });
});
