import { describe, expect, it } from 'vitest';
import type { RiskSignal } from '../core/types.ts';
import {
  buildFixture,
  type Fixture,
  type FixtureSpec,
  retryFixture,
} from '../testing/storyboard-fixtures.ts';
import { createCtx } from './heuristic-context.ts';
import {
  affectedNames,
  authorStatements,
  dependencyLine,
  distinctiveTokens,
  formatNumber,
  numericFacts,
  numericSentences,
  pickStatement,
  quoteLine,
  recap,
  reviewHint,
  testsLine,
  topSymbols,
} from './heuristic-facts.ts';

const ctxOf = (fx: Fixture) => createCtx(fx.changeSet, fx.analysis, fx.inputs, fx.config);

const APP = [{ key: 'app', name: 'app', path: 'src', kind: 'module' as const }];

function risk(detail: string): RiskSignal {
  return {
    id: 'R1',
    severity: 'low',
    category: 'performance',
    title: 'Check',
    detail,
    evidence: [],
    ref: null,
  };
}

/** A small change with notes, for the tests of quoted statements. */
function withNotes(notes: string, extra: Partial<FixtureSpec> = {}): Fixture {
  return buildFixture({
    source: 'local',
    pr: null,
    files: [{ path: 'src/a.ts', head: ['export function withRetry() {', '  go();', '}'], component: 'app' }],
    components: APP,
    inputs: { notes },
    ...extra,
  });
}

describe('values in risk details', () => {
  const detail =
    'Changes a timeout, retry or interval value at src/retry.ts:8. retries: new value 3; baseDelayMs: new value 250; maxDelayMs: new value 4_000.';

  it('reads new values and values that changed', () => {
    expect(numericFacts(risk(detail))).toEqual([
      { name: 'retries', from: null, to: '3' },
      { name: 'baseDelayMs', from: null, to: '250' },
      { name: 'maxDelayMs', from: null, to: '4000' },
    ]);
    expect(numericFacts(risk('Changes a value. timeoutMs: 5000 to 30_000; retries: new value 2.'))).toEqual([
      { name: 'timeoutMs', from: '5000', to: '30000' },
      { name: 'retries', from: null, to: '2' },
    ]);
  });

  it('says digit separators and products as speech can read them', () => {
    expect(formatNumber('4_000')).toBe('4000');
    expect(formatNumber('60*1000')).toBe('60 times 1000');
    expect(formatNumber('1.5')).toBe('1.5');
    expect(numericFacts(risk('x. pollInterval: new value 60*1000.'))[0]?.to).toBe('60 times 1000');
    expect(numericFacts(risk('x. ttl: new value 1.5.'))[0]?.to).toBe('1.5');
  });

  it('finds nothing in other risks', () => {
    expect(numericFacts(risk('Changes the signature of 1 exported symbol at src/client.ts:18.'))).toEqual([]);
    expect(numericFacts(risk('Adds a call. Largest block: 120 lines.'))).toEqual([]);
  });

  it('turns the values into sentences about the symbol that holds them', () => {
    const facts = numericFacts(risk(detail));
    expect(numericSentences(facts, 'DEFAULT_RETRY')).toEqual([
      'DEFAULT_RETRY sets retries to 3, baseDelayMs to 250 and maxDelayMs to 4000.',
    ]);
    expect(numericSentences(facts, null)).toEqual([
      'It sets retries to 3, baseDelayMs to 250 and maxDelayMs to 4000.',
    ]);
    expect(numericSentences(facts, null, 2)).toEqual(['It sets retries to 3 and baseDelayMs to 250.']);
    expect(
      numericSentences(
        [
          { name: 'timeoutMs', from: '5000', to: '30000' },
          { name: 'retries', from: null, to: '2' },
        ],
        'connect',
      ),
    ).toEqual(['connect sets retries to 2.', 'It changes timeoutMs from 5000 to 30000.']);
    expect(numericSentences([], 'x')).toEqual([]);
  });

  it('reads the names after "Affected:"', () => {
    expect(
      affectedNames(
        risk(
          'Changes the signature of 1 exported symbol at src/client.ts:18. Affected: WeatherError.constructor.',
        ),
      ),
    ).toEqual(['WeatherError.constructor']);
    expect(
      affectedNames(risk('Removes 6 exported symbols at a.ts:1. Affected: a, b, c, d and 2 more.')),
    ).toEqual(['a', 'b', 'c', 'd']);
    expect(affectedNames(risk('Adds a thing.'))).toEqual([]);
  });
});

