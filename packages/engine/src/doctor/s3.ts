/**
 * Checks of the S3-compatible storage: the settings, the keys and, with --online, the bucket and the
 * sign-in in front of protected links. What an upload refuses is decided by the upload's own rules
 * (findS3Problems); the sentences, and the warnings that are not refusals, are the report's.
 */
import type { Config, Secrets } from '../core/config.ts';
import { plural } from '../core/text.ts';
import type { AccessProbeResult } from '../publish/access-probe.ts';
import { sanitizeKeyPrefix } from '../publish/keys.ts';
import { addressMistake, type BucketCheck, findS3Problems, type S3Problems } from '../publish/s3/index.ts';
import { check, urlHost } from './check.ts';
import type { DoctorCheck, DoctorContext } from './types.ts';

/** "7 days", "1 hour", "90 minutes". */
function formatLifetime(seconds: number): string {
  if (seconds % 86_400 === 0) return plural(seconds / 86_400, 'day');
  if (seconds % 3_600 === 0) return plural(seconds / 3_600, 'hour');
  return plural(Math.max(1, Math.round(seconds / 60)), 'minute');
}

const ADDRESS_MISTAKES = {
  'r2-dev': 'r2.dev addresses cannot be put behind Cloudflare Access',
  'storage-api': 'that is the storage API address, which no access proxy sits in front of',
};

function checkSettings(config: Config, problems: S3Problems, online: boolean): DoctorCheck {
  const { visibility, linkExpirySec, allowPublicForPrivateRepos, s3 } = config.publish;
  if (problems.bucket) {
    return check(
      'publish',
      'Publishing',
      'fail',
      's3 selected but no bucket is set',
      'Set MERGESTORY_S3_BUCKET (and MERGESTORY_S3_ENDPOINT for R2, Backblaze B2, Google Cloud Storage or a self-hosted server).',
    );
  }
  const where = `s3: bucket ${s3.bucket}, endpoint ${urlHost(s3.endpoint) ?? 'AWS default'}`;
  if (visibility === 'private') {
    return check(
      'publish',
      'Publishing',
      'pass',
      `${where}, private links (signed; they stop working after ${formatLifetime(linkExpirySec)})`,
    );
  }
  if (problems.publicBase) {
    const needs =
      visibility === 'protected'
        ? 'the custom domain of the bucket that sits behind your access proxy (see https://github.com/PiniShv/MergeStory/blob/main/docs/hosting.md)'
        : 'the address that serves the bucket (a CDN or a custom domain)';
    // The upload only takes a plain http(s) address without a user name or password.
    const problem = s3.publicBaseUrl
      ? 'the public base URL is not a plain http(s) address (no user name or password)'
      : 'no public base URL is set';
    return check(
      'publish',
      'Publishing',
      'fail',
      `${where}, ${visibility} links, but ${problem}`,
      `Set MERGESTORY_S3_PUBLIC_BASE_URL to ${needs}, or use --visibility private.`,
    );
  }
  // No problem with the address, so it is a plain address.
  const publicHost = urlHost(s3.publicBaseUrl) as string;
  if (visibility === 'protected') {
    // Two mistakes that can be seen without any network call.
    const mistake = addressMistake(publicHost, s3.endpoint);
    if (mistake) {
      return check(
        'publish',
        'Publishing',
        'fail',
        `${where}, protected links through ${publicHost}, but ${ADDRESS_MISTAKES[mistake]}`,
        'Connect a custom domain to the bucket, put your access proxy in front of it, and use it as MERGESTORY_S3_PUBLIC_BASE_URL (see https://github.com/PiniShv/MergeStory/blob/main/docs/hosting.md).',
      );
    }
    return s3.verifyProtection
      ? check(
          'publish',
          'Publishing',
          'pass',
          `${where}, protected links through ${publicHost}, checked before every upload${online ? '' : ' (mergestory doctor --online checks it now)'}`,
        )
      : check(
          'publish',
          'Publishing',
          'warn',
          `${where}, protected links through ${publicHost}. The address is NOT checked before upload: publish.s3.verifyProtection is off`,
          'Turn the check on (MERGESTORY_S3_VERIFY_PROTECTION=true) unless this machine cannot reach the address.',
        );
  }
  return allowPublicForPrivateRepos
    ? check(
        'publish',
        'Publishing',
        'warn',
        `${where}, public links through ${publicHost}. publish.allowPublicForPrivateRepos is on, so videos of private repositories get public links too`,
        'Turn publish.allowPublicForPrivateRepos off unless anyone may watch those videos.',
      )
    : check(
        'publish',
        'Publishing',
        'pass',
        `${where}, public links through ${publicHost} (anyone with a link can watch; blocked for private repositories)`,
      );
}

