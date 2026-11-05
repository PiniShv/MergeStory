/** Line-level review signals. Each rule turns a pattern in changed lines into a question for the reviewer. */
import { plural } from '../core/text.ts';
import type { FileRole, RiskCategory, RiskSeverity } from '../core/types.ts';

/** What one kind of risk says: its place in the report and the words the reviewer reads. */
export interface RiskKind {
  category: RiskCategory;
  severity: RiskSeverity;
  /** Starts the detail sentence: "Adds", "Changes", "Removes" or "Reads". */
  verb: string;
  /** A review prompt: starts with "Check" or "Confirm". */
  title: string;
  /** What was found, in plain words. A function when the text counts what it found. */
  what: string | ((count: number) => string);
}

export const RISK_KINDS = {
  eval: {
    category: 'security',
    severity: 'high',
    verb: 'Adds',
    title: 'Check the new dynamic code evaluation',
    what: 'a call that runs text as code (eval or new Function)',
  },
  'process-exec': {
    category: 'security',
    severity: 'medium',
    verb: 'Adds',
    title: 'Check the new external process execution',
    what: 'a call that starts an external process',
  },
  'shell-option': {
    category: 'security',
    severity: 'medium',
    verb: 'Adds',
    title: 'Confirm the shell option is needed',
    what: 'a process option that runs the command through a shell',
  },
  'tls-off': {
    category: 'security',
    severity: 'high',
    verb: 'Adds',
    title: 'Confirm TLS certificate verification stays enabled',
    what: 'a setting that turns off TLS certificate verification',
  },
  'html-injection': {
    category: 'security',
    severity: 'medium',
    verb: 'Adds',
    title: 'Check that the HTML inserted here is sanitised',
    what: 'code that inserts raw HTML',
  },
  'sql-concat': {
    category: 'security',
    severity: 'medium',
    verb: 'Adds',
    title: 'Check that this SQL is built with bound parameters',
    what: 'an SQL statement built by joining strings',
  },
  'security-check-removed': {
    category: 'security',
    severity: 'medium',
    verb: 'Removes',
    title: 'Confirm the removed security check is replaced or no longer needed',
    what: 'a sanitising or authorisation check',
  },
  'destructive-sql': {
    category: 'data',
    severity: 'high',
    verb: 'Adds',
    title: 'Confirm this destructive statement is intended and guarded',
    what: 'a statement that deletes data',
  },
  'empty-handler': {
    category: 'error-handling',
    severity: 'medium',
    verb: 'Adds',
    title: 'Check the new error handler that ignores the error',
    what: 'an error handler that does nothing',
  },
  'error-handling-removed': {
    category: 'error-handling',
    severity: 'medium',
    verb: 'Removes',
    title: 'Confirm the removed error handling is no longer needed',
    what: 'try/catch or recovery code',
  },
  suppression: {
    category: 'error-handling',
    severity: 'low',
    verb: 'Adds',
    title: 'Check why the new lint or type-check suppression is needed',
    what: 'a lint or type-check suppression',
  },
  todo: {
    category: 'complexity',
    severity: 'low',
    verb: 'Adds',
    title: 'Check the new TODO, FIXME or HACK notes',
    what: 'a TODO, FIXME or HACK note',
  },
  concurrency: {
    category: 'concurrency',
    severity: 'low',
    verb: 'Adds',
    title: 'Check shared state and ordering around the new concurrent code',
    what: 'concurrent or locking code',
  },
  'feature-flag': {
    category: 'config',
    severity: 'low',
    verb: 'Adds',
    title: 'Confirm the feature flag default and rollout plan',
    what: 'a feature flag',
  },
  'skipped-test': {
    category: 'tests',
    severity: 'low',
    verb: 'Adds',
    title: 'Check the newly skipped tests',
    what: 'a skipped test',
  },
  'test-removed': {
    category: 'tests',
    severity: 'low',
    verb: 'Removes',
    title: 'Check the removed test cases',
    what: 'test cases',
  },
  'async-loop': {
    category: 'concurrency',
    severity: 'low',
    verb: 'Adds',
    title: 'Check the async calls inside a loop',
    what: 'async work repeated in a loop (sequential awaits or unawaited callbacks)',
  },
  'numeric-setting': {
    category: 'performance',
    severity: 'low',
    verb: 'Changes',
    title: 'Check the changed timeout, retry or interval values',
    what: 'a timeout, retry or interval value',
  },
  'security-path': {
    category: 'security',
    severity: 'medium',
    verb: 'Changes',
    title: 'Confirm the change to security-sensitive code is intended',
    what: 'code in a security-related file',
  },
  'security-words': {
    category: 'security',
    severity: 'low',
    verb: 'Changes',
    title: 'Check the security-related logic that changed',
    what: 'logic that mentions authentication, secrets or encryption',
  },
  'migration-deleted': {
    category: 'migration',
    severity: 'medium',
    verb: 'Removes',
    title: 'Confirm deleting this migration is safe for databases that already ran it',
    what: 'a migration file',
  },
  'migration-destructive': {
    category: 'migration',
    severity: 'high',
    verb: 'Adds',
    title: 'Confirm the destructive schema change is safe for existing data',
    what: 'a migration that drops, renames or truncates schema or data',
  },
  'migration-edited': {
    category: 'migration',
    severity: 'medium',
    verb: 'Changes',
    title: 'Confirm editing an existing migration is safe where it already ran',
    what: 'an existing migration file',
  },
  'migration-alter': {
    category: 'migration',
    severity: 'medium',
    verb: 'Adds',
    title: 'Check the schema change against existing rows and the deploy order',
    what: 'a migration that alters existing tables',
  },
  'migration-new': {
    category: 'migration',
    severity: 'low',
    verb: 'Adds',
    title: 'Confirm the new migration can run on existing data',
    what: 'a migration file',
  },
  'api-removed': {
    category: 'public-api',
    severity: 'medium',
    verb: 'Removes',
    title: 'Confirm callers of the removed exports are updated',
    what: (n) => plural(n, 'exported symbol'),
  },
  'api-signature': {
    category: 'public-api',
    severity: 'medium',
    verb: 'Changes',
    title: 'Confirm callers still match the changed signatures',
    what: (n) => `the signature of ${plural(n, 'exported symbol')}`,
  },
  'dep-added': {
    category: 'dependency',
    severity: 'low',
    verb: 'Adds',
    title: 'Confirm the new dependencies are needed and maintained',
    what: (n) => plural(n, 'dependency', 'dependencies'),
  },
  'dep-major': {
    category: 'dependency',
    severity: 'medium',
    verb: 'Changes',
    title: 'Check the major version upgrades for breaking changes',
    what: (n) => plural(n, 'dependency', 'dependencies'),
  },
  'dep-removed': {
    category: 'dependency',
    severity: 'info',
    verb: 'Removes',
    title: 'Confirm the removed dependencies are no longer used',
    what: (n) => plural(n, 'dependency', 'dependencies'),
  },
  'no-tests': {
    category: 'tests',
    severity: 'low',
    verb: 'Changes',
    title: 'Confirm the changed behaviour is covered by tests',
    what: 'source files while no test file changed',
  },
  'tests-deleted': {
    category: 'tests',
    severity: 'medium',
    verb: 'Removes',
    title: 'Confirm the deleted tests are no longer needed',
    what: 'test files',
  },
  'large-hunk': {
    category: 'complexity',
    severity: 'low',
    verb: 'Changes',
    title: 'Check the large change that is hard to review in one piece',
    what: 'a single block of more than 80 lines',
  },
  'large-function': {
    category: 'complexity',
    severity: 'low',
    verb: 'Changes',
    title: 'Check the size of the long function',
    what: 'a function of more than 120 lines',
  },
  'env-vars': {
    category: 'config',
    severity: 'low',
    verb: 'Reads',
    title: 'Check the new environment variables',
    what: 'new environment variables',
  },
} satisfies Record<string, RiskKind>;

