import { PutObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import type { SecretName } from '../../core/config.ts';
import { MergeStoryError } from '../../core/errors.ts';
import {
  ACCESS_KEY,
  type PublishInput,
  SECRET_KEY,
  SECRETS,
  tokenOf,
  useMockedS3,
  useS3Tests,
} from '../../testing/s3.ts';
import { S3Publisher } from './publisher.ts';

const { setup, makeBundle } = useS3Tests();
const { s3Mock, puts } = useMockedS3();

describe('S3Publisher.check', () => {
  const protectedLinks = (publicBaseUrl: string | null = 'https://videos.example.com') =>
    ({ publish: { visibility: 'protected' }, s3: { publicBaseUrl } }) as const;
  const publicLinks = (allowPublicForPrivateRepos = false) =>
    ({
      publish: { visibility: 'public', allowPublicForPrivateRepos },
      s3: { publicBaseUrl: 'https://videos.example.com' },
    }) as const;

  it('finds nothing to complain about when the settings are complete', async () => {
    const { ctx, publisher } = setup();
    expect(await publisher.check(ctx, null)).toBeNull();
    const protectedSetup = setup(protectedLinks());
    expect(await protectedSetup.publisher.check(protectedSetup.ctx, true)).toBeNull();
    const publicSetup = setup(publicLinks());
    expect(await publicSetup.publisher.check(publicSetup.ctx, false)).toBeNull();
  });

  it('stops a missing bucket, with the words of the upload', async () => {
    const { ctx, publisher } = setup({ s3: { bucket: null } });
    const problem = await publisher.check(ctx, null);
    expect(problem?.code).toBe('CONFIG_INVALID');
    expect(problem?.message).toBe('No storage bucket is configured.');
    expect(problem?.hint).toContain('MERGESTORY_S3_BUCKET');
    const blank = setup({ s3: { bucket: '  ' } });
    expect((await blank.publisher.check(blank.ctx, null))?.message).toBe('No storage bucket is configured.');
  });

  it('stops protected and public links without a public base URL, and one that is not a plain http(s) address', async () => {
    const protectedLinksSetup = setup(protectedLinks(null));
    expect((await protectedLinksSetup.publisher.check(protectedLinksSetup.ctx, true))?.message).toBe(
      'Protected links need a public base URL.',
    );
    const publicLinksSetup = setup({ publish: { visibility: 'public' } });
    expect((await publicLinksSetup.publisher.check(publicLinksSetup.ctx, false))?.message).toBe(
      'Public links need a public base URL.',
    );
    for (const address of ['ftp://videos.example.com', 'https://user:pw@videos.example.com']) {
      const odd = setup(protectedLinks(address));
      expect((await odd.publisher.check(odd.ctx, true))?.code, address).toBe('CONFIG_INVALID');
    }
    // Signed links need no address.
    const signed = setup({ s3: { publicBaseUrl: 'ftp://videos.example.com' } });
    expect(await signed.publisher.check(signed.ctx, null)).toBeNull();
  });

  it('blocks public links for a private repository, or one that cannot be told apart, unless allowed', async () => {
    const { ctx, publisher } = setup(publicLinks());
    const privateRepo = await publisher.check(ctx, true);
    expect(privateRepo?.code).toBe('PRIVACY_BLOCKED');
    expect(privateRepo?.message).toBe('This repository is private, so public video links are blocked.');
    expect((await publisher.check(ctx, null))?.message).toContain(
      'cannot tell whether this repository is private',
    );
    expect(await publisher.check(ctx, false)).toBeNull();
    const allowed = setup(publicLinks(true));
    expect(await allowed.publisher.check(allowed.ctx, true)).toBeNull();
    // Protected links are what private repositories are for.
    const protectedSetup = setup(protectedLinks());
    expect(await protectedSetup.publisher.check(protectedSetup.ctx, true)).toBeNull();
  });

  it('stops half a pair of storage credentials, and accepts both or neither', async () => {
    for (const secrets of [
      { MERGESTORY_S3_ACCESS_KEY_ID: ACCESS_KEY },
      { MERGESTORY_S3_SECRET_ACCESS_KEY: SECRET_KEY },
    ] as Partial<Record<SecretName, string>>[]) {
      const { ctx, publisher } = setup({ secrets });
      expect((await publisher.check(ctx, null))?.message).toBe(
        'Only one of the two storage credential variables is set.',
      );
    }
    for (const secrets of [SECRETS, {}]) {
      const { ctx, publisher } = setup({ secrets });
      expect(await publisher.check(ctx, null)).toBeNull();
    }
  });

  it('reports the privacy rule first, then the bucket, the address and the keys', async () => {
    const both = setup({
      ...publicLinks(),
      s3: { bucket: null },
      secrets: { MERGESTORY_S3_ACCESS_KEY_ID: 'k' },
    });
    expect((await both.publisher.check(both.ctx, true))?.code).toBe('PRIVACY_BLOCKED');
    expect((await both.publisher.check(both.ctx, false))?.message).toBe('No storage bucket is configured.');
    const noAddress = setup({
      publish: { visibility: 'public' },
      secrets: { MERGESTORY_S3_ACCESS_KEY_ID: 'k' },
    });
    expect((await noAddress.publisher.check(noAddress.ctx, false))?.message).toBe(
      'Public links need a public base URL.',
    );
  });

  it('takes the settings it was built with, not those of the context', async () => {
    const { ctx } = setup();
    const { config } = setup({ s3: { bucket: null } });
    expect((await new S3Publisher(config).check(ctx, null))?.message).toBe(
      'No storage bucket is configured.',
    );
  });

  it('is the check that publish() makes first, before the files are looked at', async () => {
    const { ctx, publisher } = setup({ secrets: { MERGESTORY_S3_ACCESS_KEY_ID: ACCESS_KEY } });
    const { bundle } = await makeBundle();
    const problem = await publisher.check(ctx, null);
    const error = await publisher.publish({ ...bundle, files: [] }, ctx).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: problem?.code, message: problem?.message, hint: problem?.hint });
    expect(s3Mock.calls()).toHaveLength(0);
  });

  it('judges publish() by the same settings: public links for a private repository stop in both', async () => {
    const { bundle } = await makeBundle({ repoIsPrivate: true });
    const { ctx, publisher } = setup(publicLinks());
    const problem = await publisher.check(ctx, true);
    expect(problem?.code).toBe('PRIVACY_BLOCKED');
    await expect(publisher.publish(bundle, ctx)).rejects.toMatchObject({
      code: 'PRIVACY_BLOCKED',
      message: problem?.message,
    });
    expect(s3Mock.calls()).toHaveLength(0);
  });
});

