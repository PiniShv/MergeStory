/**
 * Where a GitHub token comes from, and where it may be sent. GITHUB_TOKEN, then GH_TOKEN, then
 * `gh auth token`. An environment token is only sent to api.github.com or to the host named in
 * `github.apiUrl`, so a pull request URL can never make it travel to another server. The token is
 * registered with the redactor.
 */
import { ghEnvironment } from '../core/child-env.ts';
import type { RunContext } from '../core/context.ts';
import { runCommand } from '../core/process.ts';
import { DEFAULT_API_URL, type PullRequestRef } from './pr-url.ts';

const GH_TOKEN_TIMEOUT_MS = 5000;

/** The origin (scheme, host and port) of a URL, or null when it is not a URL. */
export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Environment tokens go only to api.github.com and to the host the user configured. */
export function envTokenAllowed(ref: PullRequestRef, configuredApiUrl: string): boolean {
  const target = originOf(ref.apiUrl);
  if (target === null) return false;
  return target === originOf(DEFAULT_API_URL) || target === originOf(configuredApiUrl);
}

/**
 * The token for a pull request's host: an environment token when this host may receive it,
 * otherwise `gh auth token` (when `github.useGhCli` allows it). `refusedEnv` is true when an
 * environment token exists but was kept back because of the host. Never throws because no token
 * was found.
 */
export async function resolveToken(
  ref: PullRequestRef,
  ctx: RunContext,
  ghPath: string,
): Promise<{ token: string | null; refusedEnv: boolean }> {
  const envToken = ctx.secrets.get('GITHUB_TOKEN') ?? ctx.secrets.get('GH_TOKEN');
  const allowed = Boolean(envToken) && envTokenAllowed(ref, ctx.config.github.apiUrl);
  let token: string | null = null;
  if (envToken && allowed) {
    token = envToken;
  } else if (envToken) {
    ctx.logger.debug('Not sending the environment token to this host', { host: new URL(ref.apiUrl).host });
  }
  if (!token && ctx.config.github.useGhCli) {
    token = await readGhToken(ghPath, ref.webHost, ctx);
  }
  if (token) ctx.redactor.add(token);
  return { token, refusedEnv: Boolean(envToken) && !allowed };
}

/** `gh auth token` for one host. Returns null when gh is missing, not logged in, or too slow. */
async function readGhToken(ghPath: string, webHost: string, ctx: RunContext): Promise<string | null> {
  try {
    const result = await runCommand(ghPath, ['auth', 'token', '--hostname', webHost], {
      timeoutMs: GH_TOKEN_TIMEOUT_MS,
      allowFailure: true,
      signal: ctx.signal,
      env: ghEnvironment(),
    });
    const token = result.stdout.trim();
    return result.code === 0 && token ? token : null;
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    ctx.logger.debug('The gh CLI gave no token');
    return null;
  }
}
