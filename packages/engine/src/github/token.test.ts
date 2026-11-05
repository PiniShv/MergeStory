import { describe, expect, it } from 'vitest';
import { parsePullRequestUrl } from './pr-url.ts';
import { envTokenAllowed, originOf } from './token.ts';

describe('envTokenAllowed', () => {
  it('allows api.github.com and the configured host only', () => {
    const github = parsePullRequestUrl('https://github.com/acme/widgets/pull/7');
    expect(envTokenAllowed(github, 'https://api.github.com')).toBe(true);
    const enterprise = parsePullRequestUrl('https://git.example.com/acme/widgets/pull/7');
    expect(envTokenAllowed(enterprise, 'https://api.github.com')).toBe(false);
    expect(envTokenAllowed(enterprise, 'https://git.example.com/api/v3')).toBe(true);
  });

  it('reads the origin of a URL, or null', () => {
    expect(originOf('https://a.example/x/y')).toBe('https://a.example');
    expect(originOf('not a url')).toBeNull();
  });
});
