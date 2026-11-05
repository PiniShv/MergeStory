import { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { resolveConfig, type SecretName, Secrets } from '../../core/config.ts';
import { Redactor } from '../../core/redact.ts';
import {
  ACCESS_KEY,
  folderOf,
  type PublishInput,
  SECRET_KEY,
  SECRETS,
  useMockedS3,
  useS3Tests,
} from '../../testing/s3.ts';
import { buildClientOptions } from './client.ts';

const { setup, makeBundle, emptyAwsEnvironment } = useS3Tests();
const { s3Mock } = useMockedS3();

describe('S3Publisher with S3-compatible services', () => {
  const endpoint = 'https://acct123.r2.cloudflarestorage.com';

  it('signs for region "auto" and leaves out checksum parameters that other services reject', async () => {
    const { bundle } = await makeBundle();
    const { ctx, publisher } = setup({ s3: { endpoint, region: 'auto' } });
    const result = await publisher.publish(bundle, ctx);
    const keyPrefix = folderOf(result);

    const parsed = new URL(result.videoUrl);
    expect(parsed.host).toBe('media.acct123.r2.cloudflarestorage.com');
    expect(parsed.pathname).toBe(`/${keyPrefix}video.mp4`);
    expect(parsed.searchParams.get('X-Amz-Credential')).toContain('/auto/s3/aws4_request');
    expect(parsed.searchParams.has('x-amz-checksum-mode')).toBe(false);
    expect(ctx.egress.list()[0]?.destination).toBe('acct123.r2.cloudflarestorage.com');
  });

  it('signs for the region in a Backblaze B2 address when the region is left on auto', async () => {
    const { bundle } = await makeBundle();
    const { ctx, publisher } = setup({
      s3: { endpoint: 'https://s3.us-west-004.backblazeb2.com', region: 'auto' },
    });
    const result = await publisher.publish(bundle, ctx);
    const keyPrefix = folderOf(result);
    const parsed = new URL(result.videoUrl);
    expect(parsed.host).toBe('media.s3.us-west-004.backblazeb2.com');
    expect(parsed.pathname).toBe(`/${keyPrefix}video.mp4`);
    expect(parsed.searchParams.get('X-Amz-Credential')).toContain('/us-west-004/s3/aws4_request');
    expect(parsed.searchParams.has('x-amz-checksum-mode')).toBe(false);
  });

  it('signs for the region that was set, also for Backblaze B2', async () => {
    const { bundle } = await makeBundle();
    const { ctx, publisher } = setup({
      s3: { endpoint: 'https://s3.us-west-004.backblazeb2.com', region: 'us-east-005' },
    });
    const result = await publisher.publish(bundle, ctx);
    expect(new URL(result.videoUrl).searchParams.get('X-Amz-Credential')).toContain(
      '/us-east-005/s3/aws4_request',
    );
  });

  it('signs for region "auto" with Google Cloud Storage and leaves out checksum parameters', async () => {
    const { bundle } = await makeBundle();
    const { ctx, publisher } = setup({
      s3: { endpoint: 'https://storage.googleapis.com', region: 'auto', forcePathStyle: true },
    });
    const result = await publisher.publish(bundle, ctx);
    const keyPrefix = folderOf(result);
    const parsed = new URL(result.videoUrl);
    expect(parsed.host).toBe('storage.googleapis.com');
    expect(parsed.pathname).toBe(`/media/${keyPrefix}video.mp4`);
    expect(parsed.searchParams.get('X-Amz-Credential')).toContain('/auto/s3/aws4_request');
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(parsed.searchParams.has('x-amz-checksum-mode')).toBe(false);
  });

  it('can use path-style addresses', async () => {
    const { bundle } = await makeBundle();
    const { ctx, publisher } = setup({ s3: { endpoint, region: 'auto', forcePathStyle: true } });
    const result = await publisher.publish(bundle, ctx);
    const keyPrefix = folderOf(result);
    const parsed = new URL(result.watchUrl ?? '');
    expect(parsed.host).toBe('acct123.r2.cloudflarestorage.com');
    expect(parsed.pathname).toBe(`/media/${keyPrefix}index.html`);
  });

  it('takes the region of an Amazon endpoint from its address', async () => {
    const { bundle } = await makeBundle();
    const { ctx, publisher } = setup({
      s3: { endpoint: 'https://s3.eu-west-2.amazonaws.com', region: 'auto' },
    });
    const result = await publisher.publish(bundle, ctx);
    expect(new URL(result.videoUrl).searchParams.get('X-Amz-Credential')).toContain(
      '/eu-west-2/s3/aws4_request',
    );
  });

  it('finds the region of an Amazon bucket in the environment', async () => {
    emptyAwsEnvironment();
    vi.stubEnv('AWS_REGION', 'ap-south-1');
    const { bundle } = await makeBundle();
    const { ctx, publisher } = setup({ s3: { region: 'auto' } });
    const result = await publisher.publish(bundle, ctx);
    expect(new URL(result.videoUrl).host).toBe('media.s3.ap-south-1.amazonaws.com');
    expect(ctx.egress.list()[0]?.destination).toBe('media.s3.ap-south-1.amazonaws.com');
  });

  it('asks for a region when none can be found', async () => {
    emptyAwsEnvironment();
    const { bundle } = await makeBundle();
    const { ctx, publisher } = setup({ s3: { region: 'auto' } });
    await expect(publisher.publish(bundle, ctx)).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      hint: expect.stringContaining('MERGESTORY_S3_REGION'),
    });
    expect(s3Mock.calls()).toHaveLength(0);
  });
});

