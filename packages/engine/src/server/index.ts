/**
 * HTTP API: start a job, check it, list recent ones. Built on node:http only.
 *
 *   GET  /v1/health        {ok, version}
 *   POST /v1/jobs          start a job (202 {id, status})
 *   GET  /v1/jobs/:id      one job
 *   GET  /v1/jobs          recent jobs
 *
 * Safe by default: it listens on loopback only, refuses to listen elsewhere without a token, checks
 * the token in constant time, checks the Host header on loopback (DNS rebinding), sends no CORS
 * headers, and accepts a local repository only when it is inside a directory the operator allowed.
 * Jobs run one at a time inside this process.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Config, resolveConfig } from '../core/config.ts';
import { MergeStoryError } from '../core/errors.ts';
import { createLogger, type Logger } from '../core/logger.ts';
import { isLoopbackAddress } from '../core/net.ts';
import { globalRedactor } from '../core/redact.ts';
import { hasLongRunDeep, isTooDeep, MAX_NESTING, MAX_UNBROKEN_RUN } from '../jobs/input-rules.ts';
import type { JobOptions } from '../jobs/model.ts';
import { defaultJobStore, type RunJobOptions, runJob } from '../jobs/runner.ts';
import { isValidJobId, type JobStore } from '../jobs/store.ts';
import { maskContext, publicJob, summarizeJob } from '../jobs/view.ts';
import { ENGINE_VERSION } from '../version.ts';
import { type Authenticator, allowedHostNames, createAuthenticator, hostHeaderAllowed } from './auth.ts';
import { ApiError, isJsonContentType, readRequestBody, sendJson, toApiError } from './http.ts';
import { JobQueue } from './queue.ts';
import { MAX_BODY_BYTES, parseCreateJob } from './schema.ts';
import { resolveAllowRoots, resolveApiSource } from './source.ts';

export { MAX_BODY_BYTES } from './schema.ts';

/** Options of `startServer`. */
export interface StartServerOptions {
  /** Default 127.0.0.1. Any other address needs a token. */
  host?: string;
  /** Default 7171. Use 0 for any free port. */
  port?: number;
  /** Bearer token. When set, every request must send it. At least 16 characters. */
  token?: string | null;
  /**
   * More names accepted in the Host header of a loopback server, for a reverse proxy on this
   * machine that passes on the name it was reached by. Without them, only loopback names are.
   */
  allowedHosts?: string[];
  /** Directories that local repositories may live in. Without any, only pull requests are accepted. */
  allowRoots?: string[];
  /** Config file the jobs use. */
  configPath?: string | null;
  /** MergeStory home that holds the job files. */
  home?: string | null;
  store?: JobStore;
  logger?: Logger;
  /** Close the server when this signal is aborted. */
  signal?: AbortSignal;
  /** Also close on SIGINT and SIGTERM. For programs that do not handle signals themselves. */
  shutdownOnSignals?: boolean;
  /** How many jobs may wait behind the running one. Default 20. */
  maxQueued?: number;
  /** Replaces the job runner (for tests). */
  runJob?: (jobId: string, options: RunJobOptions) => Promise<unknown>;
}

/** A running server. */
export interface ServerHandle {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  /** Resolves when the server has shut down. */
  readonly closed: Promise<void>;
  /** Stop accepting requests, cancel the running job, fail the queued ones. Safe to call twice. */
  close(): Promise<void>;
}

const JOB_PATH = /^\/v1\/jobs\/([^/]+)$/;
const MIN_TOKEN_LENGTH = 16;
const SHUTDOWN_GRACE_MS = 10_000;

function allow(method: string, methods: string[]): void {
  if (methods.includes(method)) return;
  throw new ApiError(405, 'METHOD_NOT_ALLOWED', `${method} is not allowed here.`, {
    headers: { Allow: methods.join(', ') },
  });
}

function splitUrl(raw: string | undefined): { path: string; query: URLSearchParams } {
  const url = raw ?? '/';
  if (!url.startsWith('/')) throw new ApiError(400, 'USAGE', 'The request target is not valid.');
  const mark = url.indexOf('?');
  const path = mark === -1 ? url : url.slice(0, mark);
  return {
    path: path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path,
    query: new URLSearchParams(mark === -1 ? '' : url.slice(mark + 1)),
  };
}