describe('S3Publisher.plannedEgress', () => {
  const MB = 1_000_000;
  const plan = (publish: PublishInput = {}, s3: NonNullable<PublishInput['s3']> = {}) => {
    const { publisher } = setup({ publish, s3: { region: 'auto', ...s3 } });
    return publisher.plannedEgress(11 * MB);
  };
  const bucketOnly = { endpoint: null };

  it('names the real host of the upload, without a port, and never a placeholder', () => {
    expect(plan({}, { endpoint: 'https://acct.r2.cloudflarestorage.com' })[0]).toEqual({
      destination: 'acct.r2.cloudflarestorage.com',
      purpose: 'video upload',
      bytes: 11 * MB,
      contains: ['video', 'narration-text', 'storyboard', 'pr-metadata'],
    });
    expect(plan({}, { endpoint: 'http://127.0.0.1:9000' })[0]?.destination).toBe('127.0.0.1');
    expect(plan({}, { ...bucketOnly, region: 'eu-west-2' })[0]?.destination).toBe(
      'media.s3.eu-west-2.amazonaws.com',
    );
  });

  it('looks for the region of an Amazon bucket in the environment, as the upload does', () => {
    vi.stubEnv('AWS_REGION', 'us-east-1');
    expect(plan({}, bucketOnly)[0]?.destination).toBe('media.s3.us-east-1.amazonaws.com');
    vi.stubEnv('AWS_REGION', '');
    vi.stubEnv('AWS_DEFAULT_REGION', 'ap-south-1');
    expect(plan({}, bucketOnly)[0]?.destination).toBe('media.s3.amazonaws.com');
    vi.stubEnv('AWS_REGION', undefined);
    expect(plan({}, bucketOnly)[0]?.destination).toBe('media.s3.ap-south-1.amazonaws.com');
    vi.stubEnv('AWS_DEFAULT_REGION', '');
    expect(plan({}, bucketOnly)[0]?.destination).toBe('media.s3.amazonaws.com');
  });

  it('adds the protection check, which carries nothing, only for protected links that are checked', () => {
    const protectedLinks = {
      publish: { visibility: 'protected' } as const,
      s3: {
        endpoint: 'https://acct.r2.cloudflarestorage.com',
        publicBaseUrl: 'https://videos.example.com:8443/x',
      },
    };
    expect(
      plan(protectedLinks.publish, protectedLinks.s3).map((e) => [e.destination, e.purpose, e.bytes]),
    ).toEqual([
      ['acct.r2.cloudflarestorage.com', 'video upload', 11 * MB],
      ['videos.example.com', 'protection check', 0],
    ]);
    expect(plan(protectedLinks.publish, { ...protectedLinks.s3, verifyProtection: false })).toHaveLength(1);
    expect(plan({ visibility: 'public' }, protectedLinks.s3)).toHaveLength(1);
    expect(plan({ visibility: 'protected' }, { endpoint: protectedLinks.s3.endpoint })).toHaveLength(1);
  });

  it('plans nothing without a bucket', () => {
    expect(plan({}, { bucket: null })).toEqual([]);
    expect(plan({}, { bucket: '  ' })).toEqual([]);
  });
});

