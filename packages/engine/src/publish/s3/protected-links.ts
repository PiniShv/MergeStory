/**
 * Protected links are permanent links on a public base URL that sits behind an access proxy such as
 * Cloudflare Access. They are only safe when that address asks for a sign-in, so it is checked before
 * anything is uploaded.
 */
import type { RunContext } from '../../core/context.ts';
import { MergeStoryError } from '../../core/errors.ts';
import { isLoopbackHost } from '../../core/net.ts';
import type { AccessProbe, AccessProbeResult } from '../access-probe.ts';
import type { S3Settings } from './settings.ts';

/**
 * Two common mistakes with the public base URL of protected links, which show without a network call:
 * an address that cannot be put behind Cloudflare Access, and the storage API address itself (no
 * access proxy sits in front of it). `host` is the host of the address, with its port.
 */
export function addressMistake(host: string, endpoint: string | null): 'r2-dev' | 'storage-api' | null {
  if (host.replace(/:\d+$/, '').toLowerCase().endsWith('.r2.dev')) return 'r2-dev';
  let endpointHost = '';
  try {
    endpointHost = endpoint ? new URL(endpoint).host.toLowerCase() : '';
  } catch {
    endpointHost = '';
  }
  return endpointHost && host.toLowerCase() === endpointHost ? 'storage-api' : null;
}

/** Extra advice for those two mistakes. */
function addressAdvice(host: string, settings: S3Settings): string {
  const mistake = addressMistake(host, settings.endpoint);
  if (mistake === 'r2-dev') {
    return ' Addresses that end in r2.dev cannot be put behind Cloudflare Access: connect a custom domain to the bucket and use that.';
  }
  if (mistake === 'storage-api') {
    return ' This is the storage API address, which no access proxy sits in front of: use the custom domain of the bucket as the public base URL.';
  }
  return '';
}

/** The error for an address that did not prove to be behind a sign-in. Holds no secret and no full address. */
function protectionBlocked(result: AccessProbeResult, settings: S3Settings): MergeStoryError {
  const open = result.verdict === 'not-protected';
  const fix = open
    ? 'Put the address behind an access proxy such as Cloudflare Access before you upload (see https://github.com/PiniShv/MergeStory/blob/main/docs/hosting.md), or use private links that expire (--visibility private).'
    : 'Check that the address is the custom domain of the bucket and that an access policy covers it (see https://github.com/PiniShv/MergeStory/blob/main/docs/hosting.md), or use private links that expire (--visibility private).';
  return new MergeStoryError(
    'PRIVACY_BLOCKED',
    open
      ? `Protected links are blocked: ${result.host} is not behind a sign-in.`
      : `Protected links are blocked: MergeStory could not confirm that ${result.host} needs a sign-in.`,
    {
      hint:
        `Seen: ${result.host} ${result.detail}. ${fix}${addressAdvice(result.host, settings)} ` +
        'If this machine cannot reach the address (for example a domain that only works on a VPN), set ' +
        'publish.s3.verifyProtection to false (MERGESTORY_S3_VERIFY_PROTECTION=false) to skip this check.',
      details: { host: result.host, verdict: result.verdict, reason: result.reason, status: result.status },
    },
  );
}

interface ProtectionCheck {
  /** The public base URL that the links are built on. */
  publicBase: string;
  /** The folder of the upload: the check asks for a file in it, so the answer is about that folder. */
  keyPrefix: string;
  settings: S3Settings;
  probe: AccessProbe;
  ctx: RunContext;
}

/**
 * Asks the address anonymously for a file that does not exist, and refuses to continue unless it is
 * clearly protected.
 */
export async function assertProtected({
  publicBase,
  keyPrefix,
  settings,
  probe,
  ctx,
}: ProtectionCheck): Promise<void> {
  const url = new URL(publicBase);
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    ctx.logger.warn('The public base URL uses http, so the sign-in and the video are not encrypted');
  }
  const result = await probe(publicBase, { pathPrefix: keyPrefix, signal: ctx.signal });
  // The request carries no content, but it is still a connection to the address, so it is reported.
  ctx.egress.record(result.host.replace(/:\d+$/, ''), 'protection check', 0, []);
  ctx.logger.debug('Checked the link address', { reason: result.reason, status: result.status });
  if (result.verdict !== 'protected') throw protectionBlocked(result, settings);
  ctx.progress({
    stage: 'publish',
    status: 'progress',
    message: 'Checked that the link address needs a sign-in',
  });
}
