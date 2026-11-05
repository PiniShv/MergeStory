import { describe, expect, it } from 'vitest';
import type { TestEvidence } from '../core/types.ts';
import { backingHint, claimIsSupported, findClaim, looksLikeTestRun } from './claims.ts';

const kindOf = (sentence: string) => findClaim(sentence)?.kind ?? null;

const result = (
  id: string,
  command: string,
  passed: boolean,
  source: TestEvidence['source'] = 'agent',
): TestEvidence => ({ id, command, passed, summary: '', source });

describe('findClaim: passing tests', () => {
  it.each([
    'All tests pass.',
    'The unit tests pass.',
    'Tests pass',
    'The tests for withRetry pass.',
    'The new tests for withRetry pass.',
    'All three tests in the new test file pass, with zero failures.',
    'The test suite for the client passes cleanly.',
    'The tests ran successfully.',
    'The tests came back green.',
    'The tests remain green.',
    'The new tests pass locally and on CI.',
    'This passes locally.',
    'Tests: 3 passed',
    'Tests  3 passed (3)',
    'Tests: 3 passed, 3 total',
    'Test suite: green',
    'TEST SUITE: GREEN',
    'Tests: OK',
    'Tests ✅',
    '✔ all tests',
    'The suite is green on every commit.',
    'The new tests all pass.',
    'Every test passes.',
    '12/12 passing',
    'The pass rate is 100%.',
    'Test results: all passed',
    'Nothing to check: the tests for withRetry pass',
    'Note: all tests pass.',
    'Note that all tests pass.',
    'Check: all tests pass.',
  ])('"%s" claims that tests pass', (sentence) => {
    expect(kindOf(sentence)).toBe('tests-pass');
  });

  it.each([
    'ℹ pass 3',
    'ℹ fail 0',
    '3 passed, 0 failed',
    'Failures: 0',
    '0 failed',
    'no failing tests',
    'Passed: 3',
    'test result: ok. 3 passed; 0 failed',
    '✔ only 429 and 5xx are retryable (0.4ms)',
    '✓ backoff never exceeds the cap (12 ms)',
    'ok 1 - only 429 is retried',
    'ok  \tgithub.com/example/weather\t0.012s',
    'PASS src/retry.test.ts',
    '[PASS] retry_test',
    'PASS',
  ])('"%s" is a line of test runner output', (line) => {
    expect(kindOf(line)).toBe('tests-pass');
  });

  it.each([
    'Check that all tests pass.',
    'Make sure the tests pass.',
    'It is unclear whether the tests pass.',
    'The change does not show whether CI is green.',
    'The tests might pass once the fix lands.',
    'If CI is green, we merge.',
    'The tests do not pass.',
    'The tests did not pass.',
    "The tests don't pass.",
    'The tests that were not run pass.',
    'The tests fail unless they pass.',
    'npm test did not pass.',
    'Test the retry loop with a failing server.',
    'Tests were added in retry.test.ts.',
    'The tests for withRetry check the delay.',
    'The tests cover the delay and the cap.',
    'Test coverage is not shown.',
    'A 400 or 404 fails at once.',
    'The function returns early when the status is below 500.',
    'Failed responses now pass their Retry-After value along in the error.',
    'The pipeline passes the data on to the next stage.',
    'The middleware passes the check result along.',
    'The tests pass a mock client to the retry function.',
    'Your password must contain eight characters.',
    'Pass the options object to the helper.',
  ])('"%s" is not a claim', (sentence) => {
    expect(findClaim(sentence)).toBeNull();
  });

  it('does not take a label for an instruction: "Note:" and "Test suite:" start a claim, "Test the loop" does not', () => {
    expect(kindOf('Test suite: green')).toBe('tests-pass');
    expect(kindOf('Test the retry loop.')).toBeNull();
    expect(kindOf('Check: all tests pass.')).toBe('tests-pass');
    expect(kindOf('Check that all tests pass.')).toBeNull();
  });

  it('reports the words that triggered the match', () => {
    expect(findClaim('The tests for withRetry pass.')?.match).toBe('tests for withRetry pass');
    expect(findClaim('Tests: 3 passed')?.match).toBe('Tests: 3 passed');
  });
});

describe('findClaim: a doubt word covers only its own clause', () => {
  it('flags the claim next to a clause that only holds the doubt', () => {
    expect(kindOf('All tests pass, whether or not CI runs.')).toBe('tests-pass');
    expect(kindOf('Tests pass; CI might be slow.')).toBe('tests-pass');
    expect(kindOf('The tests might pass, but CI is green.')).toBe('ci-green');
  });

  it('lets a claim through when the doubt is in its own clause', () => {
    expect(kindOf('The tests might pass once the fix lands.')).toBeNull();
    expect(kindOf('If CI is green, we merge.')).toBeNull();
    expect(kindOf('We cannot say whether the tests pass, and that is fine.')).toBeNull();
  });
});