function listenError(err: NodeJS.ErrnoException, host: string, port: number): MergeStoryError {
  if (err.code === 'EADDRINUSE') {
    return new MergeStoryError('USAGE', `Port ${port} is already in use on ${host}.`, {
      cause: err,
      hint: 'Choose another port with --port <number>.',
    });
  }
  if (err.code === 'EACCES' || err.code === 'EADDRNOTAVAIL') {
    return new MergeStoryError('USAGE', `Cannot listen on ${host}:${port}: ${err.message}`, {
      cause: err,
      hint: 'Check --host and --port.',
    });
  }
  return new MergeStoryError('INTERNAL', `The server could not start: ${err.message}`, { cause: err });
}

/** What the request handlers share. */
interface RequestDeps {
  store: JobStore;
  queue: JobQueue;
  logger: Logger;
  allowRoots: string[];
  allowedHosts: Set<string>;
  authenticator: Authenticator | null;
  configPath: string | null | undefined;
  /** The server listens on a loopback address. */
  loopback: boolean;
}

/** Refuses settings that are not safe or do not make sense. */
function checkSettings(host: string, port: number, token: string | null): void {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new MergeStoryError('USAGE', `${port} is not a valid port.`, {
      hint: 'Use a number from 0 to 65535.',
    });
  }
  if (!isLoopbackAddress(host) && !token) {
    throw new MergeStoryError('CONFIG_INVALID', `Refusing to listen on ${host} without an API token.`, {
      hint:
        'Set MERGESTORY_API_TOKEN (or the variable named by --token-env) to a long random value, ' +
        'for example the output of: openssl rand -hex 24. Or listen on 127.0.0.1 only.',
    });
  }
  // Short tokens can be guessed, even from a web page on this machine, so the minimum applies on
  // loopback too.
  if (token && token.length < MIN_TOKEN_LENGTH) {
    throw new MergeStoryError('CONFIG_INVALID', 'The API token is too short.', {
      hint: `Use at least ${MIN_TOKEN_LENGTH} characters, for example the output of: openssl rand -hex 24`,
    });
  }
}

/** Providers whose sign-in belongs to the operator: an API job never uses them, also not as a default. */
const OPERATOR_PROVIDERS = new Set(['youtube', 'drive']);

/**
 * Fix the job's publish provider now. A request that names none gets the server's default, which
 * the environment or the config file may set; a default of YouTube or Google Drive would upload
 * with the operator's own sign-in, so it is refused.
 */
function pinPublishProvider(job: JobOptions): void {
  let provider: string;
  try {
    provider = resolveConfig({ overrides: job.config, configPath: job.configPath ?? null }).publish.provider;
  } catch {
    // The job itself reports a settings problem when it runs; until then nothing may be uploaded.
    provider = job.config?.publish?.provider ?? 'local';
  }
  if (OPERATOR_PROVIDERS.has(provider)) {
    throw new ApiError(
      403,
      'FORBIDDEN',
      `This server's default publish provider is ${provider}, which the HTTP API never uses.`,
      {
        hint: 'Send "options": {"publish": {"provider": "local"}} (or "s3"), or start the server without MERGESTORY_PUBLISH_PROVIDER set to youtube or drive.',
      },
    );
  }
  job.config = {
    ...job.config,
    publish: { ...job.config?.publish, provider: provider as Config['publish']['provider'] },
  };
}

