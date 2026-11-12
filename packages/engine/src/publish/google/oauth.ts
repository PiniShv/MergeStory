/**
 * OAuth 2.0 for a desktop app: PKCE, the sign-in address, and the calls to Google's token
 * endpoint. Access tokens are fetched with the refresh token and kept in memory only.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { RunContext } from '../../core/context.ts';
import { MergeStoryError } from '../../core/errors.ts';
import type { GoogleCredentials } from './credentials.ts';
import {
  type GoogleEndpoints,
  type HttpEnv,
  parseApiFailure,
  readAnswerBody,
  sendRequest,
  type TokenProvider,
  toGoogleError,
  withRetries,
} from './google-api.ts';
import type { GoogleProvider } from './provider.ts';

export const SCOPE_PREFIX = 'https://www.googleapis.com/auth/';

/** The scope without its URL prefix, for messages: "youtube.upload". */
export function shortScope(scope: string): string {
  return scope.startsWith(SCOPE_PREFIX) ? scope.slice(SCOPE_PREFIX.length) : scope;
}

/** Split a space-separated scope string. null when it is empty or missing (unknown). */
export function parseScopes(value: string | null | undefined): string[] | null {
  const scopes = (value ?? '').split(/\s+/).filter(Boolean);
  return scopes.length > 0 ? scopes : null;
}

/** A code verifier and its S256 challenge (RFC 7636). */
export interface Pkce {
  verifier: string;
  challenge: string;
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** 32 random bytes give a 43-character verifier, the shortest length the standard allows. */
export function createPkce(random: Buffer = randomBytes(32)): Pkce {
  const verifier = random.toString('base64url');
  return { verifier, challenge: pkceChallenge(verifier) };
}

/** A random value that ties the answer of the browser to the request that started it. */
export function randomState(): string {
  return randomBytes(32).toString('base64url');
}

export interface AuthUrlInput {
  authUrl: string;
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  challenge: string;
}

/**
 * The address the person opens to sign in. `access_type=offline` and `prompt=consent` make Google
 * hand out a refresh token every time; `select_account` makes the person pick the account, so a
 * browser that is signed in to another account cannot be used without them noticing. Nothing in it is secret: the verifier stays on this machine.
 */
export function buildAuthUrl(input: AuthUrlInput): string {
  const params: [string, string][] = [
    ['client_id', input.clientId],
    ['redirect_uri', input.redirectUri],
    ['response_type', 'code'],
    ['scope', input.scopes.join(' ')],
    ['code_challenge', input.challenge],
    ['code_challenge_method', 'S256'],
    ['state', input.state],
    ['access_type', 'offline'],
    ['prompt', 'select_account consent'],
  ];
  const query = params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  return `${input.authUrl}?${query}`;
}

/** What Google's token endpoint answers. */
export interface TokenGrant {
  accessToken: string;
  /** Only present for the first exchange of a sign-in code. */
  refreshToken: string | null;
  /** Space-separated scopes that were really granted (the person can untick some). */
  scope: string | null;
  expiresInSec: number;
}

export interface OAuthEnv extends HttpEnv {
  endpoints: GoogleEndpoints;
  provider: GoogleProvider;
}

function unreadable(): MergeStoryError {
  return new MergeStoryError('PUBLISH_FAILED', 'Google answered with something MergeStory cannot read.', {
    hint: 'Try again in a few minutes.',
  });
}

function parseGrant(text: string): TokenGrant {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw unreadable();
  }
  if (!data || typeof data !== 'object') throw unreadable();
  const record = data as Record<string, unknown>;
  const accessToken = record.access_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0) throw unreadable();
  const expires =
    typeof record.expires_in === 'number' && Number.isFinite(record.expires_in) ? record.expires_in : 3600;
  return {
    accessToken,
    refreshToken:
      typeof record.refresh_token === 'string' && record.refresh_token ? record.refresh_token : null,
    scope: typeof record.scope === 'string' && record.scope ? record.scope : null,
    expiresInSec: Math.min(86_400, Math.max(60, expires)),
  };
}

