/** The doctor's question to the storage service: does the bucket exist, and do the credentials reach it? */
import type { S3Client } from '@aws-sdk/client-s3';
import type { Secrets } from '../../core/config.ts';
import { MergeStoryError } from '../../core/errors.ts';
import { createClient, loadLibs, resolveCredentials, resolveRegion } from './client.ts';
import { shapeOf } from './failures.ts';
import { bucketProblem, type S3Settings } from './settings.ts';

/** What a HeadBucket request found out. `mergestory doctor --online` turns this into a report line. */
export interface BucketCheck {
  kind: 'ok' | 'access-denied' | 'not-found' | 'wrong-region' | 'config' | 'unreachable' | 'other';
  /** HTTP status of the answer, when there was one. */
  httpStatus: number | null;
  /** Error name from the service or the network ("Forbidden", "ENOTFOUND"), when there is one. */
  code: string | null;
  /** For kind "config": what is wrong, and how to fix it. */
  problem?: { message: string; hint: string | undefined };
}

const NETWORK_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ECONNABORTED',
]);

function describeBucketFailure(err: unknown): BucketCheck {
  if (err instanceof MergeStoryError) {
    return {
      kind: 'config',
      httpStatus: null,
      code: null,
      problem: { message: err.message, hint: err.hint },
    };
  }
  const e = shapeOf(err);
  const httpStatus = e.$metadata?.httpStatusCode ?? null;
  const name = e.name ?? null;
  const detail = { httpStatus, code: name };
  if (httpStatus === 403 || name === 'Forbidden' || name === 'AccessDenied') {
    return { kind: 'access-denied', ...detail };
  }
  if (httpStatus === 404 || name === 'NotFound' || name === 'NoSuchBucket') {
    return { kind: 'not-found', ...detail };
  }
  if (
    httpStatus === 301 ||
    httpStatus === 400 ||
    name === 'PermanentRedirect' ||
    name === 'AuthorizationHeaderMalformed'
  ) {
    return { kind: 'wrong-region', ...detail };
  }
  if (name === 'TimeoutError' || name === 'AbortError') {
    return { kind: 'unreachable', httpStatus, code: 'TIMEOUT' };
  }
  if (e.code !== undefined && NETWORK_CODES.has(e.code)) {
    return { kind: 'unreachable', httpStatus, code: e.code };
  }
  return { kind: 'other', ...detail };
}

/**
 * Ask the storage service whether the bucket exists and the credentials reach it (HeadBucket).
 * Used by `mergestory doctor --online`. Never throws; nothing is uploaded or changed.
 */
export async function checkBucket(
  s3: S3Settings,
  secrets: Pick<Secrets, 'get'>,
  options: { timeoutMs?: number } = {},
): Promise<BucketCheck> {
  const missing = bucketProblem(s3);
  if (missing) {
    return {
      kind: 'config',
      httpStatus: null,
      code: null,
      problem: { message: missing.message, hint: missing.hint },
    };
  }
  const bucket = s3.bucket?.trim() as string;
  let client: S3Client | null = null;
  try {
    const libs = await loadLibs();
    client = createClient(libs, s3, secrets);
    await resolveRegion(client);
    await resolveCredentials(client);
    await client.send(new libs.HeadBucketCommand({ Bucket: bucket }), {
      abortSignal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
    return { kind: 'ok', httpStatus: 200, code: null };
  } catch (err) {
    return describeBucketFailure(err);
  } finally {
    client?.destroy();
  }
}
