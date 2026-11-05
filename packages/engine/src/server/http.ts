/** Small helpers for the HTTP API: JSON responses, bounded request bodies, and API errors. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isMergeStoryError } from '../core/errors.ts';

/** Error codes of the API: the engine codes plus the HTTP-specific ones. */
export type ApiErrorCode =
  | 'USAGE'
  | 'SOURCE_INVALID'
  | 'JOB_NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'QUEUE_FULL'
  | 'INTERNAL';

/** One problem with a request body. */
export interface ApiIssue {
  path: string;
  message: string;
  code: string;
}

/** An error that maps to one HTTP response. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly hint: string | undefined;
  readonly issues: ApiIssue[] | undefined;
  readonly headers: Record<string, string>;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    extra: { hint?: string; issues?: ApiIssue[]; headers?: Record<string, string> } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.hint = extra.hint;
    this.issues = extra.issues;
    this.headers = extra.headers ?? {};
  }

  body(): { ok: false; error: { code: ApiErrorCode; message: string; hint?: string; issues?: ApiIssue[] } } {
    const error: { code: ApiErrorCode; message: string; hint?: string; issues?: ApiIssue[] } = {
      code: this.code,
      message: this.message,
    };
    if (this.hint) error.hint = this.hint;
    if (this.issues) error.issues = this.issues;
    return { ok: false, error };
  }
}

/**
 * The API's answer for an engine error that is the caller's doing, or null for any other error.
 * `code` replaces the code of a 400 (a source that is refused is always SOURCE_INVALID).
 */
export function toApiError(err: unknown, code?: ApiErrorCode): ApiError | null {
  if (!isMergeStoryError(err)) return null;
  const extra = err.hint ? { hint: err.hint } : {};
  switch (err.code) {
    case 'USAGE':
    case 'SOURCE_INVALID':
      return new ApiError(400, code ?? err.code, err.message, extra);
    case 'JOB_NOT_FOUND':
      return new ApiError(404, 'JOB_NOT_FOUND', 'No such job.');
    default:
      return null;
  }
}

/** Every response is JSON, uncacheable, and carries no CORS headers: browsers cannot call the API from other sites. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

function tooLarge(limit: number): ApiError {
  return new ApiError(
    413,
    'PAYLOAD_TOO_LARGE',
    `The request body is larger than ${Math.round(limit / 1024)} KB.`,
    {
      headers: { Connection: 'close' },
    },
  );
}

/** Read a request body of at most `limit` bytes. Rejects with a 413 as soon as the limit is passed. */
export function readRequestBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = req.headers['content-length'];
    if (declared !== undefined) {
      const length = Number(declared);
      if (!Number.isInteger(length) || length < 0) {
        reject(new ApiError(400, 'USAGE', 'The Content-Length header is not valid.'));
        return;
      }
      if (length > limit) {
        reject(tooLarge(limit));
        return;
      }
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error: Error | null, body?: Buffer): void => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      if (error) reject(error);
      else resolve(body as Buffer);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        finish(tooLarge(limit));
        // Keep reading and discard, so the client can finish sending and still receive the answer.
        req.resume();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => finish(null, Buffer.concat(chunks));
    const onError = (err: Error): void => finish(err);
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/** true when the Content-Type is application/json (with any parameters, such as a charset). */
export function isJsonContentType(header: string | undefined): boolean {
  if (!header) return false;
  return header.split(';')[0]?.trim().toLowerCase() === 'application/json';
}
