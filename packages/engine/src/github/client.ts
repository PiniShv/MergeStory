/**
 * A small GitHub REST client, limited to what MergeStory needs: read one pull request with its
 * files, commits and repository content, and (only when asked) write one comment or one section
 * of the description.
 *
 * Tokens (see token.ts) are sent in a header only, never in a URL, and are registered with the
 * redactor. Failed responses are turned into errors by errors.ts.
 */
import { inspect } from 'node:util';
import { Semaphore } from '../core/concurrency.ts';
import type { RunContext } from '../core/context.ts';
import { isMergeStoryError, MergeStoryError } from '../core/errors.ts';
import { hashKey } from '../core/ids.ts';
import { asArray, asNumber, asString, isRecord } from '../core/json.ts';
import { createPathPolicy } from '../core/path-policy.ts';
import { safeRepoPath } from '../core/paths.ts';
import { fetchWithRetry, sleep } from '../core/retry.ts';
import { decodeTextBlob } from '../core/text.ts';
import type { StageName } from '../core/types.ts';
import { ENGINE_VERSION } from '../version.ts';
import {
  describeFailure,
  describePath,
  transportFailure,
  unexpectedResponse,
  unreadableResponse,
} from './errors.ts';
import {
  type GitHubComment,
  type GitHubComparison,
  type GitHubIssue,
  type GitHubPrCommit,
  type GitHubPrFile,
  type GitHubPullRequest,
  type GitHubRepo,
  type GitHubTree,
  type GitHubTreeEntry,
  toComment,
  toIssue,
  toPrFile,
  toPullRequest,
  toRepo,
} from './model.ts';
import { graphqlUrlFor, type PullRequestRef } from './pr-url.ts';
import { originOf, resolveToken } from './token.ts';

/** The API version this client was written against (supported by GitHub until 2028-03-10). */
export const GITHUB_API_VERSION = '2022-11-28';

/** GitHub lists at most this many files for a pull request. */
export const MAX_PR_FILES = 3000;

const JSON_ACCEPT = 'application/vnd.github+json';
const RAW_ACCEPT = 'application/vnd.github.raw+json';
/** Client errors are handled here (with their headers), so the retry helper returns them untouched. */
const PASS_THROUGH_STATUSES = [400, 401, 403, 404, 405, 406, 409, 410, 422, 429, 451];
const MAX_CONCURRENT_REQUESTS = 4;
const MAX_RATE_LIMIT_RETRIES = 2;
const MAX_COMMENT_PAGES = 30;
/** How many files without a patch are re-requested one by one. */
const MAX_PATCH_RECOVERIES = 12;

export interface GitHubClientOptions {
  /** Stage named in progress warnings. Default "source". */
  stage?: StageName;
  /** The gh executable used to look up a token. Default "gh". */
  ghPath?: string;
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function isFullSha(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
}

/** The URL of the next page from a Link header, or null. */
function nextPageUrl(header: string | null): string | null {
  if (!header) return null;
  const match = /<([^>]+)>\s*;\s*rel="next"/i.exec(header);
  return match ? match[1]! : null;
}

/** Read a body, giving up (null) as soon as it grows past `maxBytes`. */
async function readCapped(response: Response, maxBytes: number): Promise<Buffer | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return Buffer.from(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH';
  accept?: string;
  body?: unknown;
  /** Statuses returned to the caller instead of raised as errors. */
  allow?: number[];
  /** False for requests that must not be repeated automatically (creating a comment). */
  retries?: boolean;
}

/** Either a path below the API root (already URL-encoded) or a full URL (to follow a pagination link). */
type RequestSpec = RequestOptions &
  ({ path: string; query?: Record<string, string | number> } | { url: string });

/** One page of a list, and whether GitHub says more follow. */
interface Page {
  items: unknown[];
  more: boolean;
}

export class GitHubClient {
  readonly ref: PullRequestRef;
  /** True when requests carry a token. */
  readonly authenticated: boolean;
  /** Host of the REST API, for the egress report. */
  readonly apiHost: string;