async function createJob(deps: RequestDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { store, queue, logger } = deps;
  if (!isJsonContentType(req.headers['content-type'])) {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the body as application/json.');
  }
  const raw = await readRequestBody(req, MAX_BODY_BYTES);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new ApiError(400, 'USAGE', 'The request body is not valid JSON.');
  }
  // Deep nesting is refused here, before anything walks or copies the body and runs out of stack.
  if (isTooDeep(body)) {
    throw new ApiError(400, 'USAGE', `The request body is nested more than ${MAX_NESTING} levels deep.`, {
      hint: 'Remove it or keep only the relevant part.',
    });
  }
  // The secret scan is slow on very long unbroken strings, and it runs on this thread. The check
  // looks at the decoded strings, so escape sequences cannot hide a long run.
  if (hasLongRunDeep(body)) {
    throw new ApiError(
      400,
      'USAGE',
      `The request body contains an unbroken string of more than ${MAX_UNBROKEN_RUN} characters.`,
      { hint: 'Remove it or keep only the relevant part.' },
    );
  }
  const parsed = parseCreateJob(body);
  if (!parsed.ok)
    throw new ApiError(400, 'USAGE', 'The request body is not valid.', { issues: parsed.issues });
  if (queue.isFull) {
    throw new ApiError(503, 'QUEUE_FULL', 'Too many jobs are waiting.', {
      hint: 'Try again in a few minutes.',
      headers: { 'Retry-After': '60' },
    });
  }
  const jobOptions: JobOptions = {
    ...parsed.value,
    source: await resolveApiSource(parsed.value, deps.allowRoots, process.cwd()),
  };
  if (jobOptions.context) {
    const masked = maskContext(jobOptions.context);
    if (masked.masked > 0)
      logger.warn(`Masked ${masked.masked} secret-like value(s) in the request context.`);
    jobOptions.context = masked.context;
  }
  if (deps.configPath) jobOptions.configPath = deps.configPath;
  pinPublishProvider(jobOptions);

  // This process owns the job, so a read after it has died reports the job as failed.
  const job = await store.create(jobOptions, { pid: process.pid });
  if (!queue.enqueue(job.id)) {
    // The queue filled up or the server began shutting down while the job was being created.
    await store
      .fail(job.id, new MergeStoryError('ABORTED', 'The server could not accept this job.'))
      .catch(() => undefined);
    throw new ApiError(503, 'QUEUE_FULL', 'The server cannot take new jobs right now.', {
      hint: 'Try again in a few minutes.',
      headers: { 'Retry-After': '60' },
    });
  }
  logger.info('Job accepted', { jobId: job.id });
  sendJson(res, 202, { id: job.id, status: job.status }, { Location: `/v1/jobs/${job.id}` });
}

async function listJobs(deps: RequestDeps, query: URLSearchParams, res: ServerResponse): Promise<void> {
  const limit = Number(query.get('limit') ?? 20);
  const jobs = await deps.store.list(Number.isFinite(limit) ? limit : 20);
  sendJson(res, 200, { jobs: jobs.map(summarizeJob) });
}

async function route(deps: RequestDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const { path, query } = splitUrl(req.url);
  if (path === '/v1/health') {
    allow(method, ['GET']);
    sendJson(res, 200, { ok: true, version: ENGINE_VERSION });
    return;
  }
  if (path === '/v1/jobs') {
    allow(method, ['GET', 'POST']);
    if (method === 'POST') await createJob(deps, req, res);
    else await listJobs(deps, query, res);
    return;
  }
  const match = JOB_PATH.exec(path);
  if (match) {
    allow(method, ['GET']);
    const id = match[1] as string;
    if (!isValidJobId(id)) throw new ApiError(404, 'JOB_NOT_FOUND', 'No such job.');
    sendJson(res, 200, publicJob(await deps.store.get(id)));
    return;
  }
  throw new ApiError(404, 'NOT_FOUND', 'No such route.');
}

