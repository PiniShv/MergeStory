import { describe, expect, it } from 'vitest';
import { isMergeStoryError } from '../core/errors.ts';
import { graphqlUrlFor, parsePullRequestUrl, webHostFromApiUrl } from './pr-url.ts';

const GITHUB = { apiUrl: 'https://api.github.com', webHost: 'github.com' };

describe('parsePullRequestUrl', () => {
  it.each([
    'https://github.com/acme/widgets/pull/42',
    'https://github.com/acme/widgets/pull/42/',
    'https://github.com/acme/widgets/pull/42/files',
    'https://github.com/acme/widgets/pull/42/commits',
    'https://github.com/acme/widgets/pull/42/checks?check_run_id=7',
    'https://github.com/acme/widgets/pull/42?diff=split#discussion_r1',
    'https://github.com/acme/widgets/pull/42/files#diff-abc',
    'https://www.github.com/acme/widgets/pull/42',
    'github.com/acme/widgets/pull/42',
    'www.github.com/acme/widgets/pull/42/files',
    'acme/widgets#42',
    '  acme/widgets#42  ',
  ])('reads %s', (input) => {
    expect(parsePullRequestUrl(input)).toEqual({ owner: 'acme', repo: 'widgets', number: 42, ...GITHUB });
  });

  it('derives the API URL of a GitHub Enterprise Server host', () => {
    expect(parsePullRequestUrl('https://ghe.example.com/team/app/pull/7')).toEqual({
      owner: 'team',
      repo: 'app',
      number: 7,
      apiUrl: 'https://ghe.example.com/api/v3',
      webHost: 'ghe.example.com',
    });
    expect(parsePullRequestUrl('ghe.example.com/team/app/pull/7/files').apiUrl).toBe(
      'https://ghe.example.com/api/v3',
    );
    expect(parsePullRequestUrl('https://ghe.example.com:8443/team/app/pull/7')).toMatchObject({
      apiUrl: 'https://ghe.example.com:8443/api/v3',
      webHost: 'ghe.example.com:8443',
    });
  });

  it('uses the API root of GitHub Enterprise Cloud with data residency', () => {
    expect(parsePullRequestUrl('https://acme.ghe.com/team/app/pull/1').apiUrl).toBe(
      'https://api.acme.ghe.com',
    );
  });

  it('uses a non-default API URL for other hosts, but never for github.com', () => {
    expect(
      parsePullRequestUrl('https://ghe.example.com/team/app/pull/7', 'https://proxy.example.com/ghe/api/v3/')
        .apiUrl,
    ).toBe('https://proxy.example.com/ghe/api/v3');
    expect(
      parsePullRequestUrl('https://github.com/a/b/pull/1', 'https://ghe.example.com/api/v3').apiUrl,
    ).toBe('https://api.github.com');
    expect(parsePullRequestUrl('a/b#1', 'https://ghe.example.com/api/v3').apiUrl).toBe(
      'https://api.github.com',
    );
  });

  it('accepts the characters GitHub allows in names', () => {
    expect(parsePullRequestUrl('https://github.com/my-org_x/repo.name-1/pull/1')).toMatchObject({
      owner: 'my-org_x',
      repo: 'repo.name-1',
    });
    expect(parsePullRequestUrl('https://github.com/acme/.github/pull/3').repo).toBe('.github');
  });

  it.each([
    ['', 'empty'],
    ['not a url', 'free text'],
    ['https://github.com/acme/widgets', 'repository page'],
    ['https://github.com/acme/widgets/issues/42', 'an issue'],
    ['https://github.com/acme/widgets/pull/abc', 'non-numeric number'],
    ['https://github.com/acme/widgets/pull/0', 'zero'],
    ['https://github.com/acme/widgets/pull/99999999999', 'number out of range'],
    ['http://github.com/acme/widgets/pull/1', 'plain http'],
    ['ftp://github.com/acme/widgets/pull/1', 'other scheme'],
    ['https://github.com/ac me/widgets/pull/1', 'space in owner'],
    ['https://github.com/acme/wid$gets/pull/1', 'bad repo character'],
    ['https://github.com/-acme/widgets/pull/1', 'owner starts with a hyphen'],
    ['https://github.com/acme/../pull/1', 'dot-dot repo'],
    ['acme/widgets#0', 'shorthand zero'],
    ['acme/widgets#', 'shorthand without number'],
    ['acme#1', 'shorthand without repo'],
    ['/local/path', 'a path'],
    ['https://x'.padEnd(3000, 'x'), 'too long'],
  ])('rejects %j (%s) with SOURCE_INVALID and a hint', (input) => {
    try {
      parsePullRequestUrl(input);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isMergeStoryError(error)).toBe(true);
      if (isMergeStoryError(error)) {
        expect(error.code).toBe('SOURCE_INVALID');
        expect(error.hint).toBeTruthy();
      }
    }
  });

  it.each([
    'https://bitbucket.org/team/app/pull-requests/42',
    'https://gitlab.com/group/app/-/merge_requests/7',
  ])('refuses %s and points to the local repository', (input) => {
    expect.assertions(2);
    try {
      parsePullRequestUrl(input);
    } catch (error) {
      expect((error as Error).message).toContain('Not a pull request reference');
      expect(isMergeStoryError(error) && error.hint).toContain('pass the path of the local repository');
    }
  });

  it('refuses credentials in a URL and does not echo them', () => {
    try {
      parsePullRequestUrl('https://user:ghp_supersecrettoken1234567890@github.com/acme/widgets/pull/1');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isMergeStoryError(error)).toBe(true);
      const text = JSON.stringify(
        error instanceof Error ? { message: error.message, ...(error as object) } : error,
      );
      expect(text).not.toContain('ghp_');
      expect(text).not.toContain('supersecret');
    }
  });
});

describe('API url helpers', () => {
  it('maps API URLs back to web hosts', () => {
    expect(webHostFromApiUrl('https://api.github.com')).toBe('github.com');
    expect(webHostFromApiUrl('https://ghe.example.com/api/v3')).toBe('ghe.example.com');
    expect(webHostFromApiUrl('https://api.acme.ghe.com')).toBe('acme.ghe.com');
    expect(webHostFromApiUrl('nonsense')).toBeNull();
  });

  it('finds the GraphQL endpoint', () => {
    expect(graphqlUrlFor('https://api.github.com')).toBe('https://api.github.com/graphql');
    expect(graphqlUrlFor('https://ghe.example.com/api/v3')).toBe('https://ghe.example.com/api/graphql');
    expect(graphqlUrlFor('https://ghe.example.com/api/v3/')).toBe('https://ghe.example.com/api/graphql');
    expect(graphqlUrlFor('https://api.acme.ghe.com')).toBe('https://api.acme.ghe.com/graphql');
  });
});