  private readonly ctx: RunContext;
  private readonly token: string | null;
  private readonly apiBase: string;
  private readonly repoPath: string;
  private readonly limiter = new Semaphore(MAX_CONCURRENT_REQUESTS);
  private readonly isProtected: (path: string) => boolean;
  private warnedLowRateLimit = false;

  private constructor(ref: PullRequestRef, ctx: RunContext, token: string | null) {
    this.ref = ref;
    this.ctx = ctx;
    this.token = token;
    this.authenticated = token !== null;
    this.apiBase = ref.apiUrl.replace(/\/+$/, '');
    this.apiHost = new URL(this.apiBase).host;
    this.repoPath = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
    this.isProtected = createPathPolicy(ctx.config.privacy.excludePaths);
  }

  /** Resolve a token and build a client. Never throws because no token was found. */
  static async create(
    ref: PullRequestRef,
    ctx: RunContext,
    options: GitHubClientOptions = {},
  ): Promise<GitHubClient> {
    const stage = options.stage ?? 'source';
    const host = new URL(ref.apiUrl).host;
    const { token, refusedEnv } = await resolveToken(ref, ctx, options.ghPath ?? 'gh');
    if (!token) {
      const reason = refusedEnv
        ? ` GITHUB_TOKEN is only sent to api.github.com or to the host in github.apiUrl, not to ${host}.`
        : '';
      ctx.progress({
        stage,
        status: 'warn',
        message:
          `No GitHub token for ${host}: requests are unauthenticated (public repositories only, 60 requests per hour).` +
          `${reason} Set GITHUB_TOKEN or run "gh auth login" for private repositories.`,
      });
    }
    return new GitHubClient(ref, ctx, token);
  }

  /** Keep the token out of logs, JSON output and debugger dumps. */
  toJSON(): { host: string; authenticated: boolean } {
    return { host: this.apiHost, authenticated: this.authenticated };
  }

  [inspect.custom](): string {
    return `GitHubClient { host: ${this.apiHost}, authenticated: ${this.authenticated} }`;
  }

  // -- reading ---------------------------------------------------------------

  async getRepo(): Promise<GitHubRepo> {
    const response = await this.request({ path: this.repoPath });
    return toRepo(await this.json(response, 'repository'), this.ref);
  }

  async getPullRequest(): Promise<GitHubPullRequest> {
    const response = await this.request({ path: `${this.repoPath}/pulls/${this.ref.number}` });
    return toPullRequest(await this.json(response, 'pull request'));
  }