describe('findClaim: green CI', () => {
  it.each([
    'CI is green.',
    'CI: passing',
    'CI: passing on every commit.',
    'Build ✅',
    'Build: green',
    'Build: OK',
    'Pipeline: ✔',
    '✅ checks',
    'Checks: passing',
    'All checks passed',
    'Checks pass.',
    'The merge checks are green.',
    'The change passes all checks.',
    'The change passes every required check.',
    'The PR is green.',
    'Everything is green.',
    'BUILD SUCCESS',
    'The CI jobs pass.',
    'The workflow succeeded.',
    'The build went green.',
    'It passes in CI.',
    'All green.',
  ])('"%s" claims a green CI run', (sentence) => {
    expect(kindOf(sentence)).toBe('ci-green');
  });

  it('does not take a build step for a result', () => {
    expect(findClaim('The build step copies the files.')).toBeNull();
    expect(findClaim('The pipeline passes the data on to the next stage.')).toBeNull();
  });
});

describe('findClaim: vouching', () => {
  it.each([
    'Verified by the weather team',
    'The change is verified by the weather team.',
    'Verified by QA',
    'This was verified by hand.',
    'QA verified the fix.',
    'The change has been verified.',
  ])('"%s" is a claim of verification', (sentence) => {
    expect(kindOf(sentence)).toBe('verified');
  });

  it.each([
    'The token is verified by verifyJwt before the handler runs.',
    'The password is verified by bcrypt.compare.',
    'The signature is verified by check_signature().',
  ])('"%s" describes what the code does', (sentence) => {
    expect(findClaim(sentence)).toBeNull();
  });
});

describe('findClaim: other kinds', () => {
  it.each([
    ['Coverage: complete for the retry helper', 'coverage'],
    ['Coverage is now 92%.', 'coverage'],
    ['Zero regressions.', 'no-breaking'],
    ['No regressions.', 'no-breaking'],
    ['Safe to deploy today', 'production-ready'],
    ['The new code is 2x faster.', 'performance'],
    ['The code is bug-free.', 'bug-free'],
  ])('"%s" is a claim of kind %s', (sentence, kind) => {
    expect(kindOf(sentence)).toBe(kind);
  });

  it('leaves "safe to retry" alone: that is about the code', () => {
    expect(findClaim('Retrying a request is only safe to do because of the attempt limit.')).toBeNull();
  });
});

describe('looksLikeTestRun', () => {
  it.each([
    'npm test',
    'npm run test:unit',
    'npm run test -- --watch=false',
    'pnpm -r test',
    'yarn test',
    'npx vitest run',
    'vitest',
    'jest --coverage',
    'pytest -q',
    'python -m pytest tests/',
    'python3 -m unittest discover',
    'go test ./...',
    'cargo test',
    'dotnet test',
    'mvn test',
    './gradlew test',
    'node --test',
    'make test',
    'bundle exec rspec',
    './scripts/run_tests.sh',
    'npm run lint && npm test',
    './node_modules/.bin/mocha',
    'C:\\proj\\node_modules\\.bin\\jest',
  ])('"%s" runs tests', (command) => {
    expect(looksLikeTestRun(command)).toBe(true);
  });

  it.each([
    'npm run lint',
    'npm run typecheck',
    'npm run build',
    'tsc --noEmit',
    'biome check .',
    'make verify',
    'npm run check',
    'eslint .',
    'latest build',
    'git diff --stat',
  ])('"%s" does not run tests', (command) => {
    expect(looksLikeTestRun(command)).toBe(false);
  });
});

