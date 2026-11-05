import { describe, expect, it } from 'vitest';
import { REDACTED, Redactor } from './redact.ts';
import { maskSecrets, TOKEN_SHAPES } from './secrets.ts';

/** Joins parts at run time, so a made-up token never appears whole in the source, where secret scanners flag it. */
const fake = (...parts: string[]): string => parts.join('');

/** Token-shaped strings, and near misses that are not tokens. All values are made up. */
const TOKENS: [token: string, isToken: boolean][] = [
  ['-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAexample\n-----END RSA PRIVATE KEY-----', true],
  ['AKIAIOSFODNN7EXAMPLE', true],
  ['AGPAIOSFODNN7EXAMPLE', true],
  ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', true],
  ['ghp_abcdefghijklmnopqrstuvwxyz0123456789_old', true],
  ['github_pat_11ABCDEFG0123456789_abcdefghijklmnop', true],
  ['glpat-abcdefghij0123456789', true],
  ['sk-ant-api03-abcdefghijklmnop', true],
  ['sk-proj-abcdefghijklmnopqrstuvwx', true],
  [fake('sk_', 'live_abcdefghijklmnop1234'), true],
  ['rk_test_abcdefghijklmnop1234', true],
  ['xoxb-1234567890-abcdefghij', true],
  [fake('https://hooks.slack.com/services/', 'T00000000/B00000000/', 'X'.repeat(24)), true],
  [fake('AIza', 'SyA1234567890abcdefghijklmnopqrstuv'), true],
  ['npm_abcdefghijklmnopqrstuvwxyz0123456789', true],
  ['SG.abcdefghijklmnop.qrstuvwxyz0123456789', true],
  [fake('SK', '0123456789abcdef0123456789abcdef'), true],
  ['eyJhbGciOiJ.eyJzdWIi.abcdefgh', true],
  ['Bearer abcdef1234567890abcdef', true],
  ['Basic dXNlcjpwYXNzd29yZDEyMw==', true],
  ['X-Api-Key: 0123456789abcdef0123', true],
  ['Basic authentication', false],
  ['ghp_short', false],
  ['AKIA1234', false],
  ['sk-tooshort', false],
  ['xoxb-123', false],
  ['npm_abcdefghijklmnopqrstuvwxyz012345678', false],
  ['SK0123456789abcdef0123456789abcde', false],
  ['eyJhbGciOi.short.x', false],
  ['3f9c2ab4e1d0c5b6a7f8e9d0c1b2a3f4e5d6c7b8', false],
  ['skip-ant-colony', false],
];

describe('Redactor', () => {
  it('finds the same tokens as maskSecrets, and removes them whole', () => {
    const redactor = new Redactor();
    const wrong = TOKENS.flatMap(([token, isToken]) => {
      const line = `request failed for ${token} at step 3`;
      const masked = maskSecrets(line);
      const redacted = redactor.redact(line);
      const verdicts = { maskSecrets: masked.masked > 0, redactor: redacted !== line };
      const leaked =
        isToken && (masked.text.includes(token.slice(0, 12)) || redacted.includes(token.slice(0, 12)));
      if (verdicts.maskSecrets === isToken && verdicts.redactor === isToken && !leaked) return [];
      return [`${token}: ${JSON.stringify(verdicts)}${leaked ? ', partly kept' : ''}`];
    });
    expect(wrong).toEqual([]);
  });

  it('has an example for every token shape', () => {
    const missing = TOKEN_SHAPES.filter(
      (shape) =>
        !TOKENS.some(
          ([token, isToken]) => isToken && new RegExp(shape.pattern.source, shape.pattern.flags).test(token),
        ),
    ).map((shape) => shape.name);
    expect(missing).toEqual([]);
  });

  it('also removes secrets in signed URLs, passwords in URLs and bearer tokens', () => {
    const redactor = new Redactor();
    expect(redactor.redact('GET https://b.s3.amazonaws.com/k?X-Amz-Signature=abc123def456&x=1')).toBe(
      `GET https://b.s3.amazonaws.com/k?X-Amz-Signature=${REDACTED}&x=1`,
    );
    expect(redactor.redact('postgres://app:Sup3rS3cret@db.internal/app')).toBe(
      `postgres://app:${REDACTED}@db.internal/app`,
    );
    expect(redactor.redact('Authorization: Bearer abcdefghijklmnop')).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
    expect(redactor.redact('Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==')).toBe(
      `Authorization: Basic ${REDACTED}`,
    );
    expect(redactor.redact('x-api-key: 0123456789abcdef0123456789abcdef')).toBe(`x-api-key: ${REDACTED}`);
  });

  it('removes registered values', () => {
    const redactor = new Redactor();
    redactor.add('my-own-api-value');
    redactor.add('short');
    expect(redactor.redact('value my-own-api-value, short')).toBe(`value ${REDACTED}, short`);
  });

  it('redacts values nested beyond the depth limit', () => {
    const nest = (leaf: unknown): unknown => {
      let value = leaf;
      for (let i = 0; i < 25; i++) value = { child: value };
      return value;
    };
    const redactor = new Redactor();
    const keyed = JSON.stringify(redactor.redactValue(nest({ apiKey: 'plain-looking-value' })));
    expect(keyed).not.toContain('plain-looking-value');
    const shaped = JSON.stringify(
      redactor.redactValue(nest({ note: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' })),
    );
    expect(shaped).not.toContain('ghp_');
  });
});