/** POST a form to the token endpoint. The secrets go in the body, never in the address. */
async function postForm(url: string, form: Record<string, string>, env: HttpEnv): Promise<TokenGrant> {
  const body = new URLSearchParams(form).toString();
  return withRetries(async () => {
    const response = await sendRequest(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body,
      },
      { signal: env.signal, timeoutMs: env.timing.requestTimeoutMs },
    );
    const text = await readAnswerBody(response, env.signal);
    if (!response.ok) throw parseApiFailure(response.status, text, response.headers);
    return parseGrant(text);
  }, env);
}

export interface ExchangeInput {
  clientId: string;
  clientSecret: string | null;
  code: string;
  verifier: string;
  redirectUri: string;
}

/** Trade the sign-in code for tokens. */
export async function exchangeCode(
  input: ExchangeInput,
  env: OAuthEnv,
  ctx: Pick<RunContext, 'redactor' | 'signal'>,
): Promise<TokenGrant> {
  try {
    const grant = await postForm(
      env.endpoints.tokenUrl,
      {
        client_id: input.clientId,
        ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
        code: input.code,
        code_verifier: input.verifier,
        grant_type: 'authorization_code',
        redirect_uri: input.redirectUri,
      },
      env,
    );
    ctx.redactor.add(grant.accessToken);
    ctx.redactor.add(grant.refreshToken);
    return grant;
  } catch (err) {
    throw toGoogleError(err, `Signing in to ${env.provider.label}`, ctx, env.provider, 'exchange');
  }
}

/** Get a new access token with the refresh token. */
export async function refreshGrant(
  credentials: Pick<GoogleCredentials, 'clientId' | 'clientSecret' | 'refreshToken'>,
  env: OAuthEnv,
  ctx: Pick<RunContext, 'redactor' | 'signal'>,
): Promise<TokenGrant> {
  try {
    const grant = await postForm(
      env.endpoints.tokenUrl,
      {
        client_id: credentials.clientId,
        ...(credentials.clientSecret ? { client_secret: credentials.clientSecret } : {}),
        grant_type: 'refresh_token',
        refresh_token: credentials.refreshToken,
      },
      env,
    );
    ctx.redactor.add(grant.accessToken);
    return grant;
  } catch (err) {
    throw toGoogleError(err, `Signing in to ${env.provider.label}`, ctx, env.provider, 'refresh');
  }
}

/** Refresh a little early, so a token never runs out in the middle of a request. */
const EXPIRY_MARGIN_MS = 120_000;

/**
 * Access tokens for one run. The token lives in memory only, and is renewed when it is about to
 * expire, which matters for uploads that take longer than the token lasts (about an hour).
 */
export class AccessTokens implements TokenProvider {
  private readonly credentials: GoogleCredentials;
  private readonly env: OAuthEnv;
  private readonly ctx: Pick<RunContext, 'redactor' | 'signal'>;
  private token: string | null = null;
  private expiresAt = 0;
  private granted: string[] | null = null;
  private pending: Promise<string> | null = null;

  constructor(credentials: GoogleCredentials, env: OAuthEnv, ctx: Pick<RunContext, 'redactor' | 'signal'>) {
    this.credentials = credentials;
    this.env = env;
    this.ctx = ctx;
  }

  async get(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt - EXPIRY_MARGIN_MS) return this.token;
    this.pending ??= this.renew().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  invalidate(): void {
    this.token = null;
  }

  /** Scopes Google reported with the latest token; null when it did not say (or no token was fetched yet). */
  get scopes(): string[] | null {
    return this.granted;
  }

  private async renew(): Promise<string> {
    const grant = await refreshGrant(this.credentials, this.env, this.ctx);
    this.token = grant.accessToken;
    this.expiresAt = Date.now() + grant.expiresInSec * 1000;
    this.granted = parseScopes(grant.scope) ?? this.granted;
    return grant.accessToken;
  }
}
