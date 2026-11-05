import { describe, expect, it } from 'vitest';
import { parseGitHubRemote } from './remote.ts';

const trusted = new Set(['github.com', 'ghe.example.com']);

describe('parseGitHubRemote', () => {
  it.each([
    'https://github.com/acme/widgets.git',
    'https://github.com/acme/widgets',
    'https://github.com/acme/widgets/',
    'git@github.com:acme/widgets.git',
    'ssh://git@github.com/acme/widgets.git',
    'ssh://git@github.com:22/acme/widgets.git',
    'git://github.com/acme/widgets.git',
    'https://www.github.com/acme/widgets',
  ])('reads %s', (url) => {
    expect(parseGitHubRemote(url, trusted)).toEqual({ host: 'github.com', owner: 'acme', name: 'widgets' });
  });

  it('drops credentials embedded in the URL', () => {
    const remote = parseGitHubRemote(
      'https://x-access-token:ghp_secretsecretsecret@github.com/acme/widgets.git',
      trusted,
    );
    expect(remote).toEqual({ host: 'github.com', owner: 'acme', name: 'widgets' });
    expect(JSON.stringify(remote)).not.toContain('ghp_');
  });

  it('reads a configured Enterprise host, keeping the web port', () => {
    expect(parseGitHubRemote('git@ghe.example.com:team/app.git', trusted)).toEqual({
      host: 'ghe.example.com',
      owner: 'team',
      name: 'app',
    });
    expect(parseGitHubRemote('https://ghe.example.com/team/app.git', trusted)?.host).toBe('ghe.example.com');
    expect(
      parseGitHubRemote('https://ghe.example.com:8443/team/app.git', new Set(['ghe.example.com:8443']))?.host,
    ).toBe('ghe.example.com:8443');
  });

  it('refuses hosts that are not GitHub, and odd values', () => {
    expect(parseGitHubRemote('https://gitlab.com/acme/widgets.git', trusted)).toBeNull();
    expect(parseGitHubRemote('git@bitbucket.org:acme/widgets.git', trusted)).toBeNull();
    expect(parseGitHubRemote('https://github.com/acme', trusted)).toBeNull();
    expect(parseGitHubRemote('https://github.com/acme/widgets/extra', trusted)).toBeNull();
    expect(parseGitHubRemote('/srv/git/widgets.git', trusted)).toBeNull();
    expect(parseGitHubRemote('file:///srv/git/widgets.git', trusted)).toBeNull();
    expect(parseGitHubRemote('', trusted)).toBeNull();
    expect(parseGitHubRemote('git@github.com:ac me/widgets.git', trusted)).toBeNull();
  });
});
