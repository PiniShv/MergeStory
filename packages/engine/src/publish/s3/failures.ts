/** What went wrong when a storage service refused or dropped a request, in words for the person who ran it. */

import type { RunContext } from '../../core/context.ts';
import { MergeStoryError, toMergeStoryError } from '../../core/errors.ts';

const TRANSIENT_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNABORTED', 'EAI_AGAIN']);
const TRANSIENT_NAMES = new Set([
  'TimeoutError',
  'RequestTimeout',
  'SlowDown',
  'ServiceUnavailable',
  'InternalError',
]);

interface FailureShape {
  name?: string;
  code?: string;
  message?: string;
  retryable?: boolean;
  $retryable?: unknown;
  $metadata?: { httpStatusCode?: number };
}

export function shapeOf(err: unknown): FailureShape {
  return err && typeof err === 'object' ? (err as FailureShape) : {};
}

/** Errors that are worth another attempt: network trouble, throttling and server errors. */
export function isTransient(err: unknown): boolean {
  const e = shapeOf(err);
  if (e.name === 'AbortError') return false;
  if (e.retryable === true || e.$retryable) return true;
  const status = e.$metadata?.httpStatusCode;
  // 501 means the service lacks the feature, so asking again cannot help.
  if (status !== undefined && (status === 408 || status === 429 || (status >= 500 && status !== 501)))
    return true;
  return (
    (e.name !== undefined && TRANSIENT_NAMES.has(e.name)) ||
    (e.code !== undefined && TRANSIENT_CODES.has(e.code))
  );
}

function describeFailure(err: unknown): { message: string; hint: string } {
  const e = shapeOf(err);
  const name = e.name ?? 'Error';
  const code = e.code ?? '';
  const status = e.$metadata?.httpStatusCode;
  if (
    [
      'InvalidAccessKeyId',
      'SignatureDoesNotMatch',
      'InvalidToken',
      'ExpiredToken',
      'InvalidClientTokenId',
    ].includes(name)
  ) {
    return {
      message: 'the storage service rejected the credentials.',
      hint: 'Check the access key and secret, and that the region matches the bucket.',
    };
  }
  if (name === 'AccessDenied' || name === 'Forbidden' || status === 403) {
    return {
      message: 'access to the bucket was denied.',
      hint: 'The key needs permission to write objects (s3:PutObject) and read them (s3:GetObject) in this bucket.',
    };
  }
  if (name === 'NoSuchBucket') {
    return {
      message: 'the bucket was not found.',
      hint: 'Check the bucket name, the endpoint and the region.',
    };
  }
  if (name === 'PermanentRedirect' || name === 'AuthorizationHeaderMalformed' || status === 301) {
    return {
      message: 'the bucket is in a different region or at a different endpoint.',
      hint: 'Set MERGESTORY_S3_REGION (and MERGESTORY_S3_ENDPOINT for services other than AWS) to match the bucket.',
    };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return {
      message: 'the storage endpoint could not be found.',
      hint: 'Check MERGESTORY_S3_ENDPOINT and your network connection.',
    };
  }
  if (name === 'EntityTooLarge') {
    return {
      message: 'the video is larger than the bucket allows.',
      hint: 'Use a shorter video or a lower quality preset, or raise the size limit of the bucket.',
    };
  }
  if (name === 'NotImplemented' || status === 501) {
    return {
      message: 'the storage service does not support a request that MergeStory sends.',
      hint: 'Check that MERGESTORY_S3_ENDPOINT is the S3 address of your provider, for example https://<account-id>.r2.cloudflarestorage.com for Cloudflare R2.',
    };
  }
  if (isTransient(err) || code === 'ECONNREFUSED') {
    return {
      message: 'the storage service could not be reached or had a temporary problem.',
      hint: 'Check the endpoint and your network connection, then try again.',
    };
  }
  return {
    message: `the storage service returned ${name}${status ? ` (HTTP ${status})` : ''}.`,
    hint: 'Check the bucket, endpoint, region and credentials.',
  };
}

/**
 * The error for a failed request. What the service said is never repeated, because it could hold a
 * secret: the message names the kind of failure only.
 */
export function toPublishError(err: unknown, ctx: RunContext, action: string): MergeStoryError {
  if (err instanceof MergeStoryError) return err;
  if (err instanceof Error && err.name === 'AbortError') return toMergeStoryError(err);
  const { message, hint } = describeFailure(err);
  const status = shapeOf(err).$metadata?.httpStatusCode;
  return new MergeStoryError('PUBLISH_FAILED', ctx.redactor.redact(`${action} failed: ${message}`), {
    hint,
    cause: err,
    retryable: isTransient(err),
    details: { error: shapeOf(err).name ?? 'Error', ...(status ? { status } : {}) },
  });
}
