/**
 * Secret detection for repository content.
 *
 * Applied to every code line shown in a video, every on-screen string, every narration line,
 * and to the diff before it is sent to an LLM provider. Detection is deliberately eager:
 * masking a harmless string costs little, showing a live credential in a shared video costs a lot.
 */

export interface SecretMatch {
  rule: string;
  start: number;
  end: number;
}

/** A credential known by its form alone: the whole match is the secret. */
export interface TokenShape {
  name: string;
  /** A global regular expression. */
  pattern: RegExp;
}

interface Rule extends TokenShape {
  /** Index of the capture group that holds the secret; 0 = whole match. */
  group?: number;
}

/**
 * Tokens with a known prefix and form, masked wherever they appear. The log redactor in redact.ts
 * builds its token rules from this list too, so a token that is masked in a video is also kept out
 * of the logs.
 */
export const TOKEN_SHAPES: readonly TokenShape[] = [
  {
    name: 'private-key',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  },
  { name: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[0-9A-Z]{16}\b/g },
  { name: 'github-token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g },
  { name: 'gitlab-token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: 'openai-key', pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { name: 'stripe-key', pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: 'slack-token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: 'slack-webhook', pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g },
  { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: 'sendgrid-key', pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g },
  { name: 'twilio-key', pattern: /\bSK[0-9a-fA-F]{32}\b/g },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  // Authorization header values. Only the credential is masked, so "Bearer" or "Basic" stays readable.
  // Right after an Authorization header any value counts. Elsewhere a Bearer value must look like a token
  // (a digit or sign inside it, mixed case, or 32 letters) and a Basic value needs a digit or base64 sign,
  // so prose such as "Bearer authentication" or "Basic authentication" stays.
  {
    name: 'authorization-header',
    pattern:
      /(?<=\b[Aa]uthorization["']?\s{0,8}[:=]\s{0,8}["']?(?:[Bb]earer|[Bb]asic)\s{1,8})[A-Za-z0-9._~+/-]{8,}=*|(?<=\b[Bb]earer\s{1,8})(?=[A-Za-z]*[0-9._~+/-][A-Za-z0-9._~+/-]|[A-Za-z]*[a-z][A-Z]|[A-Za-z]{32})[A-Za-z0-9._~+/-]{12,}=*|(?<=\b[Bb]asic\s{1,8})(?=[A-Za-z]*[0-9+/=])[A-Za-z0-9+/]{12,}={0,2}/g,
  },
  // Key headers written as text, such as -H "X-Api-Key: ..." in a curl command.
  {
    name: 'api-key-header',
    pattern:
      /(?<=\b(?:x-)?(?:api-key|auth-token|access-token)["']?[ \t]{0,8}:[ \t]{0,8}["']?)[A-Za-z0-9._~+/=-]{8,}/gi,
  },
];

const RULES: Rule[] = [
  ...TOKEN_SHAPES,
  // scheme://user:password@host -> mask the password
  {
    name: 'url-credentials',
    pattern: /\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s/:@'"]{1,256}:([^\s@'"/]{3,256})@/gi,
    group: 1,
  },
];

/*
 * Assignments such as `password = "..."`, `apiKey: '...'` or `SECRET_TOKEN=...` are matched in two
 * steps: a pattern with bounded repetition finds "name, operator, value", and plain code then checks
 * the name and the value. One combined pattern with open-ended repetition around the keyword would
 * backtrack catastrophically on long runs of word characters (minified files, generated data).
 */
const ASSIGNMENT =
  /(?<![\w.$-])([A-Za-z_$][\w.$-]{0,63})["']?[ \t]{0,8}(?:=>|:=|[:=])[ \t]{0,8}["'`]([^"'`\s]{6,512})["'`]/g;
const ENV_ASSIGNMENT = /^[ \t]*(?:export[ \t]+)?([A-Z][A-Z0-9_]{0,63})[ \t]*=[ \t]*([^\s#'"]{6,512})/gm;
/** Names that always hold a secret: any non-placeholder value is masked. */
const STRONG_NAME = /(pass(word|wd)?|secret|api[_-]?key|access[_-]?key|private[_-]?key|credential)/i;
/** Names that often but not always hold one (tokenType, KEY_PREFIX): only secret-looking values are masked. */
const WEAK_NAME = /(token|auth(?!or)|key)/i;
const PLACEHOLDER =
  /^(?:changeme|change[_-]?me|example|dummy|placeholder|redacted|password|secret|none|null|undefined|true|false|xxx+|\*+|•+)$/i;

/** Placeholders, templates and references to the environment are not secrets. */
function isPlaceholder(value: string): boolean {
  if (value.length < 8 || PLACEHOLDER.test(value)) return true;
  if (/^\$\{.*\}$|^\{\{.*\}\}$|^<.*>$|^%.*%$/.test(value)) return true; // ${VAR}, {{var}}, <value>, %VAR%
  return /^(?:process\.env|os\.environ|env\.|import\.meta\.env)/.test(value);
}

/** Whether an assigned value should be masked, given the name it is assigned to. */
function shouldMask(name: string, value: string): boolean {
  if (isPlaceholder(value)) return false;
  if (STRONG_NAME.test(name)) return true;
  if (!WEAK_NAME.test(name)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(value)).length;
  return classes >= 2 || value.length >= 20;
}

/*
 * Unquoted values in configuration files: YAML (`password: x`, `- POSTGRES_PASSWORD=x`), Java
 * properties (`spring.datasource.password=x`), INI (`aws_secret_access_key = x`) and kubeconfig
 * (`client-key-data: <base64>`). The value runs to the end of the line (a ` #` comment aside), so
 * only lines that hold nothing else match, and values of any length are masked whole.
 */
const UNQUOTED_ASSIGNMENT =
  /^[ \t]*(?:-[ \t]{1,8})?(?:export[ \t]{1,8})?([A-Za-z_][\w.-]{0,63})[ \t]{0,8}(?::[ \t]{1,8}|=[ \t]{0,8})([^\s"'`]\S*)(?:[ \t]+#[^\r\n]*)?[ \t]*$/dgm;
/** Names for a setting about a secret, not the secret: secretName, password_file, api_key_header. */
const REFERENCE_NAME =
  /(?:name|file|path|ref|type|header|url|uri|endpoint|helper|provider|backend|store|source|arn)$/i;
/** Environment-style names (POSTGRES_PASSWORD), whose values are values even when written like a variable. */
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
/** A variable, member, call, index or type: `hashedPassword`, `config.apiKey`, `getSecret()`, `Option<String>`. */
const CODE_VALUE =
  /^[&*!]*[A-Za-z_$][\w$]*(?:(?:\?\.|\.|::|->)[A-Za-z_$][\w$]*|\[[^\]\s]*\]|\([^)\s]*\)|<\S*)*[!?]?$/;

/** Whether an unquoted value is code that names a secret rather than the secret itself. */
function readsLikeCode(name: string, value: string): boolean {
  const ended = /[,;]$/.test(value);
  const bare = ended ? value.slice(0, -1) : value;
  if (bare.length > 256 || !CODE_VALUE.test(bare)) return false;
  // A property or a statement (`password: hashedPassword,`), or a variable of the same name
  // (`this.credentials = credentials`).
  if (ended || bare.toLowerCase() === name.slice(name.lastIndexOf('.') + 1).toLowerCase()) return true;
  // POSTGRES_PASSWORD: my_db_password in a compose file is a value.
  if (ENV_NAME.test(name)) return false;
  if (/[.:[(<>]/.test(bare)) return true;
  // A single word is a variable when it is written like one (hashedPassword, db_password) and has
  // no digits. A word like Pr0dPassw0rd or postgres is taken for the value it most likely is.
  return !/[0-9]/.test(bare) && /[a-z][A-Z]|_|\$|^[&*]/.test(bare);
}

/** A generated token: long, made of token characters (base64, hex, URL-safe), and random or hex. */
function looksLikeToken(value: string): boolean {
  if (value.length < 16 || !/^[A-Za-z0-9+/=_.~-]+$/.test(value)) return false;
  return looksRandom(value) || (/^[a-f0-9]+$/i.test(value) && /[0-9]/.test(value) && /[a-f]/i.test(value));
}

/**
 * Whether an unquoted value should be masked. Strong names mask any value that is not a
 * placeholder or code; weak names (token, key) only mask values that look generated.
 */
function shouldMaskUnquoted(name: string, value: string): boolean {
  // `password: undefined,` in code: the trailing comma or semicolon is not part of the value.
  const bare = value.replace(/[,;]$/, '');
  if (REFERENCE_NAME.test(name) || isPlaceholder(bare) || readsLikeCode(name, value)) return false;
  if (STRONG_NAME.test(name)) return true;
  return WEAK_NAME.test(name) && looksLikeToken(bare);
}

/** Long high-entropy literals inside quotes, e.g. hard-coded keys without a telling name. */
const QUOTED_LITERAL = /["'`]([A-Za-z0-9+/=_-]{32,512})["'`]/g;

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function looksRandom(value: string): boolean {
  if (/^[a-f0-9]{40}$/i.test(value) || /^[a-f0-9]{64}$/i.test(value)) {
    // Commit SHAs and checksums are common and harmless in code; only mask when clearly not hex-only digests.
    return false;
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((r) => r.test(value)).length;
  return classes >= 2 && shannonEntropy(value) >= 4.0;
}

/** Find secrets in a string. Overlapping matches are merged. */
export function findSecrets(text: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    for (const m of text.matchAll(rule.pattern)) {
      const full = m[0];
      const index = m.index ?? 0;
      if (rule.group && m[rule.group] !== undefined) {
        const secret = m[rule.group]!;
        const offset = full.lastIndexOf(secret);
        matches.push({ rule: rule.name, start: index + offset, end: index + offset + secret.length });
      } else {
        matches.push({ rule: rule.name, start: index, end: index + full.length });
      }
    }
  }
  ASSIGNMENT.lastIndex = 0;
  for (const m of text.matchAll(ASSIGNMENT)) {
    const [full, name, value] = m as unknown as [string, string, string];
    if (!shouldMask(name, value)) continue;
    const start = (m.index ?? 0) + full.lastIndexOf(value);
    matches.push({ rule: 'assigned-secret', start, end: start + value.length });
  }
  ENV_ASSIGNMENT.lastIndex = 0;
  for (const m of text.matchAll(ENV_ASSIGNMENT)) {
    const [full, name, value] = m as unknown as [string, string, string];
    if (!shouldMask(name, value)) continue;
    const start = (m.index ?? 0) + full.lastIndexOf(value);
    matches.push({ rule: 'env-secret', start, end: start + value.length });
  }
  UNQUOTED_ASSIGNMENT.lastIndex = 0;
  for (const m of text.matchAll(UNQUOTED_ASSIGNMENT)) {
    const [, name, value] = m as unknown as [string, string, string];
    const at = m.indices?.[2];
    if (!at || !shouldMaskUnquoted(name, value)) continue;
    matches.push({ rule: 'unquoted-secret', start: at[0], end: at[1] });
  }
  QUOTED_LITERAL.lastIndex = 0;
  for (const m of text.matchAll(QUOTED_LITERAL)) {
    const literal = m[1]!;
    if (looksRandom(literal)) {
      const start = (m.index ?? 0) + 1;
      matches.push({ rule: 'high-entropy-literal', start, end: start + literal.length });
    }
  }
  return mergeRanges(matches);
}

function mergeRanges(matches: SecretMatch[]): SecretMatch[] {
  const sorted = [...matches].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: SecretMatch[] = [];
  for (const m of sorted) {
    const last = out[out.length - 1];
    if (last && m.start <= last.end) {
      last.end = Math.max(last.end, m.end);
    } else {
      out.push({ ...m });
    }
  }
  return out;
}

export const MASK_CHAR = '•';

/** Replace every detected secret with mask characters (length capped so masks do not leak length). */
export function maskSecrets(text: string): { text: string; masked: number } {
  const found = findSecrets(text);
  if (found.length === 0) return { text, masked: 0 };
  let out = '';
  let cursor = 0;
  for (const m of found) {
    out += text.slice(cursor, m.start) + MASK_CHAR.repeat(8);
    cursor = m.end;
  }
  out += text.slice(cursor);
  return { text: out, masked: found.length };
}

/** Example env files document variables without real values, so they are explained like any other file. */
const ENV_TEMPLATE = /(^|\/)\.env\.(example|sample|template|dist|defaults)$/i;

const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\.[^/]*)?$/i,
  /(^|\/)\.envrc$/i,
  /\.(pem|key|p12|pfx|p8|jks|keystore|asc|gpg|ppk)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.htpasswd$/i,
  /(^|\/)\.pgpass$/i,
  /(^|\/)\.my\.cnf$/i,
  /(^|\/)\.s3cfg$/i,
  /(^|\/)\.git-credentials$/i,
  /(^|\/)\.vault-token$/i,
  /(^|\/)\.dockercfg$/i,
  /(^|\/)credentials(\.json|\.ya?ml|\.toml)?$/i,
  /(^|\/)credentials\.tfrc\.json$/i,
  /(^|\/)secrets?\.(json|ya?ml|toml|env)$/i,
  /(^|\/)\.aws\/(credentials|config)$/i,
  /(^|\/)\.docker\/config\.json$/i,
  /(^|\/)\.kube\/config$/i,
  // kubeconfig, kubeconfig-prod.yaml, staging.kubeconfig; not kubeconfig.go or kubeconfig_test.go.
  /(^|\/)kubeconfig([-_][^/.]*)?(\.(ya?ml|json|conf))?$/i,
  /\.kubeconfig$/i,
  /(^|\/)gh\/hosts\.ya?ml$/i,
  /service[-_]?account.*\.json$/i,
  /\.tfstate(\.backup)?$/i,
  /\.tfvars(\.json)?$/i,
];

/**
 * Files that hold credentials, whose content is never shown in a video and never sent to a provider.
 * Everything else is shown as it is: explaining the real code is the point of the video.
 */
export function isSensitivePath(path: string): boolean {
  if (ENV_TEMPLATE.test(path)) return false;
  return SENSITIVE_PATH_PATTERNS.some((p) => p.test(path));
}

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/** Mask e-mail addresses (personal data) in on-screen text and narration. */
export function maskEmails(text: string): string {
  EMAIL.lastIndex = 0;
  return text.replace(EMAIL, (email) => {
    const at = email.indexOf('@');
    return `${email[0]}${MASK_CHAR.repeat(3)}@${email.slice(at + 1)}`;
  });
}

export interface PrivateMaskOptions {
  /** Also mask e-mail addresses (the privacy.maskEmails setting). */
  maskEmails: boolean;
}

export interface PrivateMaskReport {
  text: string;
  /** Secrets found by maskSecrets. */
  secrets: number;
  /** Whether masking secrets changed the text; text that is already masked can match again without changing. */
  secretsChanged: boolean;
  /** Whether masking e-mail addresses changed the text. */
  emailsChanged: boolean;
}

/** maskPrivate, plus what each step did, for callers that count what they masked. */
export function maskPrivateReport(text: string, options: PrivateMaskOptions): PrivateMaskReport {
  const secret = maskSecrets(text);
  const secretsChanged = secret.text !== text;
  if (!options.maskEmails)
    return { text: secret.text, secrets: secret.masked, secretsChanged, emailsChanged: false };
  const masked = maskEmails(secret.text);
  return { text: masked, secrets: secret.masked, secretsChanged, emailsChanged: masked !== secret.text };
}

/** Mask secrets, then e-mail addresses when `maskEmails` is set. */
export function maskPrivate(text: string, options: PrivateMaskOptions): string {
  return maskPrivateReport(text, options).text;
}
