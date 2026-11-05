/**
 * Redaction for anything MergeStory prints or stores about itself: logs, error messages,
 * job files and result JSON. Two layers:
 *  1. exact values of known secrets (API keys and tokens loaded from the environment)
 *  2. token-shaped patterns (in case a secret arrives some other way, e.g. inside an error body)
 *
 * The token shapes are TOKEN_SHAPES from secrets.ts, the same list maskSecrets uses for content
 * shown in videos. maskSecrets also masks assigned values and long random literals, which this
 * redactor leaves alone.
 */
import { TOKEN_SHAPES } from './secrets.ts';

/** Rules that only the logs need: secrets inside request URLs. */
const LOG_ONLY_PATTERNS: RegExp[] = [
  /(?<=[?&](?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|sig|signature|token)=)[^&\s"']+/gi, // signed URL params
  /(?<=:\/\/[^\s/:@]+:)[^\s@/]+(?=@)/g, // passwords in URLs (scheme://user:pass@host)
];

/** Copies of the shared shapes, so the redactor and maskSecrets never share the state of a RegExp. */
const TOKEN_PATTERNS: RegExp[] = [
  ...TOKEN_SHAPES.map((shape) => new RegExp(shape.pattern.source, shape.pattern.flags)),
  ...LOG_ONLY_PATTERNS,
];

export const REDACTED = '[redacted]';

export class Redactor {
  private readonly values = new Set<string>();

  /** Register a secret value so it is removed from all output. Short values are ignored (too many false hits). */
  add(value: string | null | undefined): void {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed.length >= 8) this.values.add(trimmed);
  }

  redact(text: string): string {
    let out = text;
    for (const value of this.values) {
      if (out.includes(value)) out = out.split(value).join(REDACTED);
    }
    for (const pattern of TOKEN_PATTERNS) {
      pattern.lastIndex = 0;
      out = out.replace(pattern, REDACTED);
    }
    return out;
  }

  /** Deep-redact strings inside a JSON-like value. */
  redactValue<T>(value: T): T {
    return redactDeep(value, this, 0) as T;
  }
}

/** Object keys whose values are always secrets ("githubToken", "apiKey"), but not "inputTokens". */
const SECRET_KEY =
  /(token|secret|password|passwd|api[_-]?key|authorization|credential|access[_-]?key(?:[_-]?id)?)$/i;

function redactDeep(value: unknown, redactor: Redactor, depth: number): unknown {
  if (depth > 20) return REDACTED;
  if (typeof value === 'string') return redactor.redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redactor, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? REDACTED : redactDeep(v, redactor, depth + 1);
    }
    return out;
  }
  return value;
}

/** Process-wide redactor. Secrets loaded by config.ts are registered here. */
export const globalRedactor = new Redactor();
