/**
 * Detection of claims that a diff cannot prove: passing tests, green CI, coverage numbers,
 * performance figures, "no breaking changes", "bug-free", "fully tested", "production-ready",
 * "secure" and "verified". MergeStory never runs tests, so such a claim may only appear when the
 * caller reported a matching passing result and the narration cites it.
 */
import type { TestEvidence } from '../core/types.ts';

export type ClaimKind =
  | 'tests-pass'
  | 'ci-green'
  | 'coverage'
  | 'performance'
  | 'no-breaking'
  | 'bug-free'
  | 'fully-tested'
  | 'production-ready'
  | 'secure'
  | 'verified';

export interface Claim {
  kind: ClaimKind;
  /** The words that triggered the match. */
  match: string;
}

const TEST_SUBJECT = '(?:tests?|test suites?|test cases?|test files?|test runs?|suites?|specs?)';
const CI_SUBJECT = '(?:ci|continuous integration|pipelines?|builds?|workflows?|github actions)';
const AUX = String.raw`(?:(?:all|both|now|still|also|already|are|is|were|was|have|has|had|been|will|should|do|does|did|can|went|turned|looks?|stays?|stayed|remains?|remained|came|back|keeps?|kept|run|ran|runs|jobs?|finished|completed)\s+)*`;
/** "tests pass", but not "tests pass a mock client to the helper": there "pass" is a verb with an object. */
const OBJECT_WORD = String.raw`(?:a|an|the|their|its|our|this|that|these|those|some|each|any|no|it|them)`;
const PASS_WORD = String.raw`(?:pass(?:es|ed|ing)?(?!\s+${OBJECT_WORD}\b)|succeed(?:s|ed|ing)?|green|successful(?:ly)?)`;
/** "pass" used as a result, not as a verb with an object ("the pipeline passes the data on"). */
const PASS_END = String.raw`(?=\s*(?:[.,;:!?()]|$)|\s(?:all|every|successfully|cleanly|again|now|on|in|for|with|without|before|after|and|but|too|as|so|once|locally|here|today)\b)`;
const PASS_RESULT = `pass(?:es|ed)?${PASS_END}`;
/** A separator between a label and its result: "CI: passing", "Tests - green", or just a space. */
const LABEL_OR_SPACE = String.raw`(?:\s*[:=\-–—]+\s*|\s+)`;
/** What a status badge says after the label. */
const BADGE_OK = String.raw`(?:all\s+)?(?:pass(?:es|ed|ing)?|green|ok|okay|successful|success|clean)\b`;
const MARK = String.raw`[✅✔✓☑🟢]\uFE0F?`;

/**
 * A few words between a test subject and the result ("the tests for withRetry pass", "all three
 * tests in the new file pass"). A word of denial or doubt ends the search: "the tests that were not
 * run pass" is not a claim, and neither is "the tests fail unless they pass".
 */
const STOP_WORD = String.raw`(?:not|no|never|neither|nor|cannot|without|except|unless|whether|if|until|fail(?:s|ed|ing|ure|ures)?|\w*n['’]t)`;
const GAP_WORD = String.raw`(?!${STOP_WORD}\b)(?:[^\s.!?;]|\.(?=\w))+`;
const GAP = String.raw`(?:\s+${GAP_WORD}){1,8}?`;
const GAP_RESULT = `(?:pass(?:es|ed|ing)?|succeed(?:s|ed)?|green|successful(?:ly)?|clean(?:ly)?)${PASS_END}`;

/** Words that make the next one a thing and not an order: "Test suite: green" is a label, "Test the loop" is not. */
const TEST_AS_NOUN = String.raw`(?:suites?|cases?|runs?|results?|files?|coverage|output|report|status)`;