describe('statements by the author', () => {
  it('splits notes into sentences, one per bullet at least', () => {
    const ctx = ctxOf(
      withNotes(
        [
          '- Retries live in a small helper, src/retry.ts (withRetry), so other calls can use it.',
          '- If the API sends Retry-After, that wait is used.',
          '  It replaces the computed backoff.',
          '1. Only 429 and 5xx are retried.',
        ].join('\n'),
      ),
    );
    const statements = authorStatements(ctx);
    expect(statements.map((s) => s.full)).toEqual([
      'Retries live in a small helper, src/retry.ts (withRetry), so other calls can use it.',
      'If the API sends Retry-After, that wait is used.',
      'It replaces the computed backoff.',
      'Only 429 and 5xx are retried.',
    ]);
    expect(statements.every((s) => s.source === 'NOTES' && s.lead === 'The notes say')).toBe(true);
  });

  it('shortens a sentence that is mostly code to its first clause, or leaves it out', () => {
    const ctx = ctxOf(
      withNotes(
        [
          '- Backoff uses "full jitter": a random wait between 0 and min(maxDelayMs, baseDelayMs * 2^attempt).',
          '- The cap is min(maxDelayMs, baseDelayMs * 2^attempt) and nothing more.',
        ].join('\n'),
      ),
    );
    const statements = authorStatements(ctx);
    expect(statements).toHaveLength(1);
    expect(statements[0]!.spoken).toBe("Backoff uses 'full jitter'.");
    expect(statements[0]!.full).toContain('baseDelayMs * 2^attempt');
  });

  it('leaves out claims that nothing proves, web addresses and very short sentences', () => {
    const ctx = ctxOf(
      withNotes(
        [
          '- All tests pass and this is production-ready.',
          '- Details are at https://evil.example.dev/page for everyone.',
          '- Fast.',
          '- The helper waits before it asks again.',
        ].join('\n'),
      ),
    );
    expect(authorStatements(ctx).map((s) => s.full)).toEqual(['The helper waits before it asks again.']);
  });

  it('masks secrets, and takes sentences from the pull request description too', () => {
    const fx = buildFixture({
      source: 'github',
      pr: {
        title: 'Add retry',
        body: 'The client calls withRetry for every forecast request. Ask jane.doe@example.com about the limits.',
      },
      files: [
        { path: 'src/a.ts', head: ['export function withRetry() {', '  go();', '}'], component: 'app' },
      ],
      components: APP,
      // The made-up token is built at run time, so it never appears whole in the source.
      inputs: {
        notes: `The key is ${['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_')} and it stays secret.`,
      },
    });
    const statements = authorStatements(ctxOf(fx));
    expect(statements.map((s) => [s.source, s.lead])).toContainEqual(['PR', 'The description says']);
    expect(JSON.stringify(statements)).not.toContain('ghp_');
    expect(JSON.stringify(statements)).not.toContain('jane.doe');
  });

  it('takes nothing from notes that were not supplied', () => {
    const fx = buildFixture({
      source: 'local',
      pr: null,
      files: [{ path: 'src/a.ts', head: ['export const A = 1;'], component: 'app' }],
      components: APP,
    });
    expect(authorStatements(ctxOf(fx))).toEqual([]);
  });

  it('knows names that look like code', () => {
    expect(
      [...distinctiveTokens('withRetry uses MAX_RETRIES, not the plain word retry or forecast()')].sort(),
    ).toEqual(['MAX_RETRIES', 'withRetry']);
    expect([...distinctiveTokens('WEATHER and API are loud, but a1 is too short')].sort()).toEqual([
      'WEATHER',
    ]);
  });
});

