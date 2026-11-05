/**
 * Helpers for the YouTube tests: a fake Google server on 127.0.0.1 (token endpoint, resumable
 * uploads, thumbnails, captions, playlists) and fixtures. Not part of the build.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PublishBundle, PublishMeta } from '../core/providers.ts';
import { publishMeta, writeBundle } from './publish.ts';

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

export type FakeReply =
  | { kind: 'json'; status: number; body?: unknown; headers?: Record<string, string> }
  /** Cut the connection without an answer. */
  | { kind: 'drop' }
  /** Keep only the first bytes of a chunk, then cut the connection (an interrupted upload). */
  | { kind: 'store-then-drop'; storeBytes: number }
  /** Keep every byte of a chunk, then cut the connection before the answer (the answer is lost). */
  | { kind: 'store-all-then-drop' };

interface Interceptor {
  match: (request: RecordedRequest) => boolean;
  times: number;
  reply: FakeReply;
}

interface Session {
  id: string;
  kind: 'video' | 'captions';
  total: number;
  chunks: Buffer[];
  received: number;
  metadata: unknown;
  complete: boolean;
}

export interface FakeGoogleOptions {
  clientId?: string;
  clientSecret?: string | null;
  refreshToken?: string;
  scope?: string;
  videoId?: string;
  /** What the fake reports as the privacy status, whatever was requested. */
  privacyStatus?: string;
}

export const FAKE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
export const FAKE_CLIENT_SECRET = 'test-client-secret-value-0123';
export const FAKE_REFRESH_TOKEN = 'test-refresh-token-value-0123456789';
export const FAKE_VIDEO_ID = 'dQw4w9WgXcQ';
export const UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
export const FORCE_SSL_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';

function readAll(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on('data', (chunk: Buffer) => parts.push(chunk));
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

function replyJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=UTF-8', ...headers });
  res.end(text);
}

/** The error body Google sends for the YouTube API. */
export function googleError(status: number, reason: string, message = 'Something went wrong.'): FakeReply {
  return {
    kind: 'json',
    status,
    body: { error: { code: status, message, errors: [{ message, domain: 'youtube.test', reason }] } },
  };
}

/** The error body of the OAuth token endpoint. */
export function oauthError(status: number, error: string, description = ''): FakeReply {
  return { kind: 'json', status, body: { error, error_description: description } };
}

/** A fake of the Google services MergeStory talks to. */
export class FakeGoogle {
  readonly requests: RecordedRequest[] = [];
  readonly sessions = new Map<string, Session>();
  url = '';
  tokensIssued = 0;
  private readonly server: Server;
  private readonly interceptors: Interceptor[] = [];
  private readonly options: Required<Omit<FakeGoogleOptions, 'privacyStatus'>> & {
    privacyStatus: string | null;
  };
  private authCodes = new Map<string, { challenge: string; redirectUri: string }>();