export type RiskKindId = keyof typeof RISK_KINDS;

/** A pattern over changed lines. What a match means is in RISK_KINDS under the same key. */
export interface LineRule {
  key: RiskKindId;
  /**
   * "added" tests added lines. "removed" tests removed lines and only fires when the file loses
   * more matching lines than it gains, so moved or rewritten code does not trigger it.
   */
  on: 'added' | 'removed';
  pattern: RegExp;
  roles: ReadonlySet<FileRole>;
  /** Also test comment lines (TODO notes, lint suppressions). */
  includeComments?: boolean;
  /** An opening line and the line right after it that together match, for handlers written over two lines. */
  span?: readonly (readonly [RegExp, RegExp])[];
}

export const CODE_ROLES: ReadonlySet<FileRole> = new Set<FileRole>(['source', 'build', 'other']);
export const CODE_AND_CONFIG_ROLES: ReadonlySet<FileRole> = new Set<FileRole>([
  'source',
  'build',
  'other',
  'ci',
  'config',
]);
const TEST_ROLES: ReadonlySet<FileRole> = new Set<FileRole>(['test']);

const SQL_SHAPE = '(?:SELECT\\s[^\'"`\\n]*\\sFROM|INSERT\\s+INTO|UPDATE\\s+\\w+\\s+SET|DELETE\\s+FROM)';

