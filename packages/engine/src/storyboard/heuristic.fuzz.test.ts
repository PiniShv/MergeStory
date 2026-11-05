/**
 * Many changes made up at random (with a fixed seed): files that are added, edited and deleted, symbols
 * of every kind, nested and next to each other, risks with values, dependencies, notes that name the code.
 * Whatever the shape, the offline storyboard has to pass the grounding validator without an error, a
 * warning or a repair, and every code scene has to talk only about code on screen.
 */
import { describe, expect, it } from 'vitest';
import { STORYBOARD_LIMITS } from '../core/storyboard-schema.ts';
import { countWords } from '../core/text.ts';
import type { RiskCategory, RiskSeverity, SymbolKind } from '../core/types.ts';
import { expectCleanStoryboard, focusProblems, symbolsOffScreen } from '../testing/analysed.ts';
import {
  buildFixture,
  type Fixture,
  type FixtureFile,
  type FixtureSpec,
} from '../testing/storyboard-fixtures.ts';
import { heuristicStoryboard } from './heuristic.ts';

/** A small seeded generator, so a failure can be reproduced. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Random = () => number;
const int = (random: Random, low: number, high: number): number =>
  low + Math.floor(random() * (high - low + 1));
const pick = <T>(random: Random, items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
const chance = (random: Random, p: number): boolean => random() < p;

const KINDS: SymbolKind[] = [
  'function',
  'function',
  'method',
  'class',
  'interface',
  'type',
  'constant',
  'component',
  'route',
  'other',
];
const SEVERITIES: RiskSeverity[] = ['info', 'low', 'low', 'medium', 'high'];
const CATEGORIES: RiskCategory[] = [
  'security',
  'data',
  'public-api',
  'error-handling',
  'performance',
  'tests',
  'config',
];
const WORDS = [
  'alpha',
  'bravo',
  'getForecast',
  'delta',
  'echo',
  'fetch',
  'gamma',
  'handle',
  'index',
  'join',
  'load',
  'merge',
  'parse',
  'queue',
  'render',
  'sync',
];

function camel(random: Random): string {
  return `${pick(random, WORDS)}${pick(random, WORDS).replace(/^./, (c) => c.toUpperCase())}`;
}

function codeLine(random: Random, names: readonly string[]): string {
  const name = pick(random, names);
  const shapes = [
    `  ${pick(random, WORDS)}(${name});`,
    `  const ${pick(random, WORDS)}${int(random, 1, 99)} = ${name}(${int(random, 0, 9)});`,
    `  if (${name}) return ${int(random, 0, 9)};`,
    `  // ${pick(random, WORDS)} the ${pick(random, WORDS)}`,
    `  return await ${name}();`,
    `  const limit = { retries: ${int(random, 1, 5)}, timeoutMs: ${int(random, 100, 9000)} };`,
    '',
  ];
  return pick(random, shapes);
}

interface Made {
  fixture: Fixture;
  description: string;
}

function makeChange(seed: number): Made {
  const random = generator(seed);
  const names = Array.from({ length: int(random, 3, 8) }, () => camel(random));
  const componentKeys = ['core', 'web', 'docs'].slice(0, int(random, 1, 3));
  const files: FixtureFile[] = [];
  const symbols: NonNullable<FixtureSpec['symbols']> = [];
  // The side and the length of each file, so that a risk can point at a line that exists.
  const shown = new Map<string, { side: 'head' | 'base'; length: number }>();

  for (let f = 0; f < int(random, 1, 5); f++) {
    const path = `src/${pick(random, componentKeys)}/file${f}.${chance(random, 0.7) ? 'ts' : 'py'}`;
    const status = pick(random, ['added', 'added', 'modified', 'modified', 'modified', 'deleted'] as const);
    const length = int(random, 3, chance(random, 0.2) ? 70 : 30);
    const head = Array.from({ length }, () => codeLine(random, names));
    let base: string[] | undefined;
    if (status !== 'added') {
      base = [...head];
      for (let edit = 0; edit < int(random, 1, 4); edit++) {
        const at = int(random, 0, base.length - 1);
        const how = int(random, 0, 2);
        if (how === 0) base[at] = `  changed${int(random, 1, 999)}();`;
        else if (how === 1) base.splice(at, 0, `  extra${int(random, 1, 999)}();`);
        else base.splice(at, 1);
      }
    }
    const lines = status === 'deleted' ? (base ?? head) : head;
    const side = status === 'deleted' ? ('base' as const) : ('head' as const);
    shown.set(path, { side, length: lines.length });
    const role = chance(random, 0.15)
      ? ('test' as const)
      : chance(random, 0.1)
        ? ('docs' as const)
        : ('source' as const);
    files.push({
      path,
      status,
      base: status === 'added' ? undefined : base,
      head: status === 'deleted' ? undefined : head,
      component: pick(random, componentKeys),
      role,
      language: path.endsWith('.py') ? 'python' : 'typescript',
      importance: 0.2 + random() * 0.7,
      trivial: chance(random, 0.05),
      sensitive: chance(random, 0.03),
    });

    // Symbols: some next to each other, some nested, some too long to show whole.
    let cursor = 1;
    while (cursor < lines.length && chance(random, 0.75)) {
      const start = cursor + int(random, 0, 5);
      const end = Math.min(lines.length, start + int(random, 0, chance(random, 0.2) ? 40 : 8));
      if (start > lines.length) break;
      const kind = pick(random, KINDS);
      const name = chance(random, 0.7)
        ? pick(random, names)
        : `${pick(random, names)}.${pick(random, WORDS)}`;
      symbols.push({
        name,
        kind,
        change:
          status === 'added'
            ? 'added'
            : status === 'deleted'
              ? 'removed'
              : pick(random, ['modified', 'modified', 'added'] as const),
        file: path,
        side,
        startLine: start,
        endLine: end,
        exported: chance(random, 0.6),
      });
      if (chance(random, 0.25) && end - start >= 3) {
        symbols.push({
          name: `${name}.inner`,
          kind: 'method',
          change: 'modified',
          file: path,
          side,
          startLine: start + 1,
          endLine: end - 1,
          exported: chance(random, 0.5),
        });
      }
      cursor = end + 1;
    }
  }

  const paths = files.map((file) => file.path);
  const risks: NonNullable<FixtureSpec['risks']> = Array.from({ length: int(random, 0, 4) }, (_, i) => {
    const path = pick(random, paths);
    const where = shown.get(path)!;
    const line = int(random, 1, Math.min(3, where.length));
    const kind = pick(random, ['numeric', 'numeric-long', 'api', 'api-long', 'dependency'] as const);
    const many = (count: number) => Array.from({ length: count }, () => pick(random, names)).join(', ');
    const details = {
      numeric: `Changes a timeout, retry or interval value at ${path}:${line}. retries: new value ${int(random, 1, 9)}; timeoutMs: ${int(random, 100, 900)} to ${int(random, 1000, 9000)}.`,
      'numeric-long': `Changes a timeout, retry or interval value at ${path}:${line}. retries: new value 3; baseDelayMs: new value 250; maxDelayMs: new value 4_000; pollIntervalMs: 500 to 1_500; ttlSeconds: new value 60*60.`,
      api: `Changes the signature of 1 exported symbol at ${path}:${line}. Affected: ${pick(random, names)}.`,
      'api-long': `Changes the signature of 6 exported symbols at ${path}:${line}. Affected: ${many(4)} and 2 more.`,
      dependency: `Adds 4 dependencies at ${path}:${line}. New: ${many(4)}.`,
    };
    return {
      severity: pick(random, SEVERITIES),
      category: pick(random, CATEGORIES),
      title: kind.startsWith('numeric')
        ? 'Check the changed timeout, retry or interval values'
        : `Confirm the ${pick(random, WORDS)} signal ${i} with a very long title that goes on and on for a while`,
      detail: details[kind],
      files: [path],
      ref: chance(random, 0.8) ? { path, side: where.side, startLine: line, endLine: line } : null,
    };
  });

  const description = [
    `seed ${seed}`,
    ...files.map((file) => `${file.status} ${file.path}`),
    ...symbols.map((s) => `${s.change} ${s.kind} ${s.name} ${s.file}:${s.startLine}-${s.endLine}`),
  ].join('\n');

  const notes = chance(random, 0.6)
    ? [
        `- ${pick(random, names)} is the entry point, so ${pick(random, WORDS)} calls it first.`,
        `- Worth a careful review: ${pick(random, names)} is only safe because of ${pick(random, names)}; and the timeout applies per attempt.`,
        `- The limit is min(${pick(random, names)}, ${pick(random, names)} * 2^attempt).`,
      ].join('\n')
    : null;

  const fixture = buildFixture({
    source: chance(random, 0.5) ? 'github' : 'local',
    pr: chance(random, 0.5)
      ? {
          title: `Make ${pick(random, names)} ${pick(random, WORDS)}`,
          body: `The ${pick(random, names)} now calls ${pick(random, names)}. More text follows here.`,
        }
      : null,
    commits: chance(random, 0.6)
      ? [{ subject: `Add ${pick(random, names)} and ${pick(random, names)}` }]
      : [],
    files,
    components: componentKeys.map((key) => ({
      key,
      name: key,
      path: `src/${key}`,
      kind: key === 'docs' ? ('docs' as const) : ('module' as const),
    })),
    symbols,
    risks,
    relationships:
      componentKeys.length > 1 && chance(random, 0.6)
        ? [{ from: componentKeys[0]!, to: componentKeys[1]!, kind: 'imports' as const, file: paths[0]! }]
        : [],
    dependencies: chance(random, 0.3)
      ? [
          {
            ecosystem: 'npm',
            name: pick(random, WORDS),
            change: 'updated',
            from: '1.0.0',
            to: '1.1.0',
            dev: false,
            file: paths[0]!,
          },
        ]
      : [],
    inputs: {
      task: chance(random, 0.5)
        ? `Make ${pick(random, names)} faster to read. Keep ${pick(random, names)} as it is.`
        : null,
      notes,
      tests: chance(random, 0.3)
        ? [{ id: 'T1', command: 'npm test', passed: true, summary: '3 passed', source: 'agent' }]
        : [],
    },
  });
  return { fixture, description };
}

/** How many changes to make up. Set MERGESTORY_FUZZ_SEEDS to try more. */
const SEEDS = Number(process.env.MERGESTORY_FUZZ_SEEDS) || 250;

