/**
 * The S3 client. The AWS SDK is loaded on first use, so runs that never upload do not pay for it.
 * This file also decides the region and the credentials the client signs with, and the settings that
 * make it work with services other than Amazon.
 */
import type { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';
import type { Secrets } from '../../core/config.ts';
import { MergeStoryError } from '../../core/errors.ts';
import { keysProblem, type S3Settings } from './settings.ts';

export interface S3Libs {
  S3Client: typeof import('@aws-sdk/client-s3').S3Client;
  GetObjectCommand: typeof import('@aws-sdk/client-s3').GetObjectCommand;
  DeleteObjectCommand: typeof import('@aws-sdk/client-s3').DeleteObjectCommand;
  HeadBucketCommand: typeof import('@aws-sdk/client-s3').HeadBucketCommand;
  Upload: typeof import('@aws-sdk/lib-storage').Upload;
  getSignedUrl: typeof import('@aws-sdk/s3-request-presigner').getSignedUrl;
}

export async function loadLibs(): Promise<S3Libs> {
  try {
    const [client, storage, presigner] = await Promise.all([
      import('@aws-sdk/client-s3'),
      import('@aws-sdk/lib-storage'),
      import('@aws-sdk/s3-request-presigner'),
    ]);
    return {
      S3Client: client.S3Client,
      GetObjectCommand: client.GetObjectCommand,
      DeleteObjectCommand: client.DeleteObjectCommand,
      HeadBucketCommand: client.HeadBucketCommand,
      Upload: storage.Upload,
      getSignedUrl: presigner.getSignedUrl,
    };
  } catch (err) {
    throw new MergeStoryError('PUBLISH_FAILED', 'The S3 client libraries could not be loaded.', {
      hint: 'Reinstall mergestory so that @aws-sdk/client-s3, @aws-sdk/lib-storage and @aws-sdk/s3-request-presigner are present.',
      cause: err,
    });
  }
}

/** true for Amazon S3 (no endpoint, or an amazonaws.com address). Every other service is S3-compatible. */
function isAwsEndpoint(endpoint: string | null): boolean {
  if (!endpoint) return true;
  try {
    return /(^|\.)amazonaws\.com(\.cn)?$/i.test(new URL(endpoint).hostname);
  } catch {
    return false;
  }
}

function regionFromHost(endpoint: string, pattern: RegExp): string | null {
  try {
    return pattern.exec(new URL(endpoint).hostname)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** An Amazon address with a region in it, such as s3.eu-west-2.amazonaws.com. Names like "accelerate" are not regions. */
const AWS_HOST = /^(?:[a-z0-9-]+\.)*s3[.-]([a-z]{2}(?:-[a-z]+)+-\d+)\.amazonaws\.com(?:\.cn)?$/i;
/** Backblaze B2 signs with the region that is part of its address, for example s3.us-west-004.backblazeb2.com. */
const B2_HOST = /^(?:[a-z0-9-]+\.)*s3\.([a-z0-9-]+)\.backblazeb2\.com$/i;

/** The region to sign with, or undefined to let the SDK find one (AWS_REGION, profile). */
export function configuredRegion(s3: S3Settings): string | undefined {
  if (s3.region && s3.region !== 'auto') return s3.region;
  if (!s3.endpoint) return undefined;
  if (isAwsEndpoint(s3.endpoint)) return regionFromHost(s3.endpoint, AWS_HOST) ?? undefined;
  // Backblaze B2 needs the region of its address. Cloudflare R2 and most other services accept "auto".
  return regionFromHost(s3.endpoint, B2_HOST) ?? 'auto';
}

function staticCredentials(
  secrets: Pick<Secrets, 'get'>,
): { accessKeyId: string; secretAccessKey: string } | null {
  const problem = keysProblem(secrets);
  if (problem) throw problem;
  const accessKeyId = secrets.get('MERGESTORY_S3_ACCESS_KEY_ID');
  const secretAccessKey = secrets.get('MERGESTORY_S3_SECRET_ACCESS_KEY');
  return accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : null;
}

/**
 * Settings for the S3 client. Since early 2025 the SDK adds a checksum to every upload and asks
 * for one on every download. Amazon S3 accepts that. Other services may not: Backblaze B2 and
 * Google Cloud Storage have been reported to reject it. So whenever the endpoint is not an Amazon
 * address, checksums are only used where the S3 protocol itself requires them.
 */
export function buildClientOptions(s3: S3Settings, secrets: Pick<Secrets, 'get'>): S3ClientConfig {
  const region = configuredRegion(s3);
  const credentials = staticCredentials(secrets);
  return {
    ...(region ? { region } : {}),
    ...(s3.endpoint ? { endpoint: s3.endpoint } : {}),
    forcePathStyle: s3.forcePathStyle,
    ...(credentials ? { credentials } : {}),
    ...(isAwsEndpoint(s3.endpoint)
      ? {}
      : {
          requestChecksumCalculation: 'WHEN_REQUIRED' as const,
          responseChecksumValidation: 'WHEN_REQUIRED' as const,
        }),
  };
}

export function createClient(libs: S3Libs, s3: S3Settings, secrets: Pick<Secrets, 'get'>): S3Client {
  return new libs.S3Client(buildClientOptions(s3, secrets));
}

export async function resolveRegion(client: S3Client): Promise<string> {
  try {
    return await client.config.region();
  } catch (err) {
    throw new MergeStoryError('CONFIG_INVALID', 'No storage region is set.', {
      hint: 'Set MERGESTORY_S3_REGION (for example us-east-1) or AWS_REGION.',
      cause: err,
    });
  }
}

export async function resolveCredentials(client: S3Client): Promise<{ expiration?: Date }> {
  try {
    return await client.config.credentials();
  } catch (err) {
    if (err instanceof Error && err.name === 'CredentialsProviderError') {
      throw new MergeStoryError('CONFIG_INVALID', 'No storage credentials were found.', {
        hint:
          'Set MERGESTORY_S3_ACCESS_KEY_ID and MERGESTORY_S3_SECRET_ACCESS_KEY, or use the AWS credential chain ' +
          '(AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, a profile or a role).',
        cause: err,
      });
    }
    throw new MergeStoryError('PUBLISH_FAILED', 'The storage credentials could not be loaded.', {
      hint: 'Check your AWS profile or single sign-on session.',
      cause: err,
    });
  }
}

/** Host name that receives the upload, for the egress report. The plan may not know the region yet (empty). */
export function egressHost(s3: S3Settings, bucket: string, region: string): string {
  if (s3.endpoint) {
    try {
      return new URL(s3.endpoint).hostname;
    } catch {
      return s3.endpoint;
    }
  }
  return region ? `${bucket}.s3.${region}.amazonaws.com` : `${bucket}.s3.amazonaws.com`;
}
