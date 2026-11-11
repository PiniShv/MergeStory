/** Parsing of pull request references, and the API URLs that belong to a GitHub host. */
import { MergeStoryError } from '../core/errors.ts';

export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
  /** REST base, e.g. "https://api.github.com" or "https://ghe.example.com/api/v3". */
  apiUrl: string;
  /** Web host, e.g. "github.com". */
  webHost: string;
}

export const DEFAULT_API_URL = 'https://api.github.com';

const OWNER_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const MAX_INPUT_LENGTH = 2048;

/** True for a name GitHub accepts as an account (user or organization) name. */
export function isValidOwnerName(name: string): boolean {
  return OWNER_PATTERN.test(name);
}

/** True for a name GitHub accepts as a repository name. */
export function isValidRepoName(name: string): boolean {
  return REPO_PATTERN.test(name) && name !== '.' && name !== '..';
}

function invalid(reason: string): MergeStoryError {
  return new MergeStoryError('SOURCE_INVALID', `Not a pull request reference: ${reason}.`, {
    hint:
      'Use https://github.com/<owner>/<repo>/pull/<number> or <owner>/<repo>#<number>. ' +
      'For a pull request on another host, pass the path of the local repository instead, with --base <branch>.',
  });
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

/** API root for a web host. A non-default `configuredApiUrl` wins for hosts other than github.com. */
function apiUrlFor(webHost: string, configuredApiUrl: string): string {
  if (webHost === 'github.com') return DEFAULT_API_URL;
  const configured = trimTrailingSlashes(configuredApiUrl);
  if (configured && configured !== DEFAULT_API_URL) return configured;
  // GitHub Enterprise Cloud with data residency serves its API from api.<tenant>.ghe.com.
  if (webHost.endsWith('.ghe.com')) return `https://api.${webHost}`;
  return `https://${webHost}/api/v3`;
}

function build(
  webHost: string,
  owner: string,
  repo: string,
  numberText: string,
  configuredApiUrl: string,
): PullRequestRef {
  if (!isValidOwnerName(owner)) throw invalid('the owner name has characters GitHub does not allow');
  if (!isValidRepoName(repo)) throw invalid('the repository name has characters GitHub does not allow');
  const number = Number(numberText);
  if (!Number.isSafeInteger(number) || number < 1 || number > 2_147_483_647) {
    throw invalid('the pull request number is out of range');
  }
  return { owner, repo, number, apiUrl: apiUrlFor(webHost, configuredApiUrl), webHost };
}

/**
 * Parse "https://github.com/o/r/pull/1" (with an optional /files or /commits tail, query or
 * fragment), "github.com/o/r/pull/1", "o/r#1", or a GitHub Enterprise URL such as
 * "https://ghe.example.com/o/r/pull/1". Throws SOURCE_INVALID for anything else.
 *
 * Only https URLs are accepted, and URLs with embedded credentials are refused (and never
 * echoed back, so a pasted token does not end up in a log).
 */
export function parsePullRequestUrl(input: string, defaultApiUrl = DEFAULT_API_URL): PullRequestRef {
  const text = input.trim();
  if (!text) throw invalid('the value is empty');
  if (text.length > MAX_INPUT_LENGTH) throw invalid('the value is too long');

  const shorthand = /^([^\s/#@:]+)\/([^\s/#@:]+)#(\d+)$/.exec(text);
  if (shorthand) return build('github.com', shorthand[1]!, shorthand[2]!, shorthand[3]!, defaultApiUrl);

  let candidate = text;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    // "github.com/o/r/pull/1": a host name (it has a dot) followed by a path.
    if (!/^[^/\s@:]+\.[^/\s@:]+\//.test(candidate))
      throw invalid('it is not a URL or <owner>/<repo>#<number>');
    candidate = `https://${candidate}`;
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw invalid('the URL cannot be read');
  }
  if (url.protocol !== 'https:') throw invalid('only https:// URLs are supported');
  if (url.username || url.password) throw invalid('the URL must not contain credentials');

  let parts: string[];
  try {
    parts = url.pathname
      .split('/')
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
  } catch {
    throw invalid('the URL path cannot be read');
  }
  const [owner, repo, kind, number] = parts;
  if (!owner || !repo || kind !== 'pull' || !number || !/^\d+$/.test(number)) {
    throw invalid('expected a URL like https://<host>/<owner>/<repo>/pull/<number>');
  }
  const host = url.host.toLowerCase();
  const webHost = host === 'www.github.com' ? 'github.com' : host;
  return build(webHost, owner, repo, number, defaultApiUrl);
}

/** The web host that belongs to an API URL ("https://api.github.com" -> "github.com"), or null. */
export function webHostFromApiUrl(apiUrl: string): string | null {
  try {
    const host = new URL(apiUrl).host.toLowerCase();
    if (host === 'api.github.com') return 'github.com';
    if (host.startsWith('api.') && host.endsWith('.ghe.com')) return host.slice('api.'.length);
    return host;
  } catch {
    return null;
  }
}

/** The GraphQL endpoint that belongs to a REST API URL. */
export function graphqlUrlFor(apiUrl: string): string {
  const url = new URL(apiUrl);
  const path = trimTrailingSlashes(url.pathname);
  // GitHub Enterprise Server serves REST from /api/v3 and GraphQL from /api/graphql.
  if (path.endsWith('/api/v3')) return `${url.origin}${path.slice(0, -'/api/v3'.length)}/api/graphql`;
  return `${url.origin}${path}/graphql`;
}
