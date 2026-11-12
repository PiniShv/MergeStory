/**
 * Resumable uploads for the Google APIs (plain HTTP, no client library).
 *
 *   1. POST the metadata to the start address; the answer carries a session address (Location).
 *   2. PUT the file to the session address in chunks. Every chunk but the last is a multiple of
 *      256 KiB. Google answers 308 with a Range header until the last byte is in, then 200 or 201
 *      with the new resource.
 *   3. After any failure, ask Google how many bytes it has (an empty PUT with "bytes *\/total")
 *      and carry on from there. Never assume that a failed request stored all or none of its bytes.
 *
 * Failures that may pass (no answer, 408, 429, 5xx) are retried with backoff. Anything else stops
 * the upload. A cancelled run stops it at once.
 */
import { open } from 'node:fs/promises';
import { assertNotAborted, MergeStoryError } from '../../core/errors.ts';
import type { Redactor } from '../../core/redact.ts';
import { backoffMs } from '../../core/retry.ts';
import {
  callApi,
  GoogleApiError,
  parseApiFailure,
  pause,
  readAnswerBody,
  sendRequest,
  type Timing,
  type TokenProvider,
} from './google-api.ts';

/** Google wants chunk sizes in whole units of 256 KiB. */
export const CHUNK_UNIT = 256 * 1024;
export const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;
/** The slowest connection the timeout allows for: this many bytes per second. */
const MIN_BYTES_PER_SEC = 20_000;

export interface ResumableUpload {
  /** The service, for messages: "YouTube". */
  label: string;
  /** The address that starts the session (it already carries uploadType=resumable). */
  startUrl: string;
  /** The JSON resource sent with the start request. */
  metadata: unknown;
  filePath: string;
  sizeBytes: number;
  contentType: string;
  chunkBytes: number;
  tokens: TokenProvider;
  signal: AbortSignal;
  timing: Timing;
  redactor: Pick<Redactor, 'add'>;
  /** A chunk is about to be sent. Counts every byte that leaves the machine, re-sent ones too. */
  onBytesSent?: (bytes: number) => void;
  /** Bytes that Google has confirmed so far. */
  onProgress?: (confirmedBytes: number, totalBytes: number) => void;
  /** A failure is about to be retried after a pause. */
  onRetry?: (info: { failures: number; reason: string }) => void;
}

export interface UploadOutcome {
  status: number;
  /** The new resource, as Google sent it (not validated). */
  json: unknown;
}

function fail(message: string, hint: string, details?: Record<string, unknown>): MergeStoryError {
  return new MergeStoryError('PUBLISH_FAILED', message, { hint, ...(details ? { details } : {}) });
}

/** The session address must stay on the API's own origin or on googleapis.com, because the token is sent to it. */
export function checkedSessionUrl(location: string, startUrl: string, label: string): string {
  let url: URL;
  try {
    url = new URL(location, startUrl);
  } catch {
    throw fail(`${label} sent an upload address that cannot be read.`, 'Try again in a few minutes.');
  }
  const sameOrigin = url.origin === new URL(startUrl).origin;
  const google = url.protocol === 'https:' && /(^|\.)googleapis\.com$/i.test(url.hostname);
  if (!sameOrigin && !google) {
    throw fail(
      `${label} sent an upload address on an unexpected host, so the upload was stopped.`,
      'Check your network for a proxy that changes responses, then try again.',
    );
  }
  return url.href;
}

/** The number of bytes Google has, from "Range: bytes=0-N". No header means nothing arrived yet. */
export function confirmedBytes(range: string | null, label: string): number {
  if (range === null) return 0;
  const match = /^bytes=0-(\d+)$/.exec(range.trim());
  if (!match?.[1]) {
    throw fail(
      `${label} sent a progress report that MergeStory does not understand.`,
      'Try again in a few minutes.',
    );
  }
  return Number(match[1]) + 1;
}

async function readChunk(
  handle: Awaited<ReturnType<typeof open>>,
  position: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) {
      throw fail(
        'The file changed while it was being uploaded.',
        'Do not touch the rendered files during an upload, then try again.',
      );
    }
    filled += bytesRead;
  }
  return buffer;
}

async function startSession(upload: ResumableUpload): Promise<string> {
  const answer = await callApi(
    {
      url: upload.startUrl,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(upload.sizeBytes),
        'X-Upload-Content-Type': upload.contentType,
      },
      body: JSON.stringify(upload.metadata),
    },
    { tokens: upload.tokens, signal: upload.signal, timing: upload.timing },
    (failures, err) => upload.onRetry?.({ failures, reason: describe(err) }),
  );
  const location = answer.headers.get('location');
  if (!location) {
    throw fail(`${upload.label} did not send an upload address.`, 'Try again in a few minutes.');
  }
  const session = checkedSessionUrl(location, upload.startUrl, upload.label);
  // The session address works like a key to this upload: keep it out of logs.
  upload.redactor.add(new URL(session).searchParams.get('upload_id'));
  return session;
}