  constructor(options: FakeGoogleOptions = {}) {
    this.options = {
      clientId: options.clientId ?? FAKE_CLIENT_ID,
      clientSecret: options.clientSecret === undefined ? FAKE_CLIENT_SECRET : options.clientSecret,
      refreshToken: options.refreshToken ?? FAKE_REFRESH_TOKEN,
      scope: options.scope ?? UPLOAD_SCOPE,
      videoId: options.videoId ?? FAKE_VIDEO_ID,
      privacyStatus: options.privacyStatus ?? null,
    };
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(() => res.destroy());
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** The access token the n-th token request receives (1-based). */
  accessToken(n: number): string {
    return `ya29.test-access-token-${String(n).padStart(4, '0')}`;
  }

  /** Make the next `times` requests that match get `reply` instead of the normal answer. */
  intercept(match: (request: RecordedRequest) => boolean, reply: FakeReply, times = 1): void {
    this.interceptors.push({ match, times, reply });
  }

  /** Accept this sign-in code at the token endpoint, if the verifier belongs to `challenge`. */
  expectAuthCode(code: string, challenge: string, redirectUri: string): void {
    this.authCodes.set(code, { challenge, redirectUri });
  }

  requestsTo(method: string, path: string): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method && r.path === path);
  }

  /** Bytes the fake received for the n-th session of a kind. */
  uploaded(kind: 'video' | 'captions', n = 0): Buffer {
    const session = [...this.sessions.values()].filter((s) => s.kind === kind)[n];
    return session ? Buffer.concat(session.chunks) : Buffer.alloc(0);
  }

  sessionMetadata(kind: 'video' | 'captions', n = 0): unknown {
    return [...this.sessions.values()].filter((s) => s.kind === kind)[n]?.metadata;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readAll(req);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const request: RecordedRequest = {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      body,
    };
    this.requests.push(request);
    const interceptor = this.interceptors.find((i) => i.times > 0 && i.match(request));
    if (interceptor) {
      interceptor.times -= 1;
      this.apply(interceptor.reply, request, req, res);
      return;
    }
    this.route(request, res);
  }

  private apply(reply: FakeReply, request: RecordedRequest, req: IncomingMessage, res: ServerResponse): void {
    if (reply.kind === 'json') {
      replyJson(res, reply.status, reply.body, reply.headers);
    } else if (reply.kind === 'drop') {
      req.socket.destroy();
    } else {
      const session = this.sessions.get(request.query.get('upload_id') ?? '');
      if (session)
        this.store(
          session,
          request,
          reply.kind === 'store-then-drop' ? reply.storeBytes : Number.POSITIVE_INFINITY,
        );
      req.socket.destroy();
    }
  }

  private authorised(request: RecordedRequest): boolean {
    return /^Bearer ya29\.test-access-token-\d{4}$/.test(String(request.headers.authorization ?? ''));
  }

  private route(request: RecordedRequest, res: ServerResponse): void {
    const { method, path } = request;
    if (method === 'POST' && path === '/token') {
      this.token(request, res);
      return;
    }
    if (!this.authorised(request)) {
      const reply = googleError(401, 'authError', 'Invalid Credentials');
      if (reply.kind === 'json') replyJson(res, reply.status, reply.body);
      return;
    }
    const upload = /^\/upload\/youtube\/v3\/(videos|captions)$/.exec(path);
    if (method === 'POST' && upload && request.query.get('uploadType') === 'resumable') {
      this.startSession(upload[1] === 'videos' ? 'video' : 'captions', request, res);
      return;
    }
    if (method === 'PUT' && upload) {
      this.putChunk(request, res);
      return;
    }
    if (method === 'POST' && path === '/upload/youtube/v3/thumbnails/set') {
      replyJson(res, 200, { kind: 'youtube#thumbnailSetResponse', items: [{ default: { url: 'x' } }] });
      return;
    }
    if (method === 'POST' && path === '/youtube/v3/playlistItems') {
      replyJson(res, 200, { kind: 'youtube#playlistItem', id: 'item-1' });
      return;
    }
    replyJson(res, 404, { error: { code: 404, message: 'Not found', errors: [{ reason: 'notFound' }] } });
  }

  private token(request: RecordedRequest, res: ServerResponse): void {
    const form = new URLSearchParams(request.body.toString('utf8'));
    const { clientId, clientSecret, refreshToken, scope } = this.options;
    if (form.get('client_id') !== clientId || (clientSecret && form.get('client_secret') !== clientSecret)) {
      replyJson(res, 401, {
        error: 'invalid_client',
        error_description: 'The OAuth client was not found.',
      });
      return;
    }
    if (form.get('grant_type') === 'refresh_token') {
      if (form.get('refresh_token') !== refreshToken) {
        replyJson(res, 400, {
          error: 'invalid_grant',
          error_description: 'Token has been expired or revoked.',
        });
        return;
      }
      this.tokensIssued += 1;
      replyJson(res, 200, {
        access_token: this.accessToken(this.tokensIssued),
        expires_in: 3599,
        scope,
        token_type: 'Bearer',
      });
      return;
    }
    if (form.get('grant_type') === 'authorization_code') {
      const expected = this.authCodes.get(form.get('code') ?? '');
      const verifier = form.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (
        !expected ||
        expected.challenge !== challenge ||
        expected.redirectUri !== form.get('redirect_uri')
      ) {
        replyJson(res, 400, { error: 'invalid_grant', error_description: 'Bad Request' });
        return;
      }
      this.authCodes.delete(form.get('code') ?? '');
      this.tokensIssued += 1;
      replyJson(res, 200, {
        access_token: this.accessToken(this.tokensIssued),
        refresh_token: refreshToken,
        expires_in: 3599,
        scope,
        token_type: 'Bearer',
      });
      return;
    }
    replyJson(res, 400, { error: 'unsupported_grant_type' });
  }

  private startSession(kind: 'video' | 'captions', request: RecordedRequest, res: ServerResponse): void {
    const total = Number(request.headers['x-upload-content-length']);
    const id = randomUUID().replace(/-/g, '');
    let metadata: unknown = null;
    try {
      metadata = JSON.parse(request.body.toString('utf8'));
    } catch {
      // left as null
    }
    this.sessions.set(id, { id, kind, total, chunks: [], received: 0, metadata, complete: false });
    const path = kind === 'video' ? 'videos' : 'captions';
    res.writeHead(200, {
      Location: `${this.url}/upload/youtube/v3/${path}?uploadType=resumable&upload_id=${id}`,
      'Content-Length': '0',
    });
    res.end();
  }

  /** Append a chunk (up to `limit` bytes of it) to the session. */
  private store(session: Session, request: RecordedRequest, limit: number): void {
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(request.headers['content-range'] ?? ''));
    if (!range || Number(range[1]) !== session.received) return;
    const data = request.body.subarray(0, Math.min(request.body.length, limit));
    session.chunks.push(Buffer.from(data));
    session.received += data.length;
    if (session.received >= session.total) session.complete = true;
  }

  private resource(session: Session): unknown {
    if (session.kind === 'captions') return { kind: 'youtube#caption', id: 'caption-1' };
    const meta = (session.metadata ?? {}) as {
      snippet?: Record<string, unknown>;
      status?: Record<string, unknown>;
    };
    return {
      kind: 'youtube#video',
      id: this.options.videoId,
      snippet: { ...meta.snippet, channelId: 'UC-test', channelTitle: 'Test channel' },
      status: {
        uploadStatus: 'uploaded',
        ...meta.status,
        privacyStatus: this.options.privacyStatus ?? meta.status?.privacyStatus,
      },
    };
  }

  private putChunk(request: RecordedRequest, res: ServerResponse): void {
    const session = this.sessions.get(request.query.get('upload_id') ?? '');
    if (!session) {
      replyJson(res, 404, { error: { code: 404, message: 'Not Found' } });
      return;
    }
    const contentRange = String(request.headers['content-range'] ?? '');
    if (/^bytes \*\/\d+$/.test(contentRange)) {
      if (session.complete) {
        replyJson(res, 200, this.resource(session));
        return;
      }
      this.incomplete(session, res);
      return;
    }
    const wasComplete = session.complete;
    this.store(session, request, Number.POSITIVE_INFINITY);
    if (session.complete && !wasComplete) {
      replyJson(res, 201, this.resource(session));
      return;
    }
    this.incomplete(session, res);
  }

  private incomplete(session: Session, res: ServerResponse): void {
    const headers: Record<string, string> = { 'Content-Length': '0' };
    if (session.received > 0) headers.Range = `bytes=0-${session.received - 1}`;
    res.writeHead(308, headers);
    res.end();
  }
}