describe('S3Publisher credentials', () => {
  it('falls back to the AWS credential chain', async () => {
    emptyAwsEnvironment();
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'chain-key-id');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'chain-secret-value-0123456789');
    const { bundle } = await makeBundle();
    const { ctx, publisher } = setup({ secrets: {} });
    const result = await publisher.publish(bundle, ctx);
    expect(new URL(result.videoUrl).searchParams.get('X-Amz-Credential')).toMatch(/^chain-key-id\//);
  });

  it('prefers the MergeStory variables over the AWS ones', async () => {
    emptyAwsEnvironment();
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'chain-key-id');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'chain-secret-value-0123456789');
    const { bundle } = await makeBundle();
    const { ctx, publisher } = setup();
    const result = await publisher.publish(bundle, ctx);
    expect(new URL(result.videoUrl).searchParams.get('X-Amz-Credential')).toMatch(
      new RegExp(`^${ACCESS_KEY}/`),
    );
  });

  it('explains what is missing when there are no credentials at all', async () => {
    emptyAwsEnvironment();
    const { bundle } = await makeBundle();
    const { ctx, publisher } = setup({ secrets: {} });
    await expect(publisher.publish(bundle, ctx)).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      hint: expect.stringContaining('MERGESTORY_S3_ACCESS_KEY_ID'),
    });
    expect(s3Mock.calls()).toHaveLength(0);
  });

  it('refuses half a pair of credentials', async () => {
    const { bundle } = await makeBundle();
    for (const secrets of [
      { MERGESTORY_S3_ACCESS_KEY_ID: ACCESS_KEY },
      { MERGESTORY_S3_SECRET_ACCESS_KEY: SECRET_KEY },
    ] as Partial<Record<SecretName, string>>[]) {
      const { ctx, publisher } = setup({ secrets });
      await expect(publisher.publish(bundle, ctx)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    }
    expect(s3Mock.calls()).toHaveLength(0);
  });
});

