/**
 * The offline storyboard for the demo change, built from real git data: the demo repository is
 * created by the script in examples/demo, read by the local source and analysed like any other change.
 * The hand-written storyboard that ships with the demo has to stay valid for the same change.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyze, targetDuration } from '../analyzer/index.ts';
import type { Scene, Storyboard } from '../core/storyboard-schema.ts';
import { countWords } from '../core/text.ts';
import { buildContextInputs } from '../pipeline/inputs.ts';
import { LocalGitSource } from '../sources/local.ts';
import { expectCleanStoryboard, focusProblems, symbolsOffScreen } from '../testing/analysed.ts';
import { testContext } from '../testing/context.ts';
import { heuristicStoryboard } from './heuristic.ts';
import type { ValidationDeps } from './types.ts';

const DEMO = fileURLToPath(new URL('../../../../examples/demo/', import.meta.url));

interface Demo extends ValidationDeps {
  targetSec: number;
}

let directory = '';
let demo: Demo;

const originalEnv = {
  GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
  GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
};

beforeAll(async () => {
  // Keep the developer's own git settings out of the picture.
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  directory = await mkdtemp(join(tmpdir(), 'mergestory-demo-'));
  const repo = join(directory, 'demo');
  execFileSync('bash', [join(DEMO, 'create-demo-repo.sh'), repo], { stdio: 'pipe' });

  const ctx = testContext().ctx;
  const { changeSet, reader } = await new LocalGitSource().load(
    { kind: 'local', repoPath: repo, base: 'main', head: 'feature/retry' },
    ctx,
  );
  const inputs = await buildContextInputs(
    {
      task: await readFile(join(DEMO, 'task.md'), 'utf8'),
      notes: await readFile(join(DEMO, 'notes.md'), 'utf8'),
      tests: JSON.parse(await readFile(join(DEMO, 'tests.json'), 'utf8')) as [],
    },
    directory,
  );
  const analysis = await analyze(changeSet, reader, inputs, ctx);
  demo = {
    changeSet,
    analysis,
    inputs,
    reader,
    config: ctx.config,
    targetSec: targetDuration(analysis, ctx.config),
  };
});

afterAll(async () => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(directory, { recursive: true, force: true });
});

const storyboard = (targetSec = demo.targetSec): Storyboard =>
  heuristicStoryboard(demo.changeSet, demo.analysis, demo.inputs, demo.config, targetSec);

const sentences = (scene: Scene): string[] => scene.narration.map((line) => line.text);
const ofRole = (board: Storyboard, role: Scene['role']): Scene[] =>
  board.scenes.filter((s) => s.role === role);

describe('the demo change', () => {
  it('is the change the demo describes', () => {
    const { changeSet, analysis } = demo;
    expect(changeSet.files.map((f) => f.path).sort()).toEqual([
      'README.md',
      'package.json',
      'src/client.ts',
      'src/config.ts',
      'src/index.ts',
      'src/retry.ts',
      'test/retry.test.ts',
    ]);
    expect(analysis.symbols.map((s) => s.name)).toEqual(
      expect.arrayContaining([
        'withRetry',
        'backoffDelay',
        'isRetryableStatus',
        'DEFAULT_RETRY',
        'WeatherClient.getForecast',
      ]),
    );
    expect(demo.inputs.tests).toHaveLength(1);
    expect(demo.targetSec).toBe(100);
  });
});

describe('the offline storyboard for the demo change', () => {
  it('passes the grounding validator without a warning or a repair, at every length', async () => {
    for (const targetSec of [1, 20, 45, 100, 150, 300]) {
      const board = storyboard(targetSec);
      expect(await expectCleanStoryboard(demo, board)).toEqual([]);
      expect(focusProblems(board)).toEqual([]);
      expect(symbolsOffScreen(board, demo.analysis)).toEqual([]);
    }
  });

  it('is the same every time, and fits the word budget of the target length', () => {
    expect(storyboard()).toEqual(storyboard());
    const words = storyboard().scenes.reduce(
      (sum, scene) => sum + scene.narration.reduce((n, line) => n + countWords(line.text), 0),
      0,
    );
    expect(words).toBeLessThanOrEqual(demo.targetSec * 2.5);
  });

  it('shows the list of files for the big picture, not a diagram of one or two unconnected boxes', () => {
    for (const targetSec of [20, 100, 300]) {
      const scene = ofRole(storyboard(targetSec), 'big-picture')[0]!;
      expect(scene.visual.type).toBe('files');
    }
    // Whatever it draws, a diagram has at least two boxes and one line between them.
    for (const scene of storyboard(300).scenes) {
      if (scene.visual.type !== 'architecture') continue;
      expect(scene.visual.nodes.length).toBeGreaterThanOrEqual(2);
      expect(scene.visual.edges.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('names the new function, the method that changed and the values, as the code and the analysis show them', () => {
    const board = storyboard();
    const text = board.scenes.flatMap(sentences).join('\n');
    expect(board.title).toBe('Retry temporary failures with exponential backoff');
    expect(text).toContain('withRetry');
    expect(text).toContain('WeatherClient.getForecast');
    expect(text).toContain('It sets retries to 3, baseDelayMs to 250 and maxDelayMs to 4000.');
    // With room for every review signal, the one about the loop says where it is.
    expect(storyboard(300).scenes.flatMap(sentences)).toContain(
      'Third: Check the async calls inside a loop, in withRetry.',
    );
    expect(board.summary).toContain('adds withRetry, backoffDelay and isRetryableStatus');
  });

  it('shows all of withRetry, and describes only what is on screen', async () => {
    const board = storyboard(300);
    const symbol = demo.analysis.symbols.find((s) => s.name === 'withRetry')!;
    const scene = board.scenes.find((s) => s.visual.type === 'code' && s.visual.ref.path === 'src/retry.ts')!;
    expect(scene.title).toBe('withRetry in retry.ts');
    if (scene.visual.type !== 'code') return;
    expect([scene.visual.ref.startLine, scene.visual.ref.endLine]).toEqual([
      symbol.startLine,
      symbol.endLine,
    ]);
    expect(sentences(scene)[0]).toBe('In retry.ts, the function withRetry is new and exported.');
    // backoffDelay is declared above the window: it can be named as something withRetry calls, not described.
    expect(sentences(scene)).toContain(
      'withRetry calls backoffDelay. It also uses RetryDecision and RetryOptions.',
    );
    expect(sentences(scene).join(' ')).not.toMatch(/function backoffDelay/);
    // The highlight sits on the line of retry.ts that calls backoffDelay.
    const source = (await readFile(join(DEMO, 'feature/src/retry.ts'), 'utf8')).split('\n');
    const callLine = source.findLastIndex((line) => /\bbackoffDelay\(attempt/.test(line)) + 1;
    expect(callLine).toBeGreaterThan(symbol.startLine);
    expect(scene.visual.focus).toContainEqual(
      expect.objectContaining({ note: 'Calls backoffDelay', startLine: callLine, endLine: callLine }),
    );
  });

  it('shows getForecast from its first line, as a snippet, because the removed lines would not fit', () => {
    const board = storyboard(300);
    const scene = board.scenes.find(
      (s) => s.visual.type === 'code' && s.visual.ref.path === 'src/client.ts',
    )!;
    if (scene.visual.type !== 'code') return;
    const getForecast = demo.analysis.symbols.find((s) => s.name === 'WeatherClient.getForecast')!;
    expect(scene.visual.ref.startLine).toBe(getForecast.startLine);
    expect(scene.visual.mode).toBe('snippet');
    expect(sentences(scene)[0]).toBe(
      'In client.ts, the method WeatherClient.getForecast was changed and is exported.',
    );
    expect(sentences(scene)).toContain(
      'WeatherClient.getForecast calls withRetry and retryAfterMs. It also creates WeatherError.',
    );
  });

  it('quotes the notes next to the code they explain, and flags what they ask reviewers to check', () => {
    const board = storyboard(300);
    const text = board.scenes.flatMap(sentences);
    expect(text).toContain(
      'The notes say: Retries live in a small reusable helper, src/retry.ts (withRetry), so other calls can use it later.',
    );
    expect(text).toContain(
      'The notes say: getForecast is a GET with no side effects, so sending it again is safe.',
    );
    const review = ofRole(board, 'review')[0]!;
    expect(sentences(review)[1]).toBe(
      'The notes flag this for review: the timeout applies per attempt, so the worst-case total time grows with retries; and a long Retry-After is used as sent, without the maxDelayMs cap.',
    );
    expect(board.uncertainties.some((u) => u.includes('the author’s words'))).toBe(true);
  });

  it('puts the review points with values and names first, and still reports the test run the way the agent did', () => {
    const board = storyboard();
    const review = ofRole(board, 'review')[0]!;
    expect(sentences(review).join(' ')).toContain(
      'Check the changed timeout, retry or interval values, in DEFAULT_RETRY.',
    );
    const last = board.scenes.at(-1)!;
    expect(sentences(last)).toContain('The coding agent reported that npm test passed.');
  });
});

describe('the hand-written storyboard of the demo', () => {
  it('stays valid for the demo change, with nothing repaired and nothing to warn about', async () => {
    const written = JSON.parse(await readFile(join(DEMO, 'storyboard.json'), 'utf8')) as unknown;
    expect(await expectCleanStoryboard(demo, written as Storyboard)).toEqual([]);
  });

  it('keeps every code range on screen, with the highlights inside it', async () => {
    const written = JSON.parse(await readFile(join(DEMO, 'storyboard.json'), 'utf8')) as Storyboard;
    expect(focusProblems(written)).toEqual([]);
  });
});
