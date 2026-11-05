/**
 * S3-compatible publisher: Amazon S3, Cloudflare R2, Backblaze B2, Google Cloud Storage,
 * self-hosted servers such as Garage or SeaweedFS, and similar services.
 *
 * Each upload brings its own random key prefix (see buildKeyPrefix), so uploads of different runs
 * never collide. The kind of links comes from the settings (publish.visibility):
 *  - private (the default): signed links that expire;
 *  - protected: permanent links through a public base URL that sits behind an access proxy such
 *    as Cloudflare Access. The address is checked before anything is uploaded;
 *  - public: permanent links through a public base URL that anyone can open.
 */
import type { Config } from '../../core/config.ts';
import type { RunContext } from '../../core/context.ts';
import { assertNotAborted, MergeStoryError } from '../../core/errors.ts';
import type { PublishBundle, PublishCheckContext, Publisher } from '../../core/providers.ts';
import type { EgressRecord, PublishResult } from '../../core/types.ts';
import { type AccessProbe, probeAccessProtection } from '../access-probe.ts';
import { classifyBundle } from '../bundle.ts';
import { buildKeyPrefix } from '../keys.ts';
import { assertNotDryRun } from '../privacy.ts';
import { BUNDLE_CONTAINS } from '../types.ts';
import {
  configuredRegion,
  createClient,
  egressHost,
  loadLibs,
  resolveCredentials,
  resolveRegion,
} from './client.ts';
import { directLinks, signedLinks } from './links.ts';
import { assertProtected } from './protected-links.ts';
import { findS3Problems, firstProblem, publicBaseOf } from './settings.ts';
import { uploadBundle } from './upload.ts';

/** Things the publisher uses that tests can replace. */
interface S3PublisherOptions {
  /** The check that an address needs a sign-in, used for protected links. */
  probeAccess?: AccessProbe;
}

export class S3Publisher implements Publisher {
  readonly id = 's3';
  private readonly config: Config;
  private readonly probeAccess: AccessProbe;

  constructor(config: Config, options: S3PublisherOptions = {}) {
    this.config = config;
    this.probeAccess = options.probeAccess ?? probeAccessProtection;
  }

  async check(ctx: PublishCheckContext, repoIsPrivate: boolean | null): Promise<MergeStoryError | null> {
    return firstProblem(
      findS3Problems(this.config, ctx.secrets, this.config.publish.visibility, repoIsPrivate),
    );
  }

  plannedEgress(estimatedBytes: number): EgressRecord[] {
    const { visibility, s3 } = this.config.publish;
    const bucket = s3.bucket?.trim();
    if (!bucket) return [];
    // Without an endpoint the upload goes to the bucket's own address, which names the region. When the
    // settings name none, the AWS SDK finds it in the environment, so that is where the plan looks.
    const region = configuredRegion(s3) ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? '';
    const records: EgressRecord[] = [
      {
        destination: egressHost(s3, bucket, region),
        purpose: 'video upload',
        bytes: estimatedBytes,
        contains: [...BUNDLE_CONTAINS],
      },
    ];
    const publicBase = publicBaseOf(s3.publicBaseUrl);
    if (visibility === 'protected' && s3.verifyProtection && publicBase) {
      // An anonymous request that checks the sign-in step; it carries nothing from the change.
      records.push({
        destination: new URL(publicBase).hostname,
        purpose: 'protection check',
        bytes: 0,
        contains: [],
      });
    }
    return records;
  }

  async publish(bundle: PublishBundle, ctx: RunContext): Promise<PublishResult> {
    const config = this.config;
    const { visibility, linkExpirySec, s3: settings } = config.publish;

    assertNotDryRun(ctx);
    // Checked first, before any network activity, so a blocked upload never touches storage. The kind of
    // links decides which rules apply. Protected links are allowed for private repositories: that is
    // what they are for.
    const problem = firstProblem(findS3Problems(config, ctx.secrets, visibility, bundle.repoIsPrivate));
    if (problem) throw problem;
    const bucket = settings.bucket?.trim() as string;
    // Protected and public links both go through the public base URL. Anything else gets signed links.
    const publicBase =
      visibility === 'public' || visibility === 'protected' ? publicBaseOf(settings.publicBaseUrl) : null;
    const files = await classifyBundle(bundle);
    // The prefix holds the random part that keeps links unguessable.
    const keyPrefix = buildKeyPrefix(settings.prefix);
    assertNotAborted(ctx.signal);

    const libs = await loadLibs();
    const client = createClient(libs, settings, ctx.secrets);
    try {
      const region = await resolveRegion(client);
      const credentials = await resolveCredentials(client);
      // Before anything is uploaded: a video of private code must not land behind an open address.
      if (visibility === 'protected' && publicBase && settings.verifyProtection) {
        await assertProtected({ publicBase, keyPrefix, settings, probe: this.probeAccess, ctx });
      }
      const links = publicBase
        ? directLinks(publicBase, keyPrefix, files)
        : await signedLinks({
            libs,
            client,
            bucket,
            keyPrefix,
            files,
            lifetimeSec: linkExpirySec,
            credentialsExpire: credentials.expiration,
            ctx,
          });

      const html = bundle.buildWatchPage(links.urls);
      if (typeof html !== 'string' || html.length === 0) {
        throw new MergeStoryError('PUBLISH_FAILED', 'The watch page is empty.', {
          hint: 'The watch page builder returned no HTML.',
        });
      }
      await uploadBundle({
        libs,
        client,
        bucket,
        host: egressHost(settings, bucket, region),
        keyPrefix,
        files,
        page: Buffer.from(html, 'utf8'),
        visibility,
        contains: bundle.contains,
        ctx,
      });

      return {
        provider: 's3',
        watchUrl: links.watchUrl,
        videoUrl: links.urls.video,
        posterUrl: links.urls.poster,
        captionsUrl: links.urls.captions,
        expiresAt: links.urls.linkExpiresAt,
        visibility,
        location: `s3://${bucket}/${keyPrefix}`,
      };
    } finally {
      client.destroy();
    }
  }
}