/** Checks who is asking, answers the request, and turns any failure into the right error response. */
async function handle(deps: RequestDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { logger, authenticator } = deps;
  const started = Date.now();
  try {
    // Checked with or without a token: a page that rebinds its name to 127.0.0.1 could otherwise
    // keep guessing the token. Other addresses need a token and are reached by many names.
    if (deps.loopback && !hostHeaderAllowed(req.headers.host, deps.allowedHosts)) {
      throw new ApiError(403, 'FORBIDDEN', 'This Host header is not allowed.', {
        hint: 'Use 127.0.0.1 or localhost in the address. A reverse proxy in front of the API must pass one of them as the Host header, or its name must be allowed when the server starts (mergestory serve --allow-host <name>).',
      });
    }
    if (authenticator && !authenticator.check(req.headers.authorization)) {
      throw new ApiError(401, 'UNAUTHORIZED', 'A valid bearer token is required.', {
        headers: { 'WWW-Authenticate': 'Bearer' },
      });
    }
    await route(deps, req, res);
  } catch (err) {
    const answer = err instanceof ApiError ? err : toApiError(err);
    if (res.headersSent || res.destroyed) {
      res.destroy();
    } else if (answer) {
      sendJson(res, answer.status, answer.body(), answer.headers);
    } else {
      logger.error('Request failed', { error: err instanceof Error ? err.message : String(err) });
      sendJson(res, 500, new ApiError(500, 'INTERNAL', 'Something went wrong on the server.').body());
    }
  } finally {
    logger.debug('request', { method: req.method, status: res.statusCode, ms: Date.now() - started });
  }
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => reject(listenError(err, host, port));
    server.once('error', onError);
    server.listen({ host, port }, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

/** Start the HTTP API. Rejects when the settings are not safe, for example a network address without a token. */
export async function startServer(options: StartServerOptions = {}): Promise<ServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 7171;
  const token = options.token?.trim() || null;
  const logger = options.logger ?? createLogger({ level: 'silent' });
  const loopback = isLoopbackAddress(host);

  checkSettings(host, port, token);
  const allowedHosts = allowedHostNames(host, options.allowedHosts ?? []);
  if (token) globalRedactor.add(token);

  const allowRoots = await resolveAllowRoots(options.allowRoots ?? []);
  const store = options.store ?? defaultJobStore(options.home);
  // An earlier server with this pid (process 1 in a restarted container, for example) may have
  // left jobs that no queue will ever run. Jobs this process creates are newer than its start.
  const startedAt = new Date(Date.now() - process.uptime() * 1000);
  const orphans = await store.failOrphans(process.pid, startedAt);
  if (orphans > 0) logger.warn(`Marked ${orphans} unfinished job(s) of an earlier server as failed.`);
  const execute = options.runJob ?? runJob;

  const queue = new JobQueue({
    maxPending: options.maxQueued ?? 20,
    run: (jobId, signal) => execute(jobId, { store, signal, logger }),
    fail: (jobId, error) => store.fail(jobId, error),
  });
  const deps: RequestDeps = {
    store,
    queue,
    logger,
    allowRoots,
    allowedHosts,
    authenticator: token ? createAuthenticator(token) : null,
    configPath: options.configPath,
    loopback,
  };

  const server: Server = createServer((req, res) => {
    void handle(deps, req, res);
  });
  // A request is at most 256 KB, so a client that is slower than this is not a client.
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = 128;

  await listen(server, host, port);

  server.on('error', (err) => logger.error('Server error', { error: err.message }));
  const address = server.address() as AddressInfo;
  const shownHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const url = `http://${shownHost}:${address.port}`;
  if (!loopback) {
    logger.warn('Listening on a network address over plain HTTP. Put a TLS proxy in front of it.', { host });
  }
  logger.info('API listening', { url, auth: token ? 'token' : 'none', roots: allowRoots.length });

  let closing: Promise<void> | null = null;
  const signalHandlers: [NodeJS.Signals, () => void][] = [];
  const closed = new Promise<void>((resolve) => server.once('close', resolve));

  const close = (): Promise<void> => {
    closing ??= (async () => {
      for (const [name, handler] of signalHandlers) process.off(name, handler);
      logger.info('API shutting down');
      server.close();
      server.closeIdleConnections();
      await queue.close(SHUTDOWN_GRACE_MS);
      const force = setTimeout(() => server.closeAllConnections(), 2_000);
      force.unref();
      await closed;
      clearTimeout(force);
    })();
    return closing;
  };

  if (options.shutdownOnSignals) {
    for (const name of ['SIGINT', 'SIGTERM'] as const) {
      const handler = (): void => void close();
      signalHandlers.push([name, handler]);
      process.once(name, handler);
    }
  }
  if (options.signal) {
    if (options.signal.aborted) void close();
    else options.signal.addEventListener('abort', () => void close(), { once: true });
  }

  return { host, port: address.port, url, closed, close };
}
