import { describe, expect, it } from 'vitest';
import { resolveConfig, type SecretName, Secrets } from '../../core/config.ts';
import { Redactor } from '../../core/redact.ts';
import { ACCESS_KEY, type PublishInput, SECRETS, useMockedS3, useS3Tests } from '../../testing/s3.ts';
import { findS3Problems } from './settings.ts';

const { setup, makeBundle } = useS3Tests();
const { s3Mock } = useMockedS3();

describe('findS3Problems', () => {
  const secretsOf = (entries: Partial<Record<SecretName, string>>) => new Secrets(entries, new Redactor());
  const configOf = (publish: PublishInput) =>
    resolveConfig({ skipFile: true, env: {}, overrides: { publish: { provider: 's3', ...publish } } });

  it('tells every problem apart, so each can be shown on its own', () => {
    const config = configOf({ visibility: 'public' });
    const problems = findS3Problems(
      config,
      secretsOf({ MERGESTORY_S3_ACCESS_KEY_ID: ACCESS_KEY }),
      'public',
      true,
    );
    expect(problems.privacy?.code).toBe('PRIVACY_BLOCKED');
    expect(problems.bucket?.message).toBe('No storage bucket is configured.');
    expect(problems.publicBase?.message).toBe('Public links need a public base URL.');
    expect(problems.keys?.message).toBe('Only one of the two storage credential variables is set.');
  });

  it('finds nothing for complete settings, and judges the links by the visibility it is given', () => {
    const config = configOf({ s3: { bucket: 'media' } });
    expect(findS3Problems(config, secretsOf(SECRETS), 'private', null)).toEqual({
      privacy: null,
      bucket: null,
      publicBase: null,
      keys: null,
    });
    // The same settings need an address once the links are public or protected.
    expect(findS3Problems(config, secretsOf({}), 'protected', true).publicBase?.message).toBe(
      'Protected links need a public base URL.',
    );
    expect(findS3Problems(config, secretsOf({}), 'protected', true).privacy).toBeNull();
  });
});

describe('S3Publisher privacy guard for public links', () => {
  const publicBase = 'https://cdn.example.com/media/';
  const options = { publish: { visibility: 'public' }, s3: { publicBaseUrl: publicBase } } as const;

  it('blocks public links for a private repository', async () => {
    const { bundle } = await makeBundle({ repoIsPrivate: true });
    const { ctx, publisher } = setup(options);
    await expect(publisher.publish(bundle, ctx)).rejects.toMatchObject({
      code: 'PRIVACY_BLOCKED',
      message: expect.stringContaining('private'),
      hint: expect.stringContaining('allowPublicForPrivateRepos'),
    });
    expect(s3Mock.calls()).toHaveLength(0);
  });

  it('blocks public links when it is not known whether the repository is private', async () => {
    const { bundle } = await makeBundle({ repoIsPrivate: null });
    const { ctx, publisher } = setup(options);
    await expect(publisher.publish(bundle, ctx)).rejects.toMatchObject({ code: 'PRIVACY_BLOCKED' });
    // A bundle that does not say is as unknown as one that says so.
    delete (bundle as { repoIsPrivate?: boolean | null }).repoIsPrivate;
    await expect(publisher.publish(bundle, ctx)).rejects.toMatchObject({ code: 'PRIVACY_BLOCKED' });
    expect(s3Mock.calls()).toHaveLength(0);
  });

  it('allows public links for a public repository', async () => {
    const { bundle } = await makeBundle({ repoIsPrivate: false });
    const { ctx, publisher } = setup(options);
    await expect(publisher.publish(bundle, ctx)).resolves.toMatchObject({ visibility: 'public' });
  });

  it('allows public links for a private repository when the config says so', async () => {
    for (const repoIsPrivate of [true, null]) {
      const { bundle } = await makeBundle({ repoIsPrivate });
      const { ctx, publisher } = setup({
        ...options,
        publish: { ...options.publish, allowPublicForPrivateRepos: true },
      });
      await expect(publisher.publish(bundle, ctx)).resolves.toMatchObject({ visibility: 'public' });
    }
  });

  it('falls back to signed links for a kind of link it does not know, so nothing becomes public by mistake', async () => {
    const { bundle } = await makeBundle({ repoIsPrivate: true });
    const { ctx, config, publisher } = setup(options);
    (config.publish as { visibility: string }).visibility = 'unlisted';
    const result = await publisher.publish(bundle, ctx);
    expect(new URL(result.videoUrl).searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(result.expiresAt).not.toBeNull();
  });

  it('does not get in the way of private links', async () => {
    for (const repoIsPrivate of [true, false, null]) {
      const { bundle } = await makeBundle({ repoIsPrivate });
      const { ctx, publisher } = setup();
      await expect(publisher.publish(bundle, ctx)).resolves.toMatchObject({ visibility: 'private' });
    }
  });
});