function checkKeys(secrets: Secrets, problems: S3Problems): DoctorCheck {
  const hasKeyId = secrets.has('MERGESTORY_S3_ACCESS_KEY_ID');
  if (problems.keys) {
    return check(
      'publish-credentials',
      'Storage keys',
      'fail',
      `only ${hasKeyId ? 'MERGESTORY_S3_ACCESS_KEY_ID' : 'MERGESTORY_S3_SECRET_ACCESS_KEY'} is set`,
      problems.keys.hint ?? null,
    );
  }
  if (hasKeyId) {
    return check(
      'publish-credentials',
      'Storage keys',
      'pass',
      'MERGESTORY_S3_ACCESS_KEY_ID and MERGESTORY_S3_SECRET_ACCESS_KEY are set',
    );
  }
  if (secrets.has('AWS_ACCESS_KEY_ID') && secrets.has('AWS_SECRET_ACCESS_KEY')) {
    return check(
      'publish-credentials',
      'Storage keys',
      'pass',
      'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are set',
    );
  }
  return check(
    'publish-credentials',
    'Storage keys',
    'warn',
    'no keys in the environment (the AWS default credential chain, such as a profile or a role, will be tried)',
    'Set MERGESTORY_S3_ACCESS_KEY_ID and MERGESTORY_S3_SECRET_ACCESS_KEY.',
  );
}

/** HeadBucket needs permission to list the bucket, which a key limited to files may not have. */
function bucketCheckResult(config: Config, found: BucketCheck): DoctorCheck {
  const id = 'publish-bucket';
  const name = 'Storage access';
  const host = urlHost(config.publish.s3.endpoint) ?? 'the AWS default endpoint';
  const status = found.httpStatus ? ` (HTTP ${found.httpStatus})` : '';
  switch (found.kind) {
    case 'ok':
      return check(
        id,
        name,
        'pass',
        `bucket ${config.publish.s3.bucket} exists at ${host} and these keys can reach it`,
      );
    case 'access-denied':
      return check(
        id,
        name,
        'warn',
        `the storage service refused the bucket check${status}. The keys may be wrong, or they may only allow reading and writing files, because the check also needs permission to list the bucket`,
        'Check the access key and secret. Uploads need permission to write and read files in this bucket.',
      );
    case 'not-found':
      return check(
        id,
        name,
        'fail',
        `bucket ${config.publish.s3.bucket} was not found at ${host}${status}`,
        'Check the bucket name and MERGESTORY_S3_ENDPOINT. Services such as Cloudflare R2 have one address per account.',
      );
    case 'wrong-region':
      return check(
        id,
        name,
        'fail',
        `the storage service says the bucket is in another region or at another address${status}`,
        'Set MERGESTORY_S3_REGION (and MERGESTORY_S3_ENDPOINT for services other than AWS) to match the bucket.',
      );
    case 'config':
      return check(
        id,
        name,
        'fail',
        found.problem?.message ?? 'the storage settings are not complete',
        found.problem?.hint ?? null,
      );
    case 'unreachable':
      return check(
        id,
        name,
        'fail',
        `${host} could not be reached${found.code ? ` (${found.code})` : ''}`,
        'Check MERGESTORY_S3_ENDPOINT and your network connection.',
      );
    default:
      return check(
        id,
        name,
        'warn',
        `the storage service gave an unexpected answer${status}${found.code ? ` (${found.code})` : ''}`,
        'Check the bucket, endpoint, region and keys, then try again.',
      );
  }
}

function protectionCheckResult(result: AccessProbeResult): DoctorCheck {
  const id = 'publish-protection';
  const name = 'Link protection';
  if (result.verdict === 'protected') {
    return check(
      id,
      name,
      'pass',
      `${result.host} ${result.detail}, so only people who sign in can open the links`,
    );
  }
  const blocked = 'Protected links are blocked until this is fixed.';
  return result.verdict === 'not-protected'
    ? check(
        id,
        name,
        'fail',
        `${result.host} ${result.detail}. ${blocked}`,
        'Put the address behind an access proxy such as Cloudflare Access (see https://github.com/PiniShv/MergeStory/blob/main/docs/hosting.md), or use --visibility private.',
      )
    : check(
        id,
        name,
        'fail',
        `could not confirm that ${result.host} needs a sign-in: it ${result.detail}. ${blocked}`,
        'Check that the address is the custom domain of the bucket and that an access policy covers it. If this machine cannot reach it (for example a VPN-only domain), set MERGESTORY_S3_VERIFY_PROTECTION=false.',
      );
}

async function checkOnline(
  { config, secrets, deps }: DoctorContext,
  problems: S3Problems,
): Promise<DoctorCheck[]> {
  const { visibility, s3 } = config.publish;
  const checks = [bucketCheckResult(config, await deps.headBucket(config, secrets))];
  const publicBase = s3.publicBaseUrl;
  // An address that the upload refuses is not asked: the run stops before it gets to this check.
  if (visibility === 'protected' && s3.verifyProtection && publicBase && !problems.publicBase) {
    // The same folder that the videos go into, so a policy that covers other paths does not pass.
    const folder = sanitizeKeyPrefix(s3.prefix);
    checks.push(protectionCheckResult(await deps.probeAccess(publicBase, folder ? `${folder}/` : '')));
  }
  return checks;
}

export async function checkS3(c: DoctorContext): Promise<DoctorCheck[]> {
  const { config, secrets, online } = c;
  // The repository is not known here, so the rule about public links for private repositories is
  // left to the run; every other refusal of the upload is the report's.
  const problems = findS3Problems(config, secrets, config.publish.visibility, false);
  const checks = [checkSettings(config, problems, online)];
  // Without a bucket there is nothing more to check, and the first check already says so.
  if (problems.bucket) return checks;
  checks.push(checkKeys(secrets, problems));
  if (online) checks.push(...(await checkOnline(c, problems)));
  return checks;
}