function describe(err: GoogleApiError): string {
  return err.status === 0 ? err.apiMessage : `HTTP ${err.status}`;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Upload a file with the resumable protocol and return the resource Google created.
 * Throws a GoogleApiError for a failure Google reported, and a MergeStoryError for everything else
 * (a cancelled run, a file that changed, an answer that makes no sense).
 */
export async function uploadResumable(upload: ResumableUpload): Promise<UploadOutcome> {
  const { sizeBytes: total, chunkBytes } = upload;
  if (!Number.isInteger(total) || total <= 0) {
    throw fail('The file to upload is empty.', 'Render the video again.');
  }
  if (!Number.isInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes % CHUNK_UNIT !== 0) {
    throw new MergeStoryError('INTERNAL', `The chunk size must be a multiple of ${CHUNK_UNIT} bytes.`);
  }
  assertNotAborted(upload.signal);
  const handle = await open(upload.filePath, 'r');
  try {
    if ((await handle.stat()).size !== total) {
      throw fail(
        'The file is not the size it was said to be.',
        'Do not touch the rendered files while publishing, then try again.',
      );
    }
    const session = await startSession(upload);
    let offset = 0;
    let failures = 0;
    let stalls = 0;
    let query = false;
    let refreshed = false;

    for (;;) {
      assertNotAborted(upload.signal);
      let failure: GoogleApiError | null = null;
      let response: Response | null = null;
      let length = 0;
      try {
        const token = await upload.tokens.get();
        const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
        let body: Buffer | undefined;
        if (query) {
          headers['Content-Range'] = `bytes */${total}`;
        } else {
          length = Math.min(chunkBytes, total - offset);
          body = await readChunk(handle, offset, length);
          headers['Content-Range'] = `bytes ${offset}-${offset + length - 1}/${total}`;
          headers['Content-Type'] = upload.contentType;
          upload.onBytesSent?.(length);
        }
        response = await sendRequest(
          session,
          { method: 'PUT', headers, ...(body ? { body } : {}) },
          {
            signal: upload.signal,
            timeoutMs: upload.timing.requestTimeoutMs + Math.ceil(length / MIN_BYTES_PER_SEC) * 1000,
          },
        );
      } catch (err) {
        if (!(err instanceof GoogleApiError)) throw err;
        failure = err;
      }

      let text = '';
      if (response) {
        try {
          text = await readAnswerBody(response, upload.signal);
        } catch (err) {
          if (!(err instanceof GoogleApiError)) throw err;
          failure = err;
          response = null;
        }
      }
      if (response) {
        const status = response.status;
        if (status === 200 || status === 201) return { status, json: parseJson(text) };
        if (status === 308) {
          const received = confirmedBytes(response.headers.get('range'), upload.label);
          if (received > total) {
            throw fail(`${upload.label} reported more bytes than were sent.`, 'Try again in a few minutes.');
          }
          refreshed = false;
          if (!query) {
            if (received > offset) {
              failures = 0;
              stalls = 0;
              upload.onProgress?.(received, total);
            } else if (++stalls > upload.timing.maxRetries) {
              throw fail(`${upload.label} is not accepting the video data.`, 'Try again in a few minutes.');
            }
          }
          offset = received;
          // Everything has arrived but no final answer came: ask for it.
          query = received >= total;
          if (query && ++stalls > upload.timing.maxRetries) {
            throw fail(
              `${upload.label} did not confirm the finished upload.`,
              `Check ${upload.label} for the video, then try again if it is missing.`,
            );
          }
          continue;
        }
        failure = parseApiFailure(status, text, response.headers);
      }

      // A failure. Unauthorised: get a fresh token once. Transient: pause, then ask where the upload stands.
      if (failure === null) continue;
      if (failure.status === 401 && !refreshed) {
        refreshed = true;
        upload.tokens.invalidate();
        continue;
      }
      if (!failure.transient || ++failures > upload.timing.maxRetries) throw failure;
      upload.onRetry?.({ failures, reason: describe(failure) });
      await pause(backoffMs(failures, upload.timing, failure.retryAfterMs), upload.signal);
      query = true;
    }
  } finally {
    await handle.close();
  }
}
