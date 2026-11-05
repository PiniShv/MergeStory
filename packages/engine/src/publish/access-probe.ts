/**
 * Checks that an address needs a sign-in before a video is uploaded for "protected" links.
 *
 * The check is one anonymous GET request for a file that does not exist: no cookies, no
 * credentials. An address behind an access proxy (Cloudflare Access, Google IAP, oauth2-proxy and
 * similar) answers with a redirect to a sign-in page or with a sign-in challenge. An open address
 * answers 404 (the file is missing) or 200. Anything else proves nothing, so it is not trusted.
 *
 * Redirects to other hosts are never followed, so no request ever reaches an identity provider.
 */
import { abortedError, MergeStoryError } from '../core/errors.ts';
import { randomToken } from '../core/ids.ts';
import { ENGINE_VERSION } from '../version.ts';

/** What the probe concluded about an address. */
export type AccessVerdict = 'protected' | 'not-protected' | 'unknown';

/** The outcome of probeAccessProtection(). Nothing in it can hold a secret. */
export interface AccessProbeResult {
  verdict: AccessVerdict;
  /** Short, stable name of the signal that decided the verdict, for logs and tests. */
  reason: string;
  /** What was seen, as the end of a sentence that starts with the host: "answered HTTP 404 ...". */
  detail: string;
  /** HTTP status of the answer that decided the verdict, or null when there was no answer. */
  status: number | null;
  /** Host (with port, if any) of the address that was probed. */
  host: string;
}

export interface AccessProbeOptions {
  /** Folder below the address where the files will be stored, for example "mergestory/v/<token>/". */
  pathPrefix?: string;
  /** Time limit for the whole check, redirects included. Default: 10 seconds. */
  timeoutMs?: number;
  /** Cancels the check. A cancelled check throws ABORTED. */
  signal?: AbortSignal;
  /** Replaces fetch (tests). */
  fetch?: typeof fetch;
}

/** The probe function, so that callers can replace it in tests. */
export type AccessProbe = (publicBaseUrl: string, options?: AccessProbeOptions) => Promise<AccessProbeResult>;

const DEFAULT_TIMEOUT_MS = 10_000;
/** Redirects inside the same host (http to https, a trailing slash) are followed this many times. */
const MAX_FOLLOWED_REDIRECTS = 2;
/** Only the start of an error page is read, to look for sign-in markers. */
const MAX_BODY_BYTES = 8 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Sign-in services that an access proxy sends people to. */
const IDENTITY_PROVIDER_HOSTS: RegExp[] = [
  /(^|\.)cloudflareaccess\.com$/i,
  /^accounts\.google\.com$/i,
  /^login\.microsoftonline\.com$/i,
  /(^|\.)okta(preview)?\.com$/i,
  /(^|\.)auth0\.com$/i,
  /(^|\.)amazoncognito\.com$/i,
  /(^|\.)onelogin\.com$/i,
];

/** Paths of sign-in pages and of access proxies, such as "/oauth2/start" or "/users/sign_in". */
const SIGN_IN_PATH =
  /(^|\/)(login|log-in|signin|sign-in|sign_in|sso|saml2?|oauth2?\/(start|authorize|auth|sign_in)|_gcp_gatekeeper)(\/|$)/i;

/** Text on an error page that shows a sign-in step (oauth2-proxy, for example). */
const SIGN_IN_BODY = /\/oauth2\/(?:start|sign_in|static\/)|Sign in with /i;
const CLOUDFLARE_ACCESS_BODY = /cloudflareaccess\.com|cdn-cgi\/access|cloudflare access/i;
const CLOUDFRONT_SIGNED_BODY = /MissingKey|Missing Key-Pair-Id/i;

/** What to do with one answer: a verdict, or one more request to the same host. */
export type ProbeDecision =
  | { kind: 'verdict'; verdict: AccessVerdict; reason: string; detail: string }
  | { kind: 'follow'; url: URL };

/** One answer to the probe request, as far as the classifier needs it. */
export interface ProbeAnswer {
  status: number;
  headers: Pick<Headers, 'get'>;
  /** Start of the body; only read for 401 and 403. */
  body: string;
  /** The address that was asked. */
  url: URL;
}

function verdict(v: AccessVerdict, reason: string, detail: string): ProbeDecision {
  return { kind: 'verdict', verdict: v, reason, detail };
}