export const LINE_RULES: readonly LineRule[] = [
  {
    key: 'eval',
    on: 'added',
    pattern: /(?<![.$\w])eval\s*\(|\bnew\s+Function\s*\(/,
    roles: CODE_ROLES,
  },
  {
    key: 'process-exec',
    on: 'added',
    pattern:
      /\bchild_process\b|(?<![.\w$])(?:execSync|execFileSync|spawnSync)\s*\(|\b(?:cp|childProcess)\.(?:exec|execFile|spawn|fork)\s*\(|\bsubprocess\.(?:run|call|Popen|check_output|check_call)\s*\(|\bos\.(?:system|popen)\s*\(|\bexec\.Command(?:Context)?\s*\(|\bRuntime\.getRuntime\(\)\.exec|\bnew\s+ProcessBuilder\s*\(|\b(?:shell_exec|passthru|proc_open|popen)\s*\(|\bProcess\.Start\s*\(|\bOpen3\.\w+\s*\(|\bCommand::new\s*\(/,
    roles: CODE_ROLES,
  },
  {
    key: 'shell-option',
    on: 'added',
    pattern: /\bshell\s*[:=]\s*(?:true|True)\b/,
    roles: CODE_ROLES,
  },
  {
    key: 'tls-off',
    on: 'added',
    pattern:
      /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*[=:]\s*['"]?0|\bverify\s*=\s*False|InsecureSkipVerify\s*:\s*true|CURLOPT_SSL_VERIFY(?:PEER|HOST)[^\n]*(?:false|0)|\bssl_verify\w*\s*[=:]\s*false/i,
    roles: CODE_AND_CONFIG_ROLES,
  },
  {
    key: 'html-injection',
    on: 'added',
    pattern:
      /dangerouslySetInnerHTML|\.innerHTML\s*\+?=|\.outerHTML\s*=|document\.write\s*\(|\bv-html\b|insertAdjacentHTML\s*\(/,
    roles: CODE_ROLES,
  },
  {
    key: 'sql-concat',
    on: 'added',
    pattern: new RegExp(
      `['"\`][^'"\`\\n]*\\b${SQL_SHAPE}\\b[^'"\`\\n]*['"\`]\\s*\\+\\s*[\\w$(]|(?:\`|\\bf["'])[^\`'"\\n]*\\b${SQL_SHAPE}\\b[^\`\\n]*(?:\\$\\{|\\{[\\w.\\[\\]'"()]+\\})`,
      'i',
    ),
    roles: CODE_ROLES,
  },
  {
    key: 'security-check-removed',
    on: 'removed',
    pattern:
      /\b(?:sanitiz\w*|escapeHtml|DOMPurify|htmlspecialchars|csrf\w*|isAuthenticated|isAuthorized|requireAuth\w*|checkPermission\w*|hasPermission\w*|authoriz\w*|verifyToken|validateToken)\b/i,
    roles: CODE_ROLES,
  },
  {
    key: 'destructive-sql',
    on: 'added',
    pattern:
      /\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b|\bTRUNCATE\s+(?:TABLE\s+)?\w+|\bDELETE\s+FROM\s+(?![^\n]*\bWHERE\b)[\w."`]+/i,
    roles: CODE_ROLES,
  },
  {
    key: 'empty-handler',
    on: 'added',
    pattern:
      /\bcatch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\/[^\n]*|\/\*.*?\*\/)?\s*\}|\.catch\(\s*(?:\(\s*\w*\s*\)|\w+|_)\s*=>\s*(?:\{\s*\}|undefined|null|void 0)\s*\)|\bexcept\b[^:\n]*:\s*pass\b|\bif\s+err\s*!=\s*nil\s*\{\s*\}|\brescue\b[^\n]*\bnil\s*$/,
    roles: CODE_ROLES,
    span: [
      [/\bcatch\s*(?:\([^)]*\))?\s*\{\s*$/, /^\s*\}\s*$/],
      [/^\s*except\b[^:\n]*:\s*$/, /^\s*pass\s*$/],
    ],
  },
  {
    key: 'error-handling-removed',
    on: 'removed',
    pattern:
      /^\s*(?:\}\s*)?(?:try\s*\{|try\s*:|catch\s*[({]|except\b[^\n]*:|rescue\b|finally\s*\{)|\brecover\s*\(\)/,
    roles: CODE_ROLES,
  },
  {
    key: 'suppression',
    on: 'added',
    pattern:
      /eslint-disable|@ts-ignore|@ts-nocheck|@ts-expect-error|#\s*noqa\b|#\s*type:\s*ignore|#\s*pylint:\s*disable|\bnolint\b|nosemgrep|biome-ignore|#\[allow\(|@SuppressWarnings|rubocop:disable|phpcs:ignore|\bNOLINT\b|istanbul\s+ignore/,
    roles: CODE_ROLES,
    includeComments: true,
  },
  {
    key: 'todo',
    on: 'added',
    pattern: /(?:\/\/|#|\/\*|^\s*\*|--|<!--)[^\n]*\b(?:TODO|FIXME|HACK|XXX)\b/,
    roles: CODE_ROLES,
    includeComments: true,
  },
  {
    key: 'concurrency',
    on: 'added',
    pattern:
      /\b(?:sync\.(?:Mutex|RWMutex|WaitGroup|Once|Map|Pool)|Mutex|RwLock|Semaphore|AtomicInteger|AtomicLong|AtomicReference|AtomicBool|threading\.(?:Thread|Lock|RLock|Semaphore|Event)|ThreadPoolExecutor|ProcessPoolExecutor|asyncio\.(?:gather|Lock|Semaphore|Queue|create_task)|Promise\.(?:all|allSettled|race|any)\s*\(|worker_threads|Atomics\.|SharedArrayBuffer|tokio::spawn|thread::spawn|crossbeam)|\bgo\s+(?:func\s*\(|[\w.]+\s*\()|\bnew\s+Worker\s*\(|\bsynchronized\s*[({]|\.\s*(?:lock|acquire)\s*\(\)/,
    roles: CODE_ROLES,
  },
  {
    key: 'feature-flag',
    on: 'added',
    pattern:
      /\b(?:featureFlags?|feature_flags?|FEATURE_[A-Z0-9_]{3,}|useFeatureFlag|isFeatureEnabled|ldClient\.variation|flagsmith|unleash\.isEnabled)\b/,
    roles: CODE_AND_CONFIG_ROLES,
  },
  {
    key: 'skipped-test',
    on: 'added',
    pattern:
      /\b(?:it|test|describe)\.skip\s*\(|\bx(?:it|describe)\s*\(|@pytest\.mark\.skip|@Disabled\b|\bt\.Skip(?:f|Now)?\s*\(|#\[ignore\]|\.todo\s*\(/,
    roles: TEST_ROLES,
  },
  {
    key: 'test-removed',
    on: 'removed',
    pattern:
      /^\s*(?:it|test|describe)(?:\.(?:each|only))?\s*\(|^\s*def\s+test_|^\s*func\s+Test\w+|^\s*@Test\b|^\s*#\[test\]/,
    roles: TEST_ROLES,
  },
];

/** Environment variable reads. Group 1..n hold the variable name. */
export const ENV_READ =
  /process\.env\.([A-Z][A-Z0-9_]+)|process\.env\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\]|import\.meta\.env\.([A-Z][A-Z0-9_]+)|os\.environ(?:\.get)?\s*[([]\s*['"]([A-Z][A-Z0-9_]+)['"]|os\.getenv\(\s*['"]([A-Z][A-Z0-9_]+)['"]|os\.(?:Getenv|LookupEnv)\(\s*"([A-Z][A-Z0-9_]+)"|System\.getenv\(\s*"([A-Z][A-Z0-9_]+)"|\bENV(?:\.fetch\(|\[)\s*['"]([A-Z][A-Z0-9_]+)['"]|\bgetenv\(\s*['"]([A-Z][A-Z0-9_]+)['"]|\$_ENV\[\s*['"]([A-Z][A-Z0-9_]+)['"]|env::var\(\s*"([A-Z][A-Z0-9_]+)"/g;

/** CLI command registrations. */
export const CLI_COMMAND =
  /\.command\(\s*['"]([A-Za-z][\w-]*)(?:\s[^'"]*)?['"]|\badd_parser\(\s*['"]([A-Za-z][\w-]*)['"]|\bUse:\s*"([A-Za-z][\w-]*)(?:\s[^"]*)?"/g;

export const NUMERIC_SETTING =
  /\b([A-Za-z_]*?(?:timeout|retries|retry|attempts|backoff|delay|ttl|interval|max_?age|poll)[A-Za-z_]*)\s*[:=]\s*(\d[\d_.]*(?:\s*\*\s*\d[\d_.]*)*)/gi;

export const SECURITY_PATH =
  /(^|\/)(auth\w*|login|logout|session\w*|crypto\w*|security|permissions?|acl|rbac|oauth\w*|jwt|passw\w+|secrets?|credentials?)(\/|\.|_|-|$)/i;

export const SECURITY_WORDS =
  /\b(?:auth(?:enticat\w*|oriz\w*)?|session|password|passwd|credential\w*|jwt|csrf|cors|crypto\w*|bcrypt|argon2|hmac|encrypt\w*|decrypt\w*|permission\w*|rbac|acl|access_?token|refresh_?token|api_?key|bearer)\b/i;

export const DESTRUCTIVE_MIGRATION =
  /\bDROP\s+(?:TABLE|COLUMN|INDEX|SCHEMA|DATABASE|VIEW|TYPE|CONSTRAINT)\b|\bTRUNCATE\b|\bRENAME\s+(?:COLUMN|TO)\b|op\.drop_(?:column|table|index|constraint)|\bdrop_(?:table|column|index)\b|\b(?:dropTable|dropColumn|removeColumn|renameColumn|dropIndex)\s*\(|\bremove_column\b|\brename_column\b|\bchange_column\b|\bDELETE\s+FROM\s+(?![^\n]*\bWHERE\b)[\w."`]+/i;

export const ALTER_MIGRATION =
  /\bALTER\s+TABLE\b|op\.alter_column|\badd_column\b|\bADD\s+COLUMN\b|\bSET\s+NOT\s+NULL\b|\bCREATE\s+(?:UNIQUE\s+)?INDEX\b|\baddColumn\s*\(/i;