describe('picking the statement for a window of code', () => {
  const notes = [
    '- Retries live in a small reusable helper, src/retry.ts (withRetry), so other calls can use it later.',
    '- One request id (randomUUID) is created per getForecast() call and sent on every attempt.',
    '- WEATHER_MAX_RETRIES configures the number of retries.',
    '- Backoff spreads retries out when many clients fail at once.',
  ].join('\n');
  const statements = authorStatements(ctxOf(withNotes(notes)));

  it('takes the statement that names a symbol on screen', () => {
    const match = pickStatement(
      statements,
      { code: 'export async function withRetry<T>(', names: ['withRetry'] },
      new Set(),
    );
    expect(match?.statement.full).toContain('reusable helper');
    expect(match?.shared).toEqual(['withRetry']);
  });

  it('counts the last part of a dotted name and names that look like code', () => {
    const match = pickStatement(
      statements,
      {
        code: 'const requestId = randomUUID();',
        names: ['WeatherClient.getForecast', 'WeatherClient', 'getForecast'],
      },
      new Set(),
    );
    expect(match?.statement.full).toContain('One request id');
    expect([...(match?.shared ?? [])].sort()).toEqual(['getForecast', 'randomUUID']);
  });

  it('needs a symbol on screen, or two names that look like code in one statement', () => {
    expect(pickStatement(statements, { code: 'const retries = 3;', names: [] }, new Set())).toBeNull();
    // One shared name each, in two different statements, is not enough.
    expect(
      pickStatement(statements, { code: 'x = WEATHER_MAX_RETRIES + randomUUID()', names: [] }, new Set()),
    ).toBeNull();
    const both = authorStatements(
      ctxOf(withNotes('- The requestId comes from randomUUID and is sent as a header.')),
    );
    expect(
      pickStatement(both, { code: 'const requestId = randomUUID();', names: [] }, new Set())?.shared,
    ).toEqual(['requestId', 'randomUUID']);
  });

  it('does not take a statement twice, and does not match short or common names', () => {
    const first = pickStatement(statements, { code: 'withRetry()', names: ['withRetry'] }, new Set());
    const used = new Set([first!.statement.full]);
    expect(pickStatement(statements, { code: 'withRetry()', names: ['withRetry'] }, used)).toBeNull();
    expect(pickStatement(statements, { code: '', names: ['go', 'run'] }, new Set())).toBeNull();
  });

  it('quotes the statement with its source and cites it', () => {
    const ctx = ctxOf(withNotes(notes));
    const line = quoteLine(ctx, statements[0]!, 'F1.H1', 'S1', 'nothing');
    expect(line.text).toBe(
      'The notes say: Retries live in a small reusable helper, src/retry.ts (withRetry), so other calls can use it later.',
    );
    expect(line.evidence).toEqual(['NOTES', 'F1.H1']);
  });
});

describe('what the author asks reviewers to look at', () => {
  const careful =
    'Worth a careful review: retrying a request is only safe because of the attempt limit; and the timeout applies per attempt, so the worst-case total time grows with retries.';

  it('takes the note that asks for a review, without its lead-in', () => {
    const hint = reviewHint(ctxOf(withNotes(`- The helper is small.\n- ${careful}`)));
    expect(hint).toMatchObject({
      stripped: true,
      title: 'Retrying a request is only safe because of the attempt limit',
      detail: 'The timeout applies per attempt, so the worst-case total time grows with retries.',
      source: 'NOTES',
    });
    expect(hint?.spoken).toBe(
      'retrying a request is only safe because of the attempt limit; and the timeout applies per attempt, so the worst-case total time grows with retries.',
    );
  });

  it('keeps a note as it is when it has no lead-in', () => {
    const hint = reviewHint(ctxOf(withNotes('- Reviewers should look at the cap on the delay.')));
    expect(hint?.stripped).toBe(false);
    expect(hint?.title).toBe('Reviewers should look at the cap on the delay');
    expect(hint?.detail).toBe('Reviewers should look at the cap on the delay.');
  });

  it('gives nothing when the notes ask for nothing, are missing, or the task is the only source', () => {
    expect(reviewHint(ctxOf(withNotes('- The helper is small and has a clear name.')))).toBeNull();
    const noNotes = buildFixture({
      source: 'local',
      pr: null,
      files: [{ path: 'src/a.ts', head: ['export const A = 1;'], component: 'app' }],
      components: APP,
      inputs: { task: 'Review the cap on the delay with care, please.' },
    });
    expect(reviewHint(ctxOf(noNotes))).toBeNull();
  });
});