  /** Compare two commits. The result carries the merge base, which is what pull request patches are relative to. */
  async compare(base: string, head: string): Promise<GitHubComparison> {
    const response = await this.request({
      path: `${this.repoPath}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
      query: { per_page: 1 },
    });
    const data = await this.json(response, 'comparison');
    const mergeBase =
      isRecord(data) && isRecord(data.merge_base_commit) ? asString(data.merge_base_commit.sha) : null;
    if (!isRecord(data) || !mergeBase) throw unexpectedResponse('comparison');
    return {
      mergeBaseSha: mergeBase,
      status: asString(data.status) ?? '',
      aheadBy: asNumber(data.ahead_by) ?? 0,
      behindBy: asNumber(data.behind_by) ?? 0,
    };
  }

  /**
   * The changed files of the pull request, in GitHub's order, at most 3000. Entries that came
   * back without a patch and with zero counts (a page over GitHub's size budget) are requested
   * again one at a time, up to a small limit; the rest stay marked `suspect`.
   */
  async listPullRequestFiles(
    options: { maxFiles?: number } = {},
  ): Promise<{ files: GitHubPrFile[]; capped: boolean }> {
    const max = options.maxFiles ?? MAX_PR_FILES;
    const { items, capped } = await this.paginate(
      `${this.repoPath}/pulls/${this.ref.number}/files`,
      max,
      'file list',
    );
    const files = items.map(toPrFile).filter((file): file is GitHubPrFile => file !== null);

    const suspects = files.flatMap((file, index) => (file.suspect ? [index] : []));
    await Promise.all(
      suspects.slice(0, MAX_PATCH_RECOVERIES).map(async (index) => {
        const response = await this.request({
          path: `${this.repoPath}/pulls/${this.ref.number}/files`,
          query: { per_page: 1, page: index + 1 },
        });
        const again = asArray(await this.json(response, 'file list')).map(toPrFile)[0];
        if (again && again.filename === files[index]!.filename) files[index] = again;
      }),
    );
    return { files, capped };
  }

  /** The pull request's commits, oldest first, at most `maxCommits` (GitHub itself lists at most 250). */
  async listPullRequestCommits(maxCommits: number): Promise<{ commits: GitHubPrCommit[]; capped: boolean }> {
    const { items, capped } = await this.paginate(
      `${this.repoPath}/pulls/${this.ref.number}/commits`,
      maxCommits,
      'commit list',
    );
    const commits: GitHubPrCommit[] = [];
    for (const item of items) {
      if (!isRecord(item)) continue;
      const sha = asString(item.sha);
      const message = isRecord(item.commit) ? asString(item.commit.message) : null;
      if (sha) commits.push({ sha, message: message ?? '' });
    }
    return { commits, capped };
  }

  /**
   * Text content of a file at a commit, or null when the file is missing, binary, bigger than
   * `maxBytes`, or a protected path (sensitive or excluded: never requested, never cached).
   * Content at a full commit id never changes, so it is cached.
   */
  async getFileContent(path: string, ref: string, maxBytes: number): Promise<string | null> {
    const safe = safeRepoPath(path);
    if (safe === null || this.isProtected(safe)) return null;
    const cacheable = isFullSha(ref);
    const key = hashKey({
      host: this.ref.webHost,
      owner: this.ref.owner,
      repo: this.ref.repo,
      sha: ref,
      path: safe,
    });
    if (cacheable) {
      const cached = await this.ctx.cache.get('files', key);
      if (cached) return decodeTextBlob(cached);
    }

    let response: Response;
    try {
      response = await this.request({
        path: `${this.repoPath}/contents/${encodePath(safe)}`,
        query: { ref },
        accept: RAW_ACCEPT,
        allow: [404],
      });
    } catch (error) {
      // Files over 100 MB are refused by the contents API; they are not readable here anyway.
      if (isMergeStoryError(error) && error.details?.errorCode === 'too_large') return null;
      throw error;
    }
    if (response.status === 404) return null;
    // A directory or submodule comes back as a JSON listing, not as raw content.
    const mediaType = response.headers.get('x-github-media-type');
    if (mediaType !== null && !/raw/i.test(mediaType)) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const bytes = await readCapped(response, maxBytes);
    if (bytes === null) return null;
    const text = decodeTextBlob(bytes);
    if (text !== null && cacheable) await this.ctx.cache.put('files', key, bytes);
    return text;
  }

  /** Files and directories of a commit's tree. With `recursive`, GitHub may cut the listing short (`truncated`). */
  async getTree(sha: string, options: { recursive?: boolean } = {}): Promise<GitHubTree> {
    const response = await this.request({
      path: `${this.repoPath}/git/trees/${encodeURIComponent(sha)}`,
      query: options.recursive ? { recursive: 1 } : undefined,
      // 409 means the repository is empty.
      allow: [409],
    });
    if (response.status === 409) {
      await response.body?.cancel().catch(() => undefined);
      return { entries: [], truncated: false };
    }
    const data = await this.json(response, 'tree');
    if (!isRecord(data)) throw unexpectedResponse('tree');
    const entries: GitHubTreeEntry[] = [];
    for (const item of asArray(data.tree)) {
      if (!isRecord(item)) continue;
      const path = asString(item.path);
      const type = asString(item.type);
      if (path && (type === 'blob' || type === 'tree' || type === 'commit')) entries.push({ path, type });
    }
    return { entries, truncated: data.truncated === true };
  }

  /** Run a GraphQL query. The result is the parsed response, errors included: the caller checks them. */
  async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const response = await this.request({
      method: 'POST',
      url: graphqlUrlFor(this.ref.apiUrl),
      body: { query, variables },
      retries: true,
    });
    return this.json(response, 'GraphQL');
  }

  /**
   * One issue of a repository, or null when it is not readable here (no access, gone), or is a
   * pull request: this endpoint also serves those.
   */
  async getIssue(owner: string, repo: string, number: number): Promise<GitHubIssue | null> {
    let response: Response;
    try {
      response = await this.request({
        path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`,
        allow: [403, 404, 410],
      });
    } catch (error) {
      if (this.ctx.signal.aborted) throw error;
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const data = await this.json(response, 'issue');
    if (isRecord(data) && data.pull_request !== undefined) return null;
    return toIssue(data);
  }