describe('the offline storyboard for changes made up at random', () => {
  it(
    'passes the grounding validator without a warning or a repair, whatever the change looks like',
    async () => {
      for (let seed = 1; seed <= SEEDS; seed++) {
        const { fixture, description } = makeChange(seed);
        for (const targetSec of [10, 45, 100, 300]) {
          const storyboard = heuristicStoryboard(
            fixture.changeSet,
            fixture.analysis,
            fixture.inputs,
            fixture.config,
            targetSec,
          );
          const problems = await expectCleanStoryboard(fixture.deps, storyboard);
          if (problems.length > 0)
            throw new Error(`${description}\ntarget ${targetSec}\n${problems.join('\n')}`);
          expect(focusProblems(storyboard), description).toEqual([]);
          expect(symbolsOffScreen(storyboard, fixture.analysis), description).toEqual([]);
          for (const scene of storyboard.scenes) {
            expect(scene.narration.length).toBeGreaterThanOrEqual(1);
            expect(scene.narration.length).toBeLessThanOrEqual(STORYBOARD_LIMITS.maxNarrationLinesPerScene);
            for (const line of scene.narration) {
              expect(countWords(line.text), description).toBeLessThanOrEqual(
                STORYBOARD_LIMITS.maxWordsPerNarrationLine,
              );
            }
          }
        }
      }
    },
    // About 8 seconds alone on a laptop; a busy CI runner can take several times that.
    30_000 + SEEDS * 200,
  );

  it('is the same every time', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const { fixture } = makeChange(seed);
      const run = () =>
        heuristicStoryboard(fixture.changeSet, fixture.analysis, fixture.inputs, fixture.config, 100);
      expect(run()).toEqual(run());
    }
  });
});