describe('claimIsSupported', () => {
  const testsClaim = { kind: 'tests-pass', match: 'tests pass' } as const;
  const ciClaim = { kind: 'ci-green', match: 'CI is green' } as const;

  it('backs a test claim with a cited, passing run of tests', () => {
    const tests = [result('T1', 'npm test', true)];
    expect(claimIsSupported(testsClaim, ['T1'], tests)).toBe(true);
    expect(claimIsSupported(testsClaim, ['F1'], tests)).toBe(false);
    expect(claimIsSupported(testsClaim, [], tests)).toBe(false);
    expect(claimIsSupported(testsClaim, ['T1'], [])).toBe(false);
  });

  it('does not accept a cited run that is not a run of tests', () => {
    const tests = [result('T1', 'npm run lint', true), result('T2', 'npm test', true)];
    expect(claimIsSupported(testsClaim, ['T1'], tests)).toBe(false);
    expect(claimIsSupported(testsClaim, ['T1', 'T2'], tests)).toBe(true);
  });

  it('never backs a claim of passing tests while any reported run did not pass', () => {
    const tests = [result('T1', 'npm test', true), result('T2', 'npm run lint', false)];
    expect(claimIsSupported(testsClaim, ['T1'], tests)).toBe(false);
    expect(claimIsSupported(testsClaim, ['T1', 'T2'], tests)).toBe(false);
    expect(claimIsSupported(testsClaim, ['T2'], tests)).toBe(false);
  });

  it('backs a green CI claim with a cited, passing run that CI reported, when every CI run passed', () => {
    const passed = [result('T1', 'build', true, 'ci'), result('T2', 'npm test', false, 'agent')];
    expect(claimIsSupported(ciClaim, ['T1'], passed)).toBe(true);
    expect(claimIsSupported(ciClaim, ['T2'], passed)).toBe(false);
    const mixed = [result('T1', 'build', true, 'ci'), result('T2', 'test', false, 'ci')];
    expect(claimIsSupported(ciClaim, ['T1'], mixed)).toBe(false);
    expect(claimIsSupported(ciClaim, ['T1'], [result('T1', 'npm test', true, 'agent')])).toBe(false);
  });

  it('never backs another kind of claim', () => {
    const tests = [result('T1', 'npm test', true)];
    for (const kind of ['coverage', 'performance', 'verified', 'secure'] as const) {
      expect(claimIsSupported({ kind, match: '' }, ['T1'], tests)).toBe(false);
    }
  });
});

describe('backingHint', () => {
  it('names the runs that did not pass', () => {
    const tests = [result('T1', 'npm test', true), result('T2', 'npm run e2e', false)];
    expect(backingHint({ kind: 'tests-pass', match: '' }, tests)).toContain('T2');
    expect(backingHint({ kind: 'tests-pass', match: '' }, tests)).toContain('say which run did not pass');
  });

  it('asks for a cited run when nothing failed', () => {
    expect(backingHint({ kind: 'tests-pass', match: '' }, [])).toContain('Cite a passing test run');
    expect(backingHint({ kind: 'ci-green', match: '' }, [])).toContain('reported');
  });

  it('says that other claims cannot be checked', () => {
    expect(backingHint({ kind: 'coverage', match: '' }, [])).toContain('cannot check');
  });
});

describe('findClaim: an order does not hide a claim in the same sentence', () => {
  it.each([
    ['Run the suite and all tests pass.', 'tests-pass'],
    ['Review complete: all tests pass.', 'tests-pass'],
    ['Check the logs: all tests pass.', 'tests-pass'],
    ['All 12 tests pass even if the network is down.', 'tests-pass'],
    ['Latency drops from 200ms to 20ms.', 'performance'],
    ['The p95 response time falls from 1.2 seconds to 300ms.', 'performance'],
    ['This speeds up the build from 10 minutes to 2 minutes.', 'performance'],
  ])('"%s" is a claim', (sentence, kind) => {
    expect(kindOf(sentence)).toBe(kind);
  });

  it.each([
    'The retry delay goes from 1s to 30s.',
    'The timeout changes from 30 seconds to 60 seconds.',
    'Polling moves from 500ms to 2s.',
  ])('"%s" describes a setting, not a speed claim', (sentence) => {
    expect(kindOf(sentence)).toBeNull();
  });

  it.each([
    'Check that the linter and all tests pass.',
    'Confirm the migration runs and all tests pass.',
    'Make sure lint, typecheck and all tests pass.',
    'Verify the build and the CI is green.',
  ])('"%s" is one order to check, not a claim', (sentence) => {
    expect(kindOf(sentence)).toBeNull();
  });

  it('still lets an order and a condition through', () => {
    expect(kindOf('Run the suite to see whether all tests pass.')).toBeNull();
    expect(kindOf('Check that all tests pass.')).toBeNull();
    expect(kindOf('The tests pass if the cache is warm.')).toBeNull();
  });
});

describe('findClaim: a workflow that holds only under a condition', () => {
  it.each([
    'The workflow runs successfully against the repo.',
    'The pipeline succeeds when the token is present.',
    'The build passes only when the cache is warm.',
  ])('"%s" is a description', (sentence) => {
    expect(kindOf(sentence)).toBeNull();
  });
});