describe('dependencies and tests', () => {
  function dependencyFixture(): Fixture {
    return buildFixture({
      source: 'local',
      pr: null,
      files: [
        {
          path: 'package.json',
          head: ['{}'],
          component: 'app',
          role: 'dependency-manifest',
          language: 'json',
        },
        { path: 'test/a.test.ts', head: ["it('works', () => {});"], component: 'app', role: 'test' },
      ],
      components: APP,
      dependencies: [
        {
          ecosystem: 'npm',
          name: 'undici',
          change: 'updated',
          from: '6.0.0',
          to: '6.1.0',
          dev: false,
          file: 'package.json',
        },
        {
          ecosystem: 'npm',
          name: 'zod',
          change: 'added',
          from: null,
          to: '4.0.0',
          dev: false,
          file: 'package.json',
        },
        {
          ecosystem: 'npm',
          name: 'left-pad',
          change: 'removed',
          from: '1.0.0',
          to: null,
          dev: false,
          file: 'package.json',
        },
      ],
    });
  }

  it('says what happened to dependencies, at most two kinds in one line', () => {
    const line = dependencyLine(ctxOf(dependencyFixture()));
    expect(line?.text).toBe('It adds the dependency zod. It updates undici from 6.0.0 to 6.1.0.');
    expect(line?.evidence).toEqual(['D2', 'D1']);
  });

  it('reads out only plain version numbers', () => {
    const fx = buildFixture({
      source: 'local',
      pr: null,
      files: [
        {
          path: 'package.json',
          head: ['{}'],
          component: 'app',
          role: 'dependency-manifest',
          language: 'json',
        },
      ],
      components: APP,
      dependencies: [
        {
          ecosystem: 'npm',
          name: 'tool',
          change: 'updated',
          from: '^1.2.3',
          to: 'git+https://host.example/tool.git#main',
          dev: false,
          file: 'package.json',
        },
      ],
    });
    expect(dependencyLine(ctxOf(fx))?.text).toBe('It updates tool.');
    const plain = buildFixture({
      source: 'local',
      pr: null,
      files: [
        {
          path: 'package.json',
          head: ['{}'],
          component: 'app',
          role: 'dependency-manifest',
          language: 'json',
        },
      ],
      components: APP,
      dependencies: [
        {
          ecosystem: 'npm',
          name: 'tool',
          change: 'updated',
          from: '^1.2.3',
          to: '~2.0.0-beta.1',
          dev: false,
          file: 'package.json',
        },
        {
          ecosystem: 'npm',
          name: 'other',
          change: 'updated',
          from: '1.0.0',
          to: '1.0.1',
          dev: false,
          file: 'package.json',
        },
      ],
    });
    expect(dependencyLine(ctxOf(plain))?.text).toBe(
      'It updates tool from ^1.2.3 to ~2.0.0-beta.1, and 1 other dependency.',
    );
  });

  it('says it for a removal alone, and for several additions', () => {
    const fx = buildFixture({
      source: 'local',
      pr: null,
      files: [
        {
          path: 'package.json',
          head: ['{}'],
          component: 'app',
          role: 'dependency-manifest',
          language: 'json',
        },
      ],
      components: APP,
      dependencies: [
        {
          ecosystem: 'npm',
          name: 'a-lib',
          change: 'removed',
          from: '1.0.0',
          to: null,
          dev: false,
          file: 'package.json',
        },
      ],
    });
    expect(dependencyLine(ctxOf(fx))?.text).toBe('It removes the dependency a-lib.');
    const many = buildFixture({
      source: 'local',
      pr: null,
      files: [
        {
          path: 'package.json',
          head: ['{}'],
          component: 'app',
          role: 'dependency-manifest',
          language: 'json',
        },
      ],
      components: APP,
      dependencies: ['one', 'two', 'three', 'four'].map((name) => ({
        ecosystem: 'npm' as const,
        name,
        change: 'added' as const,
        from: null,
        to: '1.0.0',
        dev: false,
        file: 'package.json',
      })),
    });
    expect(dependencyLine(ctxOf(many))?.text).toBe('It adds the dependencies one, two and three.');
  });

  it('says nothing about dependencies of a file that may not be shown, or when there are none', () => {
    const hidden = buildFixture({
      source: 'local',
      pr: null,
      files: [
        {
          path: 'package.json',
          head: ['{}'],
          component: 'app',
          role: 'dependency-manifest',
          language: 'json',
        },
      ],
      components: APP,
      config: { privacy: { excludePaths: ['package.json'] } },
      dependencies: [
        {
          ecosystem: 'npm',
          name: 'zod',
          change: 'added',
          from: null,
          to: '4.0.0',
          dev: false,
          file: 'package.json',
        },
      ],
    });
    expect(dependencyLine(ctxOf(hidden))).toBeNull();
    expect(dependencyLine(ctxOf(withNotes('- x')))).toBeNull();
  });

  it('names the test files that were added or changed', () => {
    expect(testsLine(ctxOf(dependencyFixture()))?.text).toBe('Tests were added in a.test.ts.');
    const modified = buildFixture({
      source: 'local',
      pr: null,
      files: [
        {
          path: 'test/a.test.ts',
          base: ["it('a', () => {});"],
          head: ["it('b', () => {});"],
          component: 'app',
          role: 'test',
        },
        {
          path: 'test/b.test.ts',
          base: ["it('a', () => {});"],
          head: ["it('b', () => {});"],
          component: 'app',
          role: 'test',
        },
      ],
      components: APP,
    });
    const line = testsLine(ctxOf(modified));
    expect(line?.text).toBe('Tests were changed in a.test.ts and b.test.ts.');
    expect(line?.evidence).toEqual(['F1', 'F2']);
    expect(testsLine(ctxOf(withNotes('- x')))).toBeNull();
  });
});