describe('S3Publisher key prefix', () => {
  it('never uploads to the root of the bucket: every upload gets a folder with its own random token', async () => {
    const tokens: string[] = [];
    for (let i = 0; i < 2; i++) {
      s3Mock.reset();
      s3Mock.on(PutObjectCommand).resolves({ ETag: '"etag"' });
      const { bundle } = await makeBundle();
      const { ctx, publisher } = setup();
      const result = await publisher.publish(bundle, ctx);
      const first = puts()[0]?.Key;
      expect(first).toMatch(/^mergestory\/v\/[0-9a-f]{32}\/video\.mp4$/);
      expect(result.location).toMatch(/^s3:\/\/media\/mergestory\/v\/[0-9a-f]{32}\/$/);
      expect(new URL(result.videoUrl).pathname).toBe(`/${first}`);
      tokens.push(tokenOf(result));
    }
    expect(new Set(tokens).size).toBe(2);
  });

  it('builds the random prefix from the configured folder name', async () => {
    const { bundle } = await makeBundle();
    const { ctx, publisher } = setup({ s3: { prefix: 'Team Videos/2026' } });
    await publisher.publish(bundle, ctx);
    expect(puts()[0]?.Key).toMatch(/^team-videos\/2026\/v\/[0-9a-f]{32}\/video\.mp4$/);
  });

  it('cannot be made to leave its folder by the configured name', async () => {
    for (const [prefix, folder] of [
      ['../x', 'x/'],
      ['/abs/', 'abs/'],
      ['a//b/', 'a/b/'],
      ['a/../b/', 'a/b/'],
      ['..', ''],
    ] as const) {
      s3Mock.reset();
      s3Mock.on(PutObjectCommand).resolves({ ETag: '"etag"' });
      const { bundle } = await makeBundle();
      const { ctx, publisher } = setup({ s3: { prefix } });
      await publisher.publish(bundle, ctx);
      expect(puts()[0]?.Key, prefix).toMatch(new RegExp(`^${folder}v/[0-9a-f]{32}/video\\.mp4$`));
    }
  });
});

describe('S3Publisher refuses to start', () => {
  it('without a bucket', async () => {
    const { bundle } = await makeBundle();
    for (const bucket of [null, '', '   ']) {
      const { ctx, publisher } = setup({ s3: { bucket } });
      await expect(publisher.publish(bundle, ctx)).rejects.toMatchObject({
        code: 'CONFIG_INVALID',
        hint: expect.stringContaining('MERGESTORY_S3_BUCKET'),
      });
    }
    expect(s3Mock.calls()).toHaveLength(0);
  });

  it('during a dry run', async () => {
    const { bundle } = await makeBundle();
    const { ctx, publisher } = setup({ dryRun: true });
    await expect(publisher.publish(bundle, ctx)).rejects.toBeInstanceOf(MergeStoryError);
    expect(s3Mock.calls()).toHaveLength(0);
  });

  it('when the run was cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const { bundle } = await makeBundle();
    const { ctx, publisher } = setup({ signal: controller.signal });
    await expect(publisher.publish(bundle, ctx)).rejects.toMatchObject({ code: 'ABORTED' });
    expect(s3Mock.calls()).toHaveLength(0);
  });

  it('with a file that is named like the watch page', async () => {
    const { bundle } = await makeBundle();
    bundle.files.push({ name: 'index.html', path: bundle.files[0]?.path ?? '' });
    const { ctx, publisher } = setup();
    await expect(publisher.publish(bundle, ctx)).rejects.toMatchObject({ code: 'PUBLISH_FAILED' });
    expect(s3Mock.calls()).toHaveLength(0);
  });

  it('with a bundle that has no video', async () => {
    const { bundle } = await makeBundle();
    bundle.files = bundle.files.filter((f) => f.name !== 'video.mp4');
    const { ctx, publisher } = setup();
    await expect(publisher.publish(bundle, ctx)).rejects.toMatchObject({ code: 'PUBLISH_FAILED' });
    expect(s3Mock.calls()).toHaveLength(0);
  });
});