describe('client settings by endpoint type', () => {
  const secrets = new Secrets(SECRETS, new Redactor());
  const settings = (s3: NonNullable<PublishInput['s3']>) =>
    resolveConfig({
      skipFile: true,
      env: {},
      overrides: { publish: { provider: 's3', s3: { bucket: 'media', ...s3 } } },
    }).publish.s3;

  it.each([
    ['Cloudflare R2', 'https://acct123.r2.cloudflarestorage.com'],
    ['Backblaze B2', 'https://s3.us-west-004.backblazeb2.com'],
    ['Google Cloud Storage', 'https://storage.googleapis.com'],
    ['MinIO or SeaweedFS on this machine', 'http://127.0.0.1:9000'],
    ['a server on a private name', 'http://garage.internal:3900'],
    ['a look-alike of an Amazon name', 'https://s3.amazonaws.com.example.net'],
    ['a name that only ends like an Amazon one', 'https://notamazonaws.com'],
  ])('asks for checksums only when required: %s', async (_name, url) => {
    const client = new S3Client(buildClientOptions(settings({ endpoint: url }), secrets));
    expect(await client.config.requestChecksumCalculation()).toBe('WHEN_REQUIRED');
    expect(await client.config.responseChecksumValidation()).toBe('WHEN_REQUIRED');
    client.destroy();
  });

  it.each([
    ['no endpoint', null],
    ['a regional Amazon endpoint', 'https://s3.eu-west-2.amazonaws.com'],
    ['the global Amazon endpoint', 'https://s3.amazonaws.com'],
    ['an Amazon accelerate endpoint', 'https://bucket.s3-accelerate.amazonaws.com'],
    ['a dual-stack Amazon endpoint', 'https://s3.dualstack.us-east-1.amazonaws.com'],
    ['an Amazon China endpoint', 'https://s3.cn-north-1.amazonaws.com.cn'],
  ])('keeps the SDK defaults for Amazon S3: %s', async (_name, url) => {
    const options = buildClientOptions(settings({ endpoint: url }), secrets);
    expect(options).not.toHaveProperty('requestChecksumCalculation');
    expect(options).not.toHaveProperty('responseChecksumValidation');
    const client = new S3Client(options);
    expect(await client.config.requestChecksumCalculation()).toBe('WHEN_SUPPORTED');
    expect(await client.config.responseChecksumValidation()).toBe('WHEN_SUPPORTED');
    client.destroy();
  });

  it('passes the endpoint, the addressing style and the keys on', () => {
    const options = buildClientOptions(
      settings({ endpoint: 'https://storage.googleapis.com', forcePathStyle: true, region: 'auto' }),
      secrets,
    );
    expect(options).toMatchObject({
      endpoint: 'https://storage.googleapis.com',
      forcePathStyle: true,
      region: 'auto',
      credentials: { accessKeyId: 'test-access-key-id' },
    });
    expect(
      buildClientOptions(settings({ endpoint: 'https://x.example.com' }), new Secrets({}, new Redactor())),
    ).not.toHaveProperty('credentials');
  });

  it('does not take a word like "accelerate" for a region', () => {
    for (const url of [
      'https://bucket.s3-accelerate.amazonaws.com',
      'https://s3.dualstack.us-east-1.amazonaws.com',
    ]) {
      expect(buildClientOptions(settings({ endpoint: url }), secrets)).not.toHaveProperty('region');
    }
  });

  it('refuses half a pair of credentials', () => {
    const half = new Secrets({ MERGESTORY_S3_ACCESS_KEY_ID: 'only-the-id-0123456789' }, new Redactor());
    expect(() => buildClientOptions(settings({}), half)).toThrow(/Only one of the two/);
  });

  it.each([
    [
      'Backblaze B2 takes its region from the address',
      'https://s3.us-west-004.backblazeb2.com',
      'auto',
      'us-west-004',
    ],
    [
      'Backblaze B2 with a bucket in the host name',
      'https://media.s3.eu-central-003.backblazeb2.com',
      'auto',
      'eu-central-003',
    ],
    [
      'an explicit region wins over the address',
      'https://s3.us-west-004.backblazeb2.com',
      'us-east-005',
      'us-east-005',
    ],
    ['R2 signs with auto', 'https://acct123.r2.cloudflarestorage.com', 'auto', 'auto'],
    ['Google Cloud Storage signs with auto', 'https://storage.googleapis.com', 'auto', 'auto'],
    ['Amazon takes its region from the address', 'https://s3.eu-west-2.amazonaws.com', 'auto', 'eu-west-2'],
    [
      'Amazon China takes its region from the address',
      'https://s3.cn-north-1.amazonaws.com.cn',
      'auto',
      'cn-north-1',
    ],
    [
      'Amazon with the bucket in the host name',
      'https://media.s3.ap-southeast-2.amazonaws.com',
      'auto',
      'ap-southeast-2',
    ],
    ['a self-hosted server keeps the region that was set', 'http://127.0.0.1:9000', 'us-east-1', 'us-east-1'],
  ])('%s', async (_name, url, region, expected) => {
    const client = new S3Client(buildClientOptions(settings({ endpoint: url, region }), secrets));
    expect(await client.config.region()).toBe(expected);
    client.destroy();
  });
});