/** A sign-in redirect target, recognised by its host, its path or its query. */
function signInTarget(target: URL): { reason: string; detail: string } | null {
  const host = target.hostname;
  if (/(^|\.)cloudflareaccess\.com$/i.test(host) || target.pathname.startsWith('/cdn-cgi/access/')) {
    return { reason: 'cloudflare-access', detail: 'redirected to the Cloudflare Access sign-in page' };
  }
  const known =
    IDENTITY_PROVIDER_HOSTS.some((pattern) => pattern.test(host)) ||
    (/^github\.com$/i.test(host) && target.pathname.startsWith('/login/'));
  if (known) {
    return { reason: 'identity-provider', detail: `redirected to a sign-in page at ${host.slice(0, 100)}` };
  }
  const params = target.searchParams;
  if (params.has('client_id') && (params.has('redirect_uri') || params.has('response_type'))) {
    return { reason: 'oauth-redirect', detail: 'redirected to an OAuth sign-in request' };
  }
  if (SIGN_IN_PATH.test(target.pathname)) {
    return { reason: 'sign-in-page', detail: 'redirected to a sign-in page' };
  }
  return null;
}

function mentionsCloudFront(headers: Pick<Headers, 'get'>): boolean {
  if (headers.get('x-amz-cf-id') !== null || headers.get('x-amz-cf-pop') !== null) return true;
  return ['server', 'via', 'x-cache'].some((name) => /cloudfront/i.test(headers.get(name) ?? ''));
}

function classifyRedirect(answer: ProbeAnswer, followed: number): ProbeDecision {
  const location = answer.headers.get('location');
  let target: URL | null = null;
  if (location) {
    try {
      target = new URL(location, answer.url);
    } catch {
      target = null;
    }
  }
  if (!target || (target.protocol !== 'https:' && target.protocol !== 'http:')) {
    return verdict(
      'unknown',
      'bad-redirect',
      `answered HTTP ${answer.status} with a redirect that cannot be used`,
    );
  }
  const signIn = signInTarget(target);
  if (signIn) return verdict('protected', signIn.reason, signIn.detail);
  if (target.hostname === answer.url.hostname) {
    if (followed >= MAX_FOLLOWED_REDIRECTS) {
      return verdict('unknown', 'too-many-redirects', `redirected more than ${MAX_FOLLOWED_REDIRECTS} times`);
    }
    return { kind: 'follow', url: target };
  }
  return verdict(
    'unknown',
    'redirect',
    `redirected to ${target.hostname.slice(0, 100)}, which is not a known sign-in service`,
  );
}

function classifyChallenge(answer: ProbeAnswer): ProbeDecision | null {
  const { status, headers, body } = answer;
  const authenticate = headers.get('www-authenticate');
  if (status === 401 && authenticate) {
    return /resource_metadata=/i.test(authenticate) && /cloudflare-access/i.test(authenticate)
      ? verdict(
          'protected',
          'cloudflare-access-oauth',
          'answered 401 with a Cloudflare Access sign-in challenge',
        )
      : verdict('protected', 'challenge', 'answered 401 with a sign-in challenge');
  }
  if (SIGN_IN_BODY.test(body)) {
    return verdict('protected', 'sign-in-page', `answered ${status} with a sign-in page`);
  }
  const cloudflare = /cloudflare/i.test(headers.get('server') ?? '');
  if (cloudflare && !headers.get('cf-mitigated') && CLOUDFLARE_ACCESS_BODY.test(body)) {
    return verdict('protected', 'cloudflare-access-page', `answered ${status} with a Cloudflare Access page`);
  }
  if (status === 403 && CLOUDFRONT_SIGNED_BODY.test(body) && mentionsCloudFront(headers)) {
    return verdict('protected', 'cloudfront-signed', 'answered 403 and asked for a signed CloudFront link');
  }
  return null;
}

function classifyDenied(answer: ProbeAnswer): ProbeDecision {
  const { status, headers, body } = answer;
  let note = '';
  if (mentionsCloudFront(headers)) {
    note =
      ' (CloudFront also answers 403 for missing files, so this does not show that the address is protected)';
  } else if (/amazons3/i.test(headers.get('server') ?? '') || /AccessDenied/.test(body)) {
    note = ' (a storage service or a public bucket answers like this too)';
  } else if (headers.get('cf-mitigated')) {
    note = ' (Cloudflare blocked the request with a bot check)';
  }
  return verdict('unknown', 'denied', `answered HTTP ${status} without a sign-in page or challenge${note}`);
}

/**
 * Decide what one answer means. Exported for tests; callers use probeAccessProtection().
 * `followed` is the number of same-host redirects that were already followed.
 */