  /**
   * Login of the account behind the token, or null when it cannot be told (no token, or an app
   * installation token such as the Actions GITHUB_TOKEN, which may not read /user).
   */
  async getAuthenticatedLogin(): Promise<string | null> {
    if (!this.token) return null;
    try {
      const response = await this.request({ path: '/user' });
      const data = await this.json(response, 'user');
      return isRecord(data) ? asString(data.login) : null;
    } catch (error) {
      if (this.ctx.signal.aborted) throw error;
      return null;
    }
  }

  /**
   * The MergeStory comment written by `authorLogin`: the first comment by that account whose body
   * starts with the marker. Comments by anyone else are never matched, so a comment that merely copies
   * the marker can never be taken over.
   */
  async findCommentByMarker(marker: string, authorLogin: string): Promise<GitHubComment | null> {
    if (!marker || !authorLogin) return null;
    const author = authorLogin.toLowerCase();
    for await (const { items } of this.pages(
      `${this.repoPath}/issues/${this.ref.number}/comments`,
      'comment list',
      MAX_COMMENT_PAGES,
    )) {
      for (const item of items) {
        const comment = toComment(item);
        if (!comment) continue;
        if (comment.authorLogin?.toLowerCase() !== author) continue;
        if (comment.body.trimStart().startsWith(marker)) return comment;
      }
    }
    return null;
  }

  // -- writing ---------------------------------------------------------------

  async createComment(body: string): Promise<GitHubComment> {
    this.assertWritable();
    this.ctx.egress.record(this.apiHost, 'github-comment', Buffer.byteLength(body, 'utf8'), ['comment']);
    const response = await this.request({
      method: 'POST',
      path: `${this.repoPath}/issues/${this.ref.number}/comments`,
      body: { body },
      retries: false,
    });
    const comment = toComment(await this.json(response, 'comment'));
    if (!comment) throw unexpectedResponse('comment');
    return comment;
  }

  async updateComment(id: number, body: string): Promise<GitHubComment> {
    this.assertWritable();
    this.ctx.egress.record(this.apiHost, 'github-comment', Buffer.byteLength(body, 'utf8'), ['comment']);
    const response = await this.request({
      method: 'PATCH',
      path: `${this.repoPath}/issues/comments/${id}`,
      body: { body },
    });
    const comment = toComment(await this.json(response, 'comment'));
    if (!comment) throw unexpectedResponse('comment');
    return comment;
  }

  async updatePullRequestBody(body: string): Promise<void> {
    this.assertWritable();
    this.ctx.egress.record(this.apiHost, 'github-description', Buffer.byteLength(body, 'utf8'), ['comment']);
    const response = await this.request({
      method: 'PATCH',
      path: `${this.repoPath}/pulls/${this.ref.number}`,
      body: { body },
    });
    await response.body?.cancel().catch(() => undefined);
  }

  // -- internals -------------------------------------------------------------

  private assertWritable(): void {
    if (this.ctx.dryRun) {
      throw new MergeStoryError('NOTIFY_FAILED', 'GitHub writes are switched off during a dry run.', {
        hint: 'Run again without --dry-run to post to GitHub.',
      });
    }
    if (!this.token) {
      throw new MergeStoryError('GITHUB_AUTH', 'Writing to GitHub needs a token.', {
        hint: 'Set GITHUB_TOKEN to a token with "Pull requests: write", or run "gh auth login".',
      });
    }
  }

