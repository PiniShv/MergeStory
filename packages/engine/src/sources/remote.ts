/** Reading a git remote URL, without ever keeping its credentials. */
import { isValidOwnerName, isValidRepoName } from '../github/pr-url.ts';

export interface GitHubRemote {
  /** "github.com" or the Enterprise host. */
  host: string;
  owner: string;
  name: string;
}

function build(
  host: string,
  owner: string,
  rawName: string,
  trustedHosts: ReadonlySet<string>,
): GitHubRemote | null {
  const name = rawName.replace(/\.git$/i, '');
  const normalisedHost = host.toLowerCase() === 'www.github.com' ? 'github.com' : host.toLowerCase();
  if (!trustedHosts.has(normalisedHost)) return null;
  if (!isValidOwnerName(owner) || !isValidRepoName(name)) return null;
  return { host: normalisedHost, owner, name };
}

/**
 * Pull owner and name out of a GitHub remote URL: https, http, ssh://, git:// or the scp style
 * "git@github.com:owner/repo.git". Only the hosts in `trustedHosts` (github.com plus a configured
 * Enterprise host) count as GitHub; anything else returns null. Only owner and name are returned,
 * so a token embedded in the URL is dropped.
 */
export function parseGitHubRemote(url: string, trustedHosts: ReadonlySet<string>): GitHubRemote | null {
  const text = url.trim();
  if (!text) return null;

  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)([^/\s]+)\/([^/\s]+?)\/?$/.exec(text);
  if (scp) return build(scp[1]!, scp[2]!, scp[3]!, trustedHosts);

  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol)) return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  // For ssh and git URLs the port belongs to that protocol, not to the web site.
  const web = parsed.protocol === 'https:' || parsed.protocol === 'http:';
  return build(web ? parsed.host : parsed.hostname, parts[0]!, parts[1]!, trustedHosts);
}