export function classifyAnswer(answer: ProbeAnswer, followed = 0): ProbeDecision {
  const { status } = answer;
  if (REDIRECT_STATUSES.has(status)) return classifyRedirect(answer, followed);
  if (status >= 200 && status < 300) {
    return verdict(
      'not-protected',
      'open',
      `answered HTTP ${status} without a sign-in: the address is open to anyone`,
    );
  }
  if (status === 401 || status === 403) {
    return classifyChallenge(answer) ?? classifyDenied(answer);
  }
  if (status === 404) {
    return verdict(
      'not-protected',
      'not-found',
      'answered HTTP 404 for a file that does not exist and did not ask for a sign-in: the address looks open to anyone',
    );
  }
  return verdict('unknown', status >= 500 ? 'server-error' : 'unexpected-status', `answered HTTP ${status}`);
}

/** Start of a response body as text, without reading more than `limit` bytes. */
async function readStart(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    // A body that cannot be read is treated as an empty one.
  } finally {
    reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).subarray(0, limit).toString('utf8');
}

/** The error code of a failed request ("ECONNREFUSED"), when it is a plain code. */
function failureCode(err: unknown): string | null {
  const cause = err instanceof Error ? (err.cause as { code?: unknown } | undefined) : undefined;
  const own = err as { code?: unknown } | null;
  const code = cause?.code ?? own?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{3,40}$/.test(code) ? code : null;
}

/** The address of the file that is asked for: a random name that never exists. */
function probeUrl(publicBaseUrl: string, pathPrefix: string): URL {
  let base: URL | null = null;
  try {
    base = new URL(publicBaseUrl);
  } catch {
    base = null;
  }
  if (!base || (base.protocol !== 'https:' && base.protocol !== 'http:') || base.username || base.password) {
    throw new MergeStoryError('CONFIG_INVALID', 'The public base URL is not a plain http(s) address.', {
      hint: 'Set publish.s3.publicBaseUrl to an address such as https://videos.example.com (no user name or password).',
    });
  }
  // Only plain folder names are used, so the prefix can never climb out of the address.
  const folders = pathPrefix.split('/').filter((part) => /^[A-Za-z0-9_~-][A-Za-z0-9._~-]*$/.test(part));
  base.search = '';
  base.hash = '';
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/${folders.map((part) => `${part}/`).join('')}mergestory-check-${randomToken(8)}`;
  return base;
}

/**
 * Ask an address for a file that does not exist, anonymously, and say whether it needs a sign-in.
 * Never throws for network trouble (that is "unknown"); throws ABORTED when `signal` is aborted.
 */
export async function probeAccessProtection(
  publicBaseUrl: string,
  options: AccessProbeOptions = {},
): Promise<AccessProbeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetch ?? fetch;
  const first = probeUrl(publicBaseUrl, options.pathPrefix ?? '');
  const host = first.host;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const result = (
    v: AccessVerdict,
    reason: string,
    detail: string,
    status: number | null,
  ): AccessProbeResult => ({
    verdict: v,
    reason,
    detail,
    status,
    host,
  });

  let current = first;
  for (let followed = 0; ; followed++) {
    let response: Response;
    try {
      response = await doFetch(current, {
        method: 'GET',
        // A redirect is read, never followed: it would end at an identity provider.
        redirect: 'manual',
        // IAP only redirects clients that say they can show a page.
        headers: { accept: 'text/html,*/*', 'user-agent': `mergestory/${ENGINE_VERSION} (access check)` },
        signal,
      });
    } catch (err) {
      if (options.signal?.aborted) throw abortedError(err);
      if (timeout.aborted) {
        return result(
          'unknown',
          'timeout',
          `did not answer within ${Math.round(timeoutMs / 1000)} seconds`,
          null,
        );
      }
      const code = failureCode(err);
      return result('unknown', 'unreachable', `could not be reached${code ? ` (${code})` : ''}`, null);
    }

    const needsBody = response.status === 401 || response.status === 403;
    const body = needsBody ? await readStart(response, MAX_BODY_BYTES) : '';
    if (!needsBody) response.body?.cancel().catch(() => undefined);
    if (options.signal?.aborted) throw abortedError();

    const decision = classifyAnswer(
      { status: response.status, headers: response.headers, body, url: current },
      followed,
    );
    if (decision.kind === 'follow') {
      current = decision.url;
      continue;
    }
    return result(decision.verdict, decision.reason, decision.detail, response.status);
  }
}