  /** A pagination link is followed only when it stays on the API host, so the token cannot leave it. */
  private followable(url: string | null): string | null {
    if (!url) return null;
    return originOf(url) === originOf(this.apiBase) ? url : null;
  }

  /** The pages of a list, one request each, following Link headers that stay on the API host. */
  private async *pages(path: string, what: string, maxPages: number): AsyncGenerator<Page> {
    let url: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      const response: Response = await this.request(url ? { url } : { path, query: { per_page: 100 } });
      const items = await this.json(response, what);
      if (!Array.isArray(items)) throw unexpectedResponse(what);
      url = this.followable(nextPageUrl(response.headers.get('link')));
      yield { items, more: url !== null };
      if (!url) return;
    }
  }

  /** The first `maxItems` items of a list, and whether GitHub has more. */
  private async paginate(
    path: string,
    maxItems: number,
    what: string,
  ): Promise<{ items: unknown[]; capped: boolean }> {
    const items: unknown[] = [];
    let more = false;
    for await (const page of this.pages(path, what, Math.ceil(maxItems / 30) + 2)) {
      items.push(...page.items);
      more = page.more;
      if (!more || items.length >= maxItems) break;
    }
    const capped = items.length > maxItems || (items.length >= maxItems && more);
    return { items: items.slice(0, maxItems), capped };
  }

  private async json(response: Response, what: string): Promise<unknown> {
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw unreadableResponse(what, response.status);
    }
  }

  private buildUrl(path: string, query?: Record<string, string | number>): string {
    const url = new URL(`${this.apiBase}${path}`);
    if (query) for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    return url.toString();
  }

  private async request(spec: RequestSpec): Promise<Response> {
    const method = spec.method ?? 'GET';
    const url = 'url' in spec ? spec.url : this.buildUrl(spec.path, spec.query);
    const headers: Record<string, string> = {
      Accept: spec.accept ?? JSON_ACCEPT,
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      'User-Agent': `mergestory/${ENGINE_VERSION}`,
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let body: string | undefined;
    if (spec.body !== undefined) {
      body = JSON.stringify(spec.body);
      headers['Content-Type'] = 'application/json';
    }
    const retries = spec.retries ?? method !== 'POST';

    for (let attempt = 0; ; attempt++) {
      const started = Date.now();
      let response: Response;
      try {
        response = await this.limiter.run(() =>
          fetchWithRetry(
            url,
            { method, headers, body },
            { signal: this.ctx.signal, allowStatus: PASS_THROUGH_STATUSES, attempts: retries ? 4 : 1 },
          ),
        );
      } catch (error) {
        throw this.ctx.signal.aborted ? error : transportFailure(error, url);
      }
      this.ctx.logger.debug('github request', {
        method,
        path: describePath(url),
        status: response.status,
        ms: Date.now() - started,
      });
      this.noteRateLimit(response);
      if (response.ok || spec.allow?.includes(response.status)) return response;
      const failure = describeFailure({
        status: response.status,
        headers: response.headers,
        text: await response.text().catch(() => ''),
        method,
        url,
        authenticated: this.authenticated,
        redact: (text) => this.ctx.redactor.redact(text),
      });
      if (failure.retryAfterMs !== null && attempt < MAX_RATE_LIMIT_RETRIES) {
        this.ctx.logger.debug('github secondary rate limit; waiting', { ms: failure.retryAfterMs });
        await sleep(failure.retryAfterMs, this.ctx.signal);
        continue;
      }
      throw failure.error;
    }
  }

  private noteRateLimit(response: Response): void {
    const remaining = Number(response.headers.get('x-ratelimit-remaining'));
    if (
      !this.warnedLowRateLimit &&
      response.headers.get('x-ratelimit-remaining') !== null &&
      remaining <= 5
    ) {
      this.warnedLowRateLimit = true;
      this.ctx.logger.warn(`GitHub rate limit is almost used up (${remaining} requests left).`);
    }
  }
}