describe('the names of what changed', () => {
  it('ranks the symbols of the whole change and names what was added, modified and removed', () => {
    const ctx = ctxOf(retryFixture());
    expect(topSymbols(ctx)[0]?.name).toBe('fetchWithBackoff');
    expect(recap(ctx)).toEqual({
      clause: 'adds fetchWithBackoff, delayFor and MAX_RETRIES, and modifies the method get',
      ids: ['S1', 'S2', 'S3', 'S4'],
    });
  });

  it('lets a modified class give way to its members, and a new class stand for its members', () => {
    const members = (change: 'added' | 'modified') => [
      { name: 'Box', kind: 'class' as const, change, file: 'src/box.ts', startLine: 1, endLine: 8 },
      { name: 'Box.size', kind: 'method' as const, change, file: 'src/box.ts', startLine: 3, endLine: 5 },
    ];
    const head = [
      'export class Box {',
      '  w = 1;',
      '  size() {',
      '    return this.w;',
      '  }',
      '  other() {}',
      '  more() {}',
      '}',
    ];
    const make = (change: 'added' | 'modified') =>
      buildFixture({
        source: 'local',
        pr: null,
        files: [
          {
            path: 'src/box.ts',
            base: change === 'modified' ? head.map((l) => l.replace('this.w', 'this.w * 2')) : undefined,
            head,
            component: 'app',
          },
        ],
        components: APP,
        symbols: members(change),
      });
    expect(recap(ctxOf(make('modified')))?.clause).toBe('modifies Box.size');
    expect(recap(ctxOf(make('added')))?.clause).toBe('adds Box');
  });

  it('names removed symbols, and says nothing when no symbol is known', () => {
    const fx = buildFixture({
      source: 'local',
      pr: null,
      files: [{ path: 'src/old.ts', base: ['export function gone() {}'], component: 'app' }],
      components: APP,
      symbols: [
        { name: 'gone', kind: 'function', change: 'removed', file: 'src/old.ts', startLine: 1, endLine: 1 },
      ],
    });
    expect(recap(ctxOf(fx))?.clause).toBe('removes the function gone');
    expect(recap(ctxOf(withNotes('- x', { symbols: [] })))).toBeNull();
  });

  it('leaves out symbols of tests, docs and files that may not be shown', () => {
    const fx = retryFixture({ config: { privacy: { excludePaths: ['src/http/retry.ts'] } } });
    const names = topSymbols(ctxOf(fx)).map((view) => view.name);
    expect(names).not.toContain('fetchWithBackoff');
    expect(names).toContain('get');
  });
});