export async function startFakeGoogle(options: FakeGoogleOptions = {}): Promise<FakeGoogle> {
  return new FakeGoogle(options).start();
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export interface BundleOptions {
  videoBytes?: number;
  poster?: string | false;
  captions?: false;
  /** null leaves out the text for YouTube. */
  meta?: PublishMeta | null;
  repoIsPrivate?: boolean | null;
}

/** Write a video bundle into `dir` and describe it. The repository is public unless the options say so. */
export async function makeBundle(
  dir: string,
  options: BundleOptions = {},
): Promise<{ bundle: PublishBundle; video: Buffer }> {
  const { bundle, video } = await writeBundle({
    dir,
    video: options.videoBytes ?? 600 * 1024,
    poster: options.poster,
    captions: options.captions ?? 'WEBVTT\n\n00:00.000 --> 00:02.000\nHello\n',
    repoIsPrivate: options.repoIsPrivate === undefined ? false : options.repoIsPrivate,
    meta: options.meta === null ? undefined : (options.meta ?? publishMeta()),
  });
  return { bundle, video };
}

export async function makeTempDir(prefix = 'mergestory-yt-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Tiny delays, so retries do not slow the tests down. */
export const FAST_TIMING = { maxRetries: 4, minDelayMs: 1, maxDelayMs: 5, requestTimeoutMs: 5_000 } as const;
