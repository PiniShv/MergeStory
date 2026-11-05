import { describe, expect, it } from 'vitest';
import { type Fixture, retryFixture } from '../testing/storyboard-fixtures.ts';
import { baseStoryboard, codes, run, scene } from '../testing/validate.ts';

describe('claims the change cannot prove', () => {
  async function narrationResult(text: string, fx: Fixture = retryFixture(), evidence?: string[]) {
    const sb = baseStoryboard(fx);
    scene(sb, 2).narration[0] = { text, evidence: evidence ?? [fx.id.hunk('src/http/retry.ts')] };
    return { sb, result: await run(sb, fx) };
  }

  it('removes "all tests pass" when no passing result is cited', async () => {
    const { result } = await narrationResult('The retry code is small. All tests pass.');
    expect(result.errors).toEqual([]);
    expect(result.storyboard!.scenes[2]!.narration[0]!.text).toBe('The retry code is small.');
    expect(codes(result.warnings)).toContain('unverified-claim');
    expect(result.fixes.some((f) => f.includes('claims passing tests'))).toBe(true);
  });

  it('keeps the claim when the line cites a passing test result', async () => {
    const fx = retryFixture();
    const { result } = await narrationResult('The retry code is small. All tests pass.', fx, [
      fx.id.hunk('src/http/retry.ts'),
      'T1',
    ]);
    expect(result.errors).toEqual([]);
    expect(result.storyboard!.scenes[2]!.narration[0]!.text).toBe('The retry code is small. All tests pass.');
    expect(result.warnings).toEqual([]);
  });

  it('removes the claim when the cited result failed, or when any reported run did not pass', async () => {
    const failed = retryFixture({
      inputs: {
        task: 'x',
        tests: [
          { id: 'T1', command: 'npm test', passed: true, summary: 'ok', source: 'agent' },
          { id: 'T2', command: 'npm run e2e', passed: false, summary: '2 failed', source: 'agent' },
        ],
      },
    });
    const hunk = failed.id.hunk('src/http/retry.ts');
    const all = await narrationResult('All tests pass.', failed, [hunk, 'T1']);
    expect(all.result.storyboard!.scenes[2]!.narration).toHaveLength(1);
    expect(all.result.storyboard!.scenes[2]!.narration[0]!.text).not.toContain('pass');
    // One run passed, but another did not: nobody may say that "the tests pass".
    const some = await narrationResult('The unit tests pass.', failed, [hunk, 'T1']);
    expect(some.result.storyboard!.scenes[2]!.narration).toHaveLength(1);
    expect(some.result.storyboard!.scenes[2]!.narration[0]!.text).not.toContain('unit tests');
    expect(some.result.warnings.find((w) => w.code === 'unverified-claim')!.message).toContain('T2');
    const bad = await narrationResult('The end to end tests pass.', failed, [hunk, 'T2']);
    expect(bad.result.storyboard!.scenes[2]!.narration).toHaveLength(1);
    // The same sentence stays when every reported run passed.
    const ok = retryFixture({
      inputs: {
        task: 'x',
        tests: [
          { id: 'T1', command: 'npm test', passed: true, summary: 'ok', source: 'agent' },
          { id: 'T2', command: 'npm run e2e', passed: true, summary: 'ok', source: 'agent' },
        ],
      },
    });
    const kept = await narrationResult('The unit tests pass.', ok, [ok.id.hunk('src/http/retry.ts'), 'T1']);
    expect(kept.result.storyboard!.scenes[2]!.narration[0]!.text).toBe('The unit tests pass.');
  });

  it('does not let a passing lint run stand for the tests while a test run failed', async () => {
    const fx = retryFixture({
      inputs: {
        task: 'x',
        tests: [
          { id: 'T1', command: 'npm run lint', passed: true, summary: 'no lint errors', source: 'agent' },
          { id: 'T2', command: 'npm test', passed: false, summary: '1 of 3 tests failed', source: 'agent' },
        ],
      },
    });
    const sb = baseStoryboard(fx);
    const hunk = fx.id.hunk('src/http/retry.ts');
    scene(sb, 0).narration = [
      { text: 'This pull request adds retries to the HTTP client.', evidence: ['PR'] },
      { text: 'The new tests pass.', evidence: ['T1', fx.id.file('src/http/retry.test.ts')] },
      { text: 'The test suite passes.', evidence: ['T1'] },
    ];
    scene(sb, 0).visual.subheading = 'Tests pass';
    scene(sb, 2).narration[0] = { text: 'The new tests pass.', evidence: [hunk, 'T1'] };
    scene(sb, 2).visual.points[0].text = 'Tests pass';
    sb.summary = 'The HTTP client now retries failed requests. The new tests pass.';
    const result = await run(sb, fx);
    expect(result.errors).toEqual([]);
    const board = result.storyboard!;
    expect(board.scenes[0]!.narration.map((line) => line.text)).toEqual([
      'This pull request adds retries to the HTTP client.',
    ]);
    expect(board.scenes[2]!.narration.map((line) => line.text)).not.toContain('The new tests pass.');
    expect(board.summary).toBe('The HTTP client now retries failed requests.');
    const title = board.scenes[0]!.visual;
    expect(title.type === 'title' && title.subheading).toBeNull();
    const summary = board.scenes[2]!.visual;
    expect(summary.type === 'summary' && summary.points.map((p) => p.text)).not.toContain('Tests pass');
  });

  it('needs a cited run whose command runs tests, even when nothing failed', async () => {
    const lintOnly = retryFixture({
      inputs: {
        task: 'x',
        tests: [{ id: 'T1', command: 'npm run lint', passed: true, summary: 'ok', source: 'agent' }],
      },
    });
    const hunk = lintOnly.id.hunk('src/http/retry.ts');
    const lint = await narrationResult('The new tests pass.', lintOnly, [hunk, 'T1']);
    expect(lint.result.storyboard!.scenes[2]!.narration).toHaveLength(1);
    expect(lint.result.warnings.find((w) => w.code === 'unverified-claim')!.message).toContain(
      'Cite a passing test run',
    );
    const runner = retryFixture({
      inputs: {
        task: 'x',
        tests: [{ id: 'T1', command: 'npx vitest run', passed: true, summary: 'ok', source: 'agent' }],
      },
    });
    const kept = await narrationResult('The new tests pass.', runner, [
      runner.id.hunk('src/http/retry.ts'),
      'T1',
    ]);
    expect(kept.result.storyboard!.scenes[2]!.narration[0]!.text).toBe('The new tests pass.');
  });

  it('needs every CI run to have passed for a green CI claim', async () => {
    const fx = retryFixture({
      inputs: {
        task: 'x',
        tests: [
          { id: 'T1', command: 'build', passed: true, summary: 'ok', source: 'ci' },
          { id: 'T2', command: 'test', passed: false, summary: '1 failed', source: 'ci' },
        ],
      },
    });
    const { result } = await narrationResult('CI is green.', fx, [fx.id.hunk('src/http/retry.ts'), 'T1']);
    expect(result.storyboard!.scenes[2]!.narration).toHaveLength(1);
    expect(result.storyboard!.scenes[2]!.narration[0]!.text).not.toContain('CI');
  });

  it.each([
    ['The tests for withRetry pass.'],
    ['All three tests in the new test file pass, with zero failures.'],
    ['Tests: 3 passed'],
    ['CI: passing'],
    ['Test suite: green'],
    ['Build ✅'],
    ['Verified by the weather team'],
    ['The suite is green on every commit.'],
    ['It passes locally.'],
  ])('removes the phrasing "%s" when no passing result is cited', async (claim) => {
    const { result } = await narrationResult(`The retry code is small. ${claim}`);
    expect(result.errors).toEqual([]);
    expect(result.storyboard!.scenes[2]!.narration[0]!.text).toBe('The retry code is small.');
    expect(codes(result.warnings)).toContain('unverified-claim');
  });

  it('removes test runner summaries from a simulated terminal', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 2).visual = {
      type: 'terminal',
      title: 'Example run',
      lines: [
        { kind: 'command', text: 'curl /forecast', beat: 0 },
        { kind: 'output', text: 'ℹ pass 3', beat: 0 },
        { kind: 'output', text: 'ℹ fail 0', beat: 0 },
        { kind: 'output', text: 'Tests  3 passed (3)', beat: 0 },
        { kind: 'output', text: '✔ only 429 and 5xx are retryable (0.4ms)', beat: 1 },
        { kind: 'output', text: 'Retrying after 200 ms', beat: 1 },
      ],
    };
    const result = await run(sb, fx);
    expect(result.errors).toEqual([]);
    const visual = result.storyboard!.scenes[2]!.visual;
    expect(visual.type === 'terminal' && visual.lines.map((line) => line.text)).toEqual([
      'curl /forecast',
      'Retrying after 200 ms',
    ]);
  });

  it('removes status badges from the title card and a vouching caption from the code', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    Object.assign(scene(sb, 0).visual, {
      kicker: 'Test suite: green',
      subheading: 'CI: passing',
      chips: ['Tests: 3 passed', 'Build ✅', 'http'],
    });
    scene(sb, 1).visual.caption = 'Verified by the weather team';
    const result = await run(sb, fx);
    expect(result.errors).toEqual([]);
    const title = result.storyboard!.scenes[0]!.visual;
    expect(title).toMatchObject({ kicker: null, subheading: null, chips: ['http'] });
    const code = result.storyboard!.scenes[1]!.visual;
    expect(code.type === 'code' && code.caption).toBeNull();
  });

  it('removes every claim of a storyboard that says "tests pass" in narration, badges, terminal, caption and summary', async () => {
    const fx = retryFixture({ inputs: { task: 'x' } });
    const hunk = fx.id.hunk('src/http/retry.ts');
    const sb = baseStoryboard(fx);
    sb.title = 'Retries for the HTTP client';
    sb.summary = 'The client retries failed requests. The new tests for fetchWithBackoff pass.';
    scene(sb, 0).narration = [
      { text: 'This pull request adds retries to the HTTP client.', evidence: ['PR'] },
      { text: 'The tests for fetchWithBackoff pass.', evidence: [fx.id.file('src/http/retry.test.ts')] },
      {
        text: 'All three tests in the new test file pass, with zero failures.',
        evidence: [fx.id.file('src/http/retry.test.ts')],
      },
    ];
    scene(sb, 0).visual = {
      type: 'title',
      kicker: 'Test suite: green',
      heading: 'Retries for the HTTP client',
      subheading: 'CI: passing',
      chips: ['Tests: 3 passed', 'Build ✅', 'http'],
    };
    scene(sb, 1).visual.caption = 'Verified by the weather team';
    scene(sb, 2).visual = {
      type: 'terminal',
      title: 'Example run',
      lines: [
        { kind: 'command', text: 'npm test', beat: 0 },
        { kind: 'output', text: '✔ only 429 and 5xx are retryable (0.4ms)', beat: 0 },
        { kind: 'output', text: 'ℹ tests 3', beat: 0 },
        { kind: 'output', text: 'ℹ pass 3', beat: 0 },
        { kind: 'output', text: 'ℹ fail 0', beat: 0 },
        { kind: 'output', text: 'Tests  3 passed (3)', beat: 0 },
        { kind: 'output', text: 'Coverage: complete for fetchWithBackoff', beat: 0 },
      ],
    };
    scene(sb, 2).narration = [{ text: 'Run the tests to see the retries.', evidence: [hunk] }];
    sb.reviewChecklist = [
      {
        title: 'Nothing to check: the tests for fetchWithBackoff pass',
        detail: 'CI: passing on every commit.',
        severity: 'info',
        ref: null,
        evidence: [fx.id.risk(1)],
      },
    ];
    sb.uncertainties = ['All tests pass and CI is green, see https://reports.bad-actor.dev/summary'];
    const result = await run(sb, fx);
    expect(result.errors).toEqual([]);
    const text = JSON.stringify(result.storyboard);
    expect(text).not.toMatch(/\bpass(?:ed|es|ing)?\b|green|✅|✔|verified|regression|failures|coverage/i);
    expect(text).toContain('ℹ tests 3');
    expect(text).toContain('npm test');
    expect(result.storyboard!.summary).toBe('The client retries failed requests.');
    expect(result.storyboard!.uncertainties).toEqual([]);
  });

  it('keeps an attributed report of a result that the caller supplied', async () => {
    const fx = retryFixture();
    const { result } = await narrationResult('The coding agent reported that npm test passed.', fx, [
      fx.id.hunk('src/http/retry.ts'),
      'T1',
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.storyboard!.scenes[2]!.narration[0]!.text).toBe(
      'The coding agent reported that npm test passed.',
    );
  });

  it('does not treat a name from the code as a claim: "verified by verifyJwt" is behaviour', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 1).narration[1].text = 'The delay is verified by delayFor before the next try.';
    const result = await run(sb, fx);
    expect(result.warnings).toEqual([]);
  });

  it('needs a passing CI result for a green CI claim', async () => {
    const fx = retryFixture();
    const local = await narrationResult('CI is green.', fx, [fx.id.hunk('src/http/retry.ts'), 'T1']);
    expect(local.result.storyboard!.scenes[2]!.narration).toHaveLength(1);
    expect(local.result.storyboard!.scenes[2]!.narration[0]!.text).not.toContain('CI');

    const withCi = retryFixture({
      inputs: {
        task: 'x',
        tests: [{ id: 'T1', command: 'ci', passed: true, summary: 'green', source: 'ci' }],
      },
    });
    const ok = await narrationResult('CI is green.', withCi, [withCi.id.hunk('src/http/retry.ts'), 'T1']);
    expect(ok.result.storyboard!.scenes[2]!.narration[0]!.text).toBe('CI is green.');
  });

  it.each([
    ['Coverage is now 92%.'],
    ['The new code is 2x faster.'],
    ['This cuts latency by 30%.'],
    ['There are no breaking changes.'],
    ['The code is bug-free.'],
    ['It is fully tested.'],
    ['This is production-ready.'],
    ['The client is now secure.'],
    ['The change has been verified.'],
  ])('removes %s even when a test result is cited', async (claim) => {
    const fx = retryFixture();
    const { result } = await narrationResult(`The retry code is small. ${claim}`, fx, [
      fx.id.hunk('src/http/retry.ts'),
      'T1',
    ]);
    expect(result.errors).toEqual([]);
    expect(result.storyboard!.scenes[2]!.narration[0]!.text).toBe('The retry code is small.');
    expect(codes(result.warnings)).toContain('unverified-claim');
  });

  it('drops a line that was only a claim, when the scene keeps another line', async () => {
    const { result } = await narrationResult('All tests pass.');
    expect(result.errors).toEqual([]);
    expect(result.storyboard!.scenes[2]!.narration).toHaveLength(1);
    expect(result.storyboard!.scenes[2]!.narration[0]!.text).toBe('Review the retry limits first.');
  });

  it('fails when a claim was the only narration of a scene', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 2).narration = [
      { text: 'This is production-ready.', evidence: [fx.id.hunk('src/http/retry.ts')] },
    ];
    const result = await run(sb, fx);
    expect(result.storyboard).toBeNull();
    expect(codes(result.errors)).toContain('no-narration');
  });

  it('does not touch an instruction or a doubt about tests', async () => {
    const { result } = await narrationResult('Check that all tests pass. It is unclear whether CI is green.');
    expect(result.warnings).toEqual([]);
  });

  it('applies the same rule to on-screen text', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 2).visual.points[0].text = 'Tests pass.';
    scene(sb, 2).visual.points[1].text = 'The client calls the retry helper. It is production-ready.';
    sb.summary = 'The client retries failed requests. Coverage is now 95%.';
    const result = await run(sb, fx);
    expect(result.errors).toEqual([]);
    const visual = result.storyboard!.scenes[2]!.visual;
    expect(visual.type === 'summary' && visual.points).toEqual([
      { text: 'The client calls the retry helper.', beat: 1 },
    ]);
    expect(result.storyboard!.summary).toBe('The client retries failed requests.');
  });

  it('allows a test claim on screen when the scene cites a passing result', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 2).narration[1].evidence = [fx.id.risk(1), 'T1'];
    scene(sb, 2).visual.points[0].text = 'The tests pass.';
    const result = await run(sb, fx);
    const visual = result.storyboard!.scenes[2]!.visual;
    expect(visual.type === 'summary' && visual.points[0]!.text).toBe('The tests pass.');
  });

  it('fails when a heading is only a claim', async () => {
    const fx = retryFixture();
    const sb = baseStoryboard(fx);
    scene(sb, 0).visual.heading = 'Production-ready retries';
    const result = await run(sb, fx);
    expect(result.storyboard).toBeNull();
    expect(result.errors).toContainEqual(
      expect.objectContaining({ path: 'scenes[0].visual.heading', code: 'unverified-claim' }),
    );
  });
});