const RULES: { kind: ClaimKind; patterns: RegExp[] }[] = [
  {
    kind: 'tests-pass',
    patterns: [
      // "tests pass", "tests: 3 passed", "test suite: green", "all tests are passing".
      new RegExp(String.raw`\b${TEST_SUBJECT}${LABEL_OR_SPACE}${AUX}(?:\d+\s+)?${PASS_WORD}\b`, 'i'),
      // "the tests for withRetry pass", "all three tests in the new file pass".
      new RegExp(String.raw`\b${TEST_SUBJECT}\b${GAP}\s+${GAP_RESULT}`, 'i'),
      // "tests: OK", "test suite - clean".
      new RegExp(String.raw`\b${TEST_SUBJECT}\s*[:=\-–—]+\s*${BADGE_OK}`, 'i'),
      // "Tests ✅", "✔ all tests".
      new RegExp(String.raw`\b${TEST_SUBJECT}\s*(?:[:=\-–—]\s*)?${MARK}`, 'iu'),
      new RegExp(String.raw`${MARK}\s*(?:all\s+)?${TEST_SUBJECT}\b`, 'iu'),
      /\b(?:pass(?:es|ed|ing)?|green)\s+(?:all\s+|every\s+|the\s+|our\s+)?(?:(?:unit|integration|e2e|existing|new|current|relevant|automated)\s+)*(?:tests?|test suites?|suites?|specs?)\b(?!\s+(?:config|data|fixtures?|names?|files?|paths?|runner|helper|setup|options?|args?|arguments?|parameters?)\b)/i,
      /\bpass(?:es|ed)?\s+locally\b/i,
      /\bpass(?:ing)?\s+rate\b/i,
      // "no failing tests", "zero failures", "0 failed", "fail 0", "Failures: 0".
      /\b(?:no|zero|0|without(?:\s+any)?)\s+(?:test\s+|tests\s+)?(?:failures?|failing(?:\s+tests?)?|failed(?:\s+tests?)?)\b/i,
      /\b(?:fail(?:ed|ures?|ing)?)\s*[:=]?\s*0\b/i,
      // Test runner output: "3 passed", "42 passing", "pass 3", "Passed: 3", "test result: ok".
      /\b\d+\s+(?:tests?\s+|specs?\s+|checks?\s+|test\s+(?:cases|files|suites)\s+)?(?:passed|passing)\b(?!\s+(?:the|a|an|its|their|this|that|these|those)\b)/i,
      /^\W*pass(?:es)?\s+\d+\W*$/i,
      /\b(?:passed|passing)\s*[:=]\s*\d+\b/i,
      /\btest result:\s*ok\b/i,
      // One line of a test report: a check mark and a timing, "ok 1 - name", "PASS src/a.test.ts".
      /^\s*[✔✓√✅]\uFE0F?\s+\S.*\(\s*\d+(?:\.\d+)?\s?(?:ms|s)\s*\)\s*$/iu,
      /^\s*ok\s+\d+\s+-\s+.*$/i,
      /^\s*ok\s+\S+\s+\d+(?:\.\d+)?s\b.*$/i,
      /^\W*PASS(?:ED)?\b\W*(?:\S.*)?$/,
    ],
  },
  {
    kind: 'ci-green',
    patterns: [
      new RegExp(
        String.raw`\b${CI_SUBJECT}${LABEL_OR_SPACE}${AUX}(?:green|passing|succeed(?:s|ed)?|successful(?:ly)?|success|clean|${PASS_RESULT})`,
        'i',
      ),
      new RegExp(String.raw`\b(?:${CI_SUBJECT}|checks?|status)\s*[:=\-–—]+\s*${BADGE_OK}`, 'i'),
      new RegExp(
        String.raw`\b(?:(?:all|the|required|status|ci|automated)\s+checks?|checks)\s+(?:(?:are|is|were|now|still|all|have|has|been)\s+)*(?:green|passing|successful|${PASS_RESULT})`,
        'i',
      ),
      // "Build ✅", "CI: ✔", "✅ checks".
      new RegExp(String.raw`\b(?:${CI_SUBJECT}|checks?)\s*(?:[:=\-–—]\s*)?${MARK}`, 'iu'),
      new RegExp(String.raw`${MARK}\s*(?:all\s+)?(?:${CI_SUBJECT}|checks?)\b`, 'iu'),
      /\b(?:green\s+(?:ci|build|pipeline|checks?|status)|all\s+green)\b/i,
      /\b(?:pr|pull request|merge request|branch|everything)\s+(?:is|are|was|looks?)\s+(?:all\s+)?green\b/i,
      /\bpass(?:es|ed|ing)\s+(?:(?:all|every)\s+(?:the\s+)?|the\s+(?=(?:required|status|ci|automated)\s+))(?:(?:required|status|ci|automated)\s+)?checks?\b/i,
      /\bpass(?:es|ed|ing)\s+(?:the\s+)?(?:ci|continuous integration|ci checks|pipeline|build|lint(?:ing)?|type[- ]?check(?:s|ing)?)\b(?!\s+(?:target|config|flags?|args?|options?|directory|dir|path|output|step|script|tool)\b)/i,
      /\bpass(?:es|ed)?\s+(?:on|in)\s+(?:ci|the\s+pipeline|github\s+actions)\b/i,
    ],
  },
  {
    kind: 'coverage',
    patterns: [
      /\b\d+(?:\.\d+)?\s*%\s*(?:of\s+)?(?:(?:test|code|line|branch|statement|unit)\s+)*(?:coverage|covered)\b/i,
      /\b(?:test\s+|code\s+|line\s+|branch\s+)?coverage\b[^.!?]{0,40}?\b\d+(?:\.\d+)?\s*%/i,
      /\b(?:full|complete|100\s*%|total)\s+(?:test\s+|code\s+)?coverage\b/i,
      /\bcoverage\s*[:=\-–—]\s*(?:full|complete|total|100\s*%)/i,
      /\bcoverage\s+(?:has\s+|now\s+)*(?:improved|increased|rose|rises|grew|went\s+up|goes\s+up|is\s+(?:now\s+)?(?:high|higher|complete|full|better))\b/i,
    ],
  },
  {
    kind: 'performance',
    patterns: [
      /\b\d+(?:\.\d+)?\s*(?:x|×|times)\s+(?:as\s+)?(?:faster|slower|quicker|smaller|larger|bigger|more|less|fewer|cheaper|lighter|speed[- ]?ups?|improvements?|better)\b/i,
      /\b\d+(?:\.\d+)?\s*%\s*(?:faster|slower|quicker|smaller|larger|bigger|more|less|fewer|cheaper|lighter|better|lower|higher|improvement|reduction|savings?|speed[- ]?ups?|decrease|increase|drop|gain|boost)\b/i,
      /\b(?:twice|thrice|double|triple|half)\s+(?:as\s+)?(?:fast|slow|many|much|small|large|big|quick)\b/i,
      /\b(?:doubles?|triples?|halves|quadruples?)\s+(?:the\s+)?(?:speed|throughput|performance|latency|memory|capacity)\b/i,
      /\b(?:reduces?|cuts?|lowers?|improves?|increases?|speeds?\s+up|decreases?|shrinks?|boosts?|slashes)\b[^.!?]{0,40}\bby\s+(?:about\s+|around\s+|roughly\s+|nearly\s+|almost\s+|up\s+to\s+|over\s+|more\s+than\s+)?\d+(?:\.\d+)?\s*(?:%|percent|x\b|×|times\b|fold\b|ms\b|milliseconds?\b|seconds?\b|s\b)/i,
      /\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?|seconds?|µs)\s+(?:faster|slower|quicker|sooner|earlier)\b/i,
      // "Latency drops from 200ms to 20ms". A setting that changes ("the timeout goes from 30s to 60s") is a
      // fact about the diff, so a speed word must come first.
      /\b(?:latenc(?:y|ies)|response\s+times?|load(?:ing)?\s+times?|render(?:ing)?\s+times?|build\s+times?|run\s*times?|start[- ]?up(?:\s+times?)?|boot\s+times?|query\s+times?|execution\s+times?|p(?:50|90|95|99)|speeds?\s+up|faster|quicker|slower)\b[^.!?]{0,60}?\bfrom\s+\d+(?:\.\d+)?\s*(?:ms|milliseconds?|seconds?|minutes?|µs|s)\s+to\s+\d+(?:\.\d+)?\s*(?:ms|milliseconds?|seconds?|minutes?|µs|s)\b/i,
      /\borders?\s+of\s+magnitude\b/i,
      /\bbenchmarks?\b[^.!?]{0,40}\b(?:show(?:s|ed)?|prove(?:s|d)?|confirm(?:s|ed)?|indicate(?:s|d)?|demonstrate(?:s|d)?|reveal(?:s|ed)?)\b/i,
      /\bin\s+(?:our|my|the)\s+benchmarks?\b/i,
      /\bbenchmark(?:s|ed)?\s+(?:results?|numbers?|figures?)\b/i,
    ],
  },
  {
    kind: 'no-breaking',
    patterns: [
      /\bno\s+(?:breaking|backwards?[- ]incompatible)\s+changes?\b/i,
      /\bnon[- ]breaking\b/i,
      /\b(?:is|are|stays?|remains?|fully|completely|entirely|100\s*%|totally|be|being)\s+(?:fully\s+|completely\s+|entirely\s+|100\s*%\s+)?backwards?[- ]compatible\b/i,
      /\b(?:does\s*n[o']t|do\s*n[o']t|will\s+not|won'?t|never)\s+break\s+(?:anything|existing|any|the\s+existing|current|backwards?)/i,
      /\b(?:no|zero)\s+regressions?\b/i,
      /\bwithout\s+breaking\s+(?:anything|existing|any|the\s+existing|current|backwards?)/i,
    ],
  },
  {
    kind: 'bug-free',
    patterns: [
      /\b(?:bug|error|defect|issue|glitch)[- ]free\b/i,
      /\b(?:zero|no)\s+(?:known\s+|remaining\s+|outstanding\s+)?(?:bugs?|defects?)\b/i,
      /\bworks?\s+(?:perfectly|flawlessly)\b/i,
      /\bflawless(?:ly)?\b/i,
      /\bwithout\s+(?:any\s+)?(?:bugs?|defects?)\b/i,
    ],
  },
  {
    kind: 'fully-tested',
    patterns: [
      /\b(?:fully|thoroughly|extensively|heavily|well|rigorously|exhaustively|battle|comprehensively)[- ]tested\b/i,
      /\bcomprehensive(?:ly)?\s+test(?:s|ed|ing)\b/i,
      /\b(?:full|complete|extensive|thorough)\s+test(?:ing)?\s+coverage\b/i,
      /\b(?:all|every)\s+(?:code\s+)?(?:paths?|branches?|cases?|edge\s+cases?)\s+(?:are\s+|is\s+)?(?:tested|covered)\b/i,
    ],
  },
  {
    kind: 'production-ready',
    patterns: [
      /\bproduction[- ]?(?:ready|grade|quality)\b/i,
      /\bready\s+(?:for|to)\s+(?:production|ship|deploy|merge|release|launch)\b/i,
      /\bsafe\s+to\s+(?:deploy|merge|ship|release|launch)\b/i,
      /\benterprise[- ]grade\b/i,
    ],
  },
  {
    kind: 'secure',
    patterns: [
      /\bvulnerability[- ]free\b/i,
      /\b(?:exploit|hack|tamper|attack)[- ]proof\b/i,
      /\bunhackable\b/i,
      /\bno\s+(?:known\s+|remaining\s+)?(?:security\s+)?(?:vulnerabilit(?:y|ies)|exploits?)\b/i,
      /\b(?:is|are|was|were|now|fully|completely|entirely|totally|be|being|stays?|remains?|makes?\s+(?:it|this|them|the\s+\w+))\s+(?:now\s+)?(?:fully\s+|completely\s+|entirely\s+|totally\s+|much\s+|more\s+|very\s+)?secure\b/i,
      /\bsecure\s+(?:by\s+design|against)\b/i,
    ],
  },
  {
    kind: 'verified',
    patterns: [
      /\b(?:fully|independently|manually|thoroughly|extensively|carefully|already)\s+verified\b/i,
      /\bverified\s+(?:to\s+work|working|correct(?:ness)?|by\s+(?:the\s+)?(?:tests?|ci|reviewers?|team|us|hand|running)|that\s+(?:it|this|the|everything|all))\b/i,
      // "Verified by the platform team": anyone vouching for the change. A name from the code
      // ("verified by verifyJwt", "verified by bcrypt.compare") is behaviour, not a claim, so it is let through.
      /\b(?:[Vv]erified|VERIFIED)\s+by\b(?!\s+(?:(?:the|The|a|an|our|this)\s+)?\S*(?:[a-z][A-Z]|_|\(|\w\.\w))/,
      /\b(?:has|have|had)\s+been\s+verified\b/i,
      /\bwe(?:'ve|\s+have)?\s+verified\b/i,
      /\b(?:qa|reviewers?|testers?|engineers?|maintainers?|owners?|humans?)\s+(?:has\s+|have\s+|also\s+|already\s+)?verified\b/i,
      /\btested\s+(?:and|&)\s+verified\b/i,
      /\bverified\s+(?:and\s+)?(?:tested|working)\b/i,
      /\bverified\s+(?:change|fix|build|behaviou?r|implementation)\b/i,
    ],
  },
];

/** Plain-language names used in messages. */
export const CLAIM_LABELS: Record<ClaimKind, string> = {
  'tests-pass': 'passing tests',
  'ci-green': 'a green CI run',
  coverage: 'test coverage',
  performance: 'a performance figure',
  'no-breaking': 'no breaking changes',
  'bug-free': 'bug-free code',
  'fully-tested': 'full testing',
  'production-ready': 'production readiness',
  secure: 'security',
  verified: 'verification',
};

/** Sentences that tell the reader to do something assert nothing. */
const NON_ASSERTIVE_START = new RegExp(
  String.raw`^(?:please\s+)?(?:check|confirm|ensure|make\s+sure|verify|validate|run|see|look|ask|decide|consider|review|test(?!\s+${TEST_AS_NOUN}\b)|try|watch|inspect|read|assert|expect)\b(?!\s*:)`,
  'i',
);
/**
 * An order to check something. Its object can run on past "and" and ",": "Check that the linter and
 * all tests pass" is one order, and it asserts nothing.
 */
const CHECK_START =
  /^(?:please\s+)?(?:check|verify|confirm|ensure|make\s+sure|validate|see\s+whether)\b(?!\s*:)/i;
/** Words of doubt or condition. They exempt a claim only when they stand in the same clause as the claim. "Even if" concedes a point and keeps the claim. */
const HEDGE =
  /\b(?:whether|(?<!even\s)if|unless|might|could|unclear|unknown|not\s+(?:clear|known|shown|verified|confirmed|reported)|no\s+evidence|cannot\s+(?:tell|say|confirm)|can(?:'|’)?t\s+(?:tell|say|confirm))\b/i;
/** Where one clause ends and the next begins: "Tests pass, whether or not CI runs" has two. */
const CLAUSE_BREAK = /[;,]|\b(?:but|although|though|while|yet)\b/gi;
/** Where an order ends: "Run the suite and all tests pass" gives an order, then a statement. */
const ORDER_BREAK = /[;,:]|\b(?:and|but|although|though|while|yet)\b/gi;
/** Where an order to check something ends: only a stop, a colon or a contrast. */
const CHECK_BREAK = /[;:]|\b(?:but|although|though|while|yet)\b/gi;
/** A CI result that holds only under a condition, as in a description of a workflow: "succeeds when the token is set". */
const CONDITION_AFTER = /^\s+(?:only\s+)?(?:when|whenever|against)\b/i;

/** The part of the sentence between the clause breaks around [start, end). */
function clauseAround(text: string, start: number, end: number, breaks: RegExp = CLAUSE_BREAK): string {
  let from = 0;
  let to = text.length;
  for (const brk of text.matchAll(breaks)) {
    const at = brk.index;
    if (at + brk[0].length <= start) from = at + brk[0].length;
    else if (at >= end) {
      to = at;
      break;
    }
  }
  return text.slice(from, to);
}

const GLOBAL_PATTERNS = new WeakMap<RegExp, RegExp>();
function globally(pattern: RegExp): RegExp {
  let copy = GLOBAL_PATTERNS.get(pattern);
  if (!copy) {
    copy = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    GLOBAL_PATTERNS.set(pattern, copy);
  }
  return copy;
}

/**
 * The first unverifiable claim in a sentence, or null. A word of doubt ("whether", "if", "might")
 * exempts only the claim in its own clause: "The tests might pass once the fix lands" is no claim,
 * "All tests pass, whether or not CI runs" is.
 */
export function findClaim(sentence: string): Claim | null {
  const text = sentence.trim();
  if (!text) return null;
  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      for (const match of text.matchAll(globally(pattern))) {
        const end = match.index + match[0].length;
        if (NON_ASSERTIVE_START.test(clauseAround(text, match.index, end, ORDER_BREAK).trim())) continue;
        if (CHECK_START.test(clauseAround(text, match.index, end, CHECK_BREAK).trim())) continue;
        if (HEDGE.test(clauseAround(text, match.index, end))) continue;
        if (rule.kind === 'ci-green' && CONDITION_AFTER.test(text.slice(end))) continue;
        return { kind: rule.kind, match: match[0] };
      }
    }
  }
  return null;
}

/** Words of a command that name a test runner. */
const TEST_RUNNERS = new Set([
  'pytest',
  'py.test',
  'jest',
  'vitest',
  'mocha',
  'jasmine',
  'karma',
  'rspec',
  'phpunit',
  'ctest',
  'nosetests',
  'unittest',
  'tox',
  'playwright',
  'cypress',
  'bats',
  'ava',
]);
/** "test", "tests", "test:unit", "unit:test", "run_tests.sh", "--test": a script, a subcommand or a flag that runs tests. */
const TEST_WORD = /(?:^|[_:-])(?:tests?|specs?)(?:$|[_:./-])/;

/**
 * Whether a reported command runs a test suite ("npm test", "npx vitest run", "pytest -q",
 * "go test ./..."). A lint, type-check or build run passing does not show that tests pass.
 */
export function looksLikeTestRun(command: string): boolean {
  return command
    .toLowerCase()
    .split(/[\s&|;()]+/)
    .some((part) => {
      const word = part.replace(/^['"`]+|['"`]+$/g, '');
      return TEST_RUNNERS.has(word.replace(/^.*[\\/]/, '')) || TEST_WORD.test(word);
    });
}

/**
 * Whether a claim is backed by the results the caller reported. Only test and CI claims can be
 * backed. A test claim needs a cited run that passed and is a test run, and no reported run may
 * have failed. A CI claim needs a cited run that CI reported and that passed, and no run that CI
 * reported may have failed. A failing result must never hide behind a passing one.
 */
export function claimIsSupported(
  claim: Claim,
  citedIds: readonly string[],
  tests: readonly TestEvidence[],
): boolean {
  if (claim.kind !== 'tests-pass' && claim.kind !== 'ci-green') return false;
  const byId = new Map(tests.map((t) => [t.id, t]));
  const cited = citedIds.flatMap((id) => {
    const found = byId.get(id);
    return found ? [found] : [];
  });
  if (claim.kind === 'ci-green') {
    const reported = tests.filter((t) => t.source === 'ci');
    return reported.every((t) => t.passed) && cited.some((t) => t.source === 'ci' && t.passed);
  }
  return tests.every((t) => t.passed) && cited.some((t) => t.passed && looksLikeTestRun(t.command));
}

/** What a writer can do about a test or CI claim that is not backed, for the message of the warning. */
export function backingHint(claim: Claim, tests: readonly TestEvidence[]): string {
  if (claim.kind !== 'tests-pass' && claim.kind !== 'ci-green') {
    return ' MergeStory cannot check this from the change.';
  }
  const pool = claim.kind === 'ci-green' ? tests.filter((t) => t.source === 'ci') : tests;
  const failed = pool.filter((t) => !t.passed).map((t) => t.id);
  if (failed.length > 0) {
    return ` A reported run did not pass (${failed.slice(0, 3).join(', ')}), so do not claim a pass; say which run did not pass instead.`;
  }
  return claim.kind === 'ci-green'
    ? ' Cite a passing result that CI reported (T1, T2, ...) from the context, or leave the claim out.'
    : ' Cite a passing test run (T1, T2, ...) from the context, or leave the claim out.';
}
