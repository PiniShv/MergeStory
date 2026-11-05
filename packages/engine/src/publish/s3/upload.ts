/**
 * Putting the files of a bundle into the bucket, the watch page last. Each file is retried after a
 * temporary error and given up on when the connection stalls; what was sent is recorded as it goes.
 */
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import type { S3Client } from '@aws-sdk/client-s3';
import type { RunContext } from '../../core/context.ts';
import { assertNotAborted, MergeStoryError } from '../../core/errors.ts';
import { retry } from '../../core/retry.ts';
import type { EgressContent } from '../../core/types.ts';
import { type ClassifiedBundle, WATCH_PAGE_NAME } from '../bundle.ts';
import { cacheControlFor, contentTypeFor } from '../content-types.ts';
import type { S3Libs } from './client.ts';
import { isTransient, toPublishError } from './failures.ts';
import type { Visibility } from './settings.ts';

/** One fixed part size for every part: some services require all parts but the last to match. */
const PART_SIZE = 8 * 1024 * 1024;

interface UploadJob {
  name: string;
  key: string;
  contentType: string;
  cacheControl: string;
  sizeBytes: number;
  /** A fresh body for every attempt: streams cannot be replayed. */
  body: () => Readable | Buffer;
}

/** Safety net against a stalled connection, not a speed limit: two minutes plus the bytes at 20 kB/s. */
function uploadTimeoutMs(sizeBytes: number): number {
  return 120_000 + Math.ceil(sizeBytes / 20_000) * 1_000;
}

async function uploadObject(libs: S3Libs, client: S3Client, bucket: string, job: UploadJob, ctx: RunContext) {
  await retry(
    async () => {
      assertNotAborted(ctx.signal);
      const abort = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        abort.abort();
      }, uploadTimeoutMs(job.sizeBytes));
      const onCancel = () => abort.abort();
      ctx.signal.addEventListener('abort', onCancel, { once: true });
      try {
        const upload = new libs.Upload({
          client,
          // No ACL: buckets that enforce object ownership reject them.
          params: {
            Bucket: bucket,
            Key: job.key,
            Body: job.body(),
            ContentType: job.contentType,
            CacheControl: job.cacheControl,
            ContentDisposition: 'inline',
            ContentLength: job.sizeBytes,
          },
          queueSize: 4,
          partSize: PART_SIZE,
          leavePartsOnError: false,
          abortController: abort,
        });
        await upload.done();
      } catch (err) {
        if (timedOut && !ctx.signal.aborted) {
          throw new MergeStoryError('PUBLISH_FAILED', `The upload of ${job.name} stalled.`, {
            hint: 'Check your network connection and try again.',
            retryable: true,
            cause: err,
          });
        }
        throw err;
      } finally {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onCancel);
      }
    },
    {
      attempts: 3,
      minDelayMs: 750,
      maxDelayMs: 8_000,
      signal: ctx.signal,
      isRetryable: isTransient,
      onRetry: ({ attempt }) => ctx.logger.warn('Upload failed, trying again', { attempt }),
    },
  );
}

interface BundleUpload {
  libs: S3Libs;
  client: S3Client;
  bucket: string;
  /** Host name that receives the upload, for the egress report. */
  host: string;
  /** The folder of this upload in the bucket, ending in "/". */
  keyPrefix: string;
  files: ClassifiedBundle;
  /** The watch page. It goes last, so it never points at files that are not there yet. */
  page: Buffer;
  /** The kind of links decides the cache headers. */
  visibility: Visibility;
  /** What the files contain, for the egress report. */
  contains: EgressContent[];
  ctx: RunContext;
}

/** How long the removal of the files of a failed upload may take. */
const CLEANUP_TIMEOUT_MS = 30_000;

/**
 * Remove what a failed upload left in the bucket, so no video stays there that nobody has a link to.
 * Returns true when every file is gone.
 */
async function removeUploaded(
  { libs, client, bucket }: Pick<BundleUpload, 'libs' | 'client' | 'bucket'>,
  keys: string[],
): Promise<boolean> {
  const results = await Promise.allSettled(
    keys.map((Key) =>
      client.send(new libs.DeleteObjectCommand({ Bucket: bucket, Key }), {
        abortSignal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
      }),
    ),
  );
  return results.every((r) => r.status === 'fulfilled');
}

/**
 * Upload the files and then the watch page, in that order. Stops at the first file that cannot be sent
 * and then removes the files that were already sent.
 */
export async function uploadBundle(upload: BundleUpload): Promise<void> {
  const { libs, client, bucket, host, keyPrefix, files, page, visibility, ctx } = upload;
  const jobs: UploadJob[] = files.ordered.map(({ file, sizeBytes }) => ({
    name: file.name,
    key: `${keyPrefix}${file.name}`,
    contentType: contentTypeFor(file.name),
    cacheControl: cacheControlFor(file.name, visibility),
    sizeBytes,
    body: () => createReadStream(file.path),
  }));
  jobs.push({
    name: WATCH_PAGE_NAME,
    key: `${keyPrefix}${WATCH_PAGE_NAME}`,
    contentType: contentTypeFor(WATCH_PAGE_NAME),
    cacheControl: cacheControlFor(WATCH_PAGE_NAME, visibility),
    sizeBytes: page.length,
    body: () => page,
  });

  const totalBytes = jobs.reduce((sum, job) => sum + job.sizeBytes, 0);
  ctx.logger.info('Uploading the video bundle', { bucket, files: jobs.length, bytes: totalBytes });
  let sent = 0;
  const sentKeys: string[] = [];
  for (const job of jobs) {
    try {
      await uploadObject(libs, client, bucket, job, ctx);
    } catch (err) {
      const failure = toPublishError(err, ctx, `Uploading ${job.name}`);
      // The failed file is included: a stalled upload may have reached the bucket after all.
      if (sentKeys.length === 0 || (await removeUploaded(upload, [...sentKeys, job.key]))) throw failure;
      throw new MergeStoryError(failure.code, failure.message, {
        hint: `${failure.hint ?? ''} Some files were already uploaded and could not be removed. Check ${bucket}/${keyPrefix} and delete that folder.`.trim(),
        cause: failure.cause,
        details: failure.details,
        retryable: failure.retryable,
      });
    }
    sentKeys.push(job.key);
    sent += job.sizeBytes;
    ctx.egress.record(host, 'video upload', job.sizeBytes, upload.contains);
    ctx.progress({
      stage: 'publish',
      status: 'progress',
      progress: sent / totalBytes,
      message: `Uploaded ${job.name}`,
    });
  }
  // Storage is billed by the provider and is not metered here, so the cost is recorded as zero (estimated).
  ctx.cost.record({
    provider: 's3',
    kind: 'storage',
    model: null,
    bytes: totalBytes,
    costUsd: 0,
    estimated: true,
  });
}
