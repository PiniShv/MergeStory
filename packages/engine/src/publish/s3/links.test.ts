import type { S3Client } from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it } from 'vitest';
import { MergeStoryError } from '../../core/errors.ts';
import { type Logger, silentLogger } from '../../core/logger.ts';
import { ACCESS_KEY, folderOf, useMockedS3, useS3Tests } from '../../testing/s3.ts';
import { classifyBundle } from '../bundle.ts';
import type { S3Libs } from './client.ts';
import { directLinks, linkLifetime, signedLinks } from './links.ts';

const { setup, makeBundle } = useS3Tests();
const { s3Mock, puts, pageBody } = useMockedS3();
const decode = (html: string) => html.replace(/&amp;/g, '&');

describe('S3Publisher with signed links (the default)', () => {
  it('shares signed links and says exactly when they stop working', async () => {
    const { bundle, seen } = await makeBundle();
    const { ctx, publisher } = setup();
    const before = Date.now();
    const result = await publisher.publish(bundle, ctx);
    const keyPrefix = folderOf(result);

    expect(result).toMatchObject({ provider: 's3', visibility: 'private' });
    expect(keyPrefix).toMatch(/^mergestory\/v\/[0-9a-f]{32}\/$/);
    for (const [url, name] of [
      [result.videoUrl, 'video.mp4'],
      [result.posterUrl, 'poster.jpg'],
      [result.captionsUrl, 'captions.vtt'],
      [result.watchUrl, 'index.html'],
    ] as const) {
      const parsed = new URL(url ?? '');
      expect(parsed.host).toBe('media.s3.us-east-1.amazonaws.com');
      expect(parsed.pathname).toBe(`/${keyPrefix}${name}`);
      expect(parsed.searchParams.get('X-Amz-Expires')).toBe('3600');
      expect(parsed.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
      expect(parsed.searchParams.get('X-Amz-Credential')?.startsWith(`${ACCESS_KEY}/`)).toBe(true);
    }

    // Every link was signed at the same moment, so the expiry that people see is exact.
    const signedAt = new URL(result.videoUrl).searchParams.get('X-Amz-Date') ?? '';
    const signedMs = Date.UTC(
      +signedAt.slice(0, 4),
      +signedAt.slice(4, 6) - 1,
      +signedAt.slice(6, 8),
      +signedAt.slice(9, 11),
      +signedAt.slice(11, 13),
      +signedAt.slice(13, 15),
    );
    expect(Math.abs(Date.parse(result.expiresAt ?? '') - (signedMs + 3600 * 1000))).toBeLessThan(1000);
    expect(Date.parse(result.expiresAt ?? '')).toBeGreaterThan(before + 3_000_000);
    expect(seen.urls?.linkExpiresAt).toBe(result.expiresAt);
  });

  it('builds the watch page from the signed links and uploads that page', async () => {
    const { bundle, seen } = await makeBundle();
    const { ctx, publisher } = setup();
    const result = await publisher.publish(bundle, ctx);

    expect(seen.urls?.video).toBe(result.videoUrl);
    expect(seen.urls?.poster).toBe(result.posterUrl);
    expect(seen.urls?.captions).toBe(result.captionsUrl);
    const html = decode(pageBody());
    expect(html).toContain(result.videoUrl);
    expect(html).toContain(result.posterUrl ?? '');
    expect(html).toContain(result.captionsUrl ?? '');
    expect(html).toContain('<meta http-equiv="Content-Security-Policy"');
    expect(html).toContain('This link expires on');
  });

  it('caps the lifetime of signed links at seven days', async () => {
    const { bundle } = await makeBundle();
    const { ctx, config, publisher } = setup();
    // The settings do not allow more than seven days, so this takes the value past the settings check.
    (config.publish as { linkExpirySec: number }).linkExpirySec = 99_999_999;
    const result = await publisher.publish(bundle, ctx);
    expect(new URL(result.videoUrl).searchParams.get('X-Amz-Expires')).toBe('604800');
  });
});

describe('S3Publisher with public links', () => {
  const publicBase = 'https://cdn.example.com/media/';

  it('uses the public base URL and signs nothing', async () => {
    const { bundle, seen } = await makeBundle({ repoIsPrivate: false });
    const { ctx, publisher } = setup({
      publish: { visibility: 'public' },
      s3: { publicBaseUrl: publicBase },
    });
    const result = await publisher.publish(bundle, ctx);
    const keyPrefix = folderOf(result);

    const base = `https://cdn.example.com/media/${keyPrefix}`;
    expect(result).toEqual({
      provider: 's3',
      watchUrl: `${base}index.html`,
      videoUrl: `${base}video.mp4`,
      posterUrl: `${base}poster.jpg`,
      captionsUrl: `${base}captions.vtt`,
      expiresAt: null,
      visibility: 'public',
      location: `s3://media/${keyPrefix}`,
    });
    expect(seen.urls?.linkExpiresAt).toBeNull();
    const html = pageBody();
    expect(html).toContain(`${base}video.mp4`);
    expect(html).toContain('media-src https://cdn.example.com');
    expect(html).not.toContain('X-Amz');
    expect(html).not.toContain('This link expires');
  });

  it('caches public files for a year, the page included', async () => {
    const { bundle } = await makeBundle({ repoIsPrivate: false });
    const { ctx, publisher } = setup({
      publish: { visibility: 'public' },
      s3: { publicBaseUrl: publicBase },
    });
    await publisher.publish(bundle, ctx);
    expect(puts().every((i) => i.CacheControl === 'public, max-age=31536000, immutable')).toBe(true);
  });

  it('needs a public base URL', async () => {
    const { bundle } = await makeBundle({ repoIsPrivate: false });
    const { ctx, publisher } = setup({ publish: { visibility: 'public' } });
    await expect(publisher.publish(bundle, ctx)).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      hint: expect.stringContaining('MERGESTORY_S3_PUBLIC_BASE_URL'),
    });
    expect(s3Mock.calls()).toHaveLength(0);
  });

  it('only accepts an http(s) base URL', async () => {
    const { bundle } = await makeBundle({ repoIsPrivate: false });
    const { ctx, publisher } = setup({
      publish: { visibility: 'public' },
      s3: { publicBaseUrl: 'ftp://cdn.example.com' },
    });
    await expect(publisher.publish(bundle, ctx)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });
});

describe('linkLifetime', () => {
  const now = Date.UTC(2026, 10, 3, 12, 0, 0);
  const warnings: unknown[][] = [];
  const logger = { ...silentLogger, warn: (...args: unknown[]) => void warnings.push(args) } as Logger;

  beforeEach(() => {
    warnings.length = 0;
  });

  it('keeps a lifetime that fits', () => {
    expect(linkLifetime(3600, undefined, { logger }, now)).toBe(3600);
    expect(linkLifetime(604_800, undefined, { logger }, now)).toBe(604_800);
  });

  it('stays within what signed links allow', () => {
    expect(linkLifetime(10_000_000, undefined, { logger }, now)).toBe(604_800);
    expect(linkLifetime(5, undefined, { logger }, now)).toBe(60);
    expect(linkLifetime(Number.NaN, undefined, { logger }, now)).toBe(604_800);
  });

  it('ends the links when the credentials that signed them expire', () => {
    const expiresIn2h = new Date(now + 2 * 3600 * 1000);
    expect(linkLifetime(604_800, expiresIn2h, { logger }, now)).toBe(7200);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.[1]).toEqual({ seconds: 7200 });
  });

  it('leaves the lifetime alone when the credentials last longer', () => {
    expect(linkLifetime(3600, new Date(now + 6 * 3600 * 1000), { logger }, now)).toBe(3600);
    expect(warnings).toHaveLength(0);
  });

  it('refuses credentials that expire within a minute', () => {
    expect(() => linkLifetime(3600, new Date(now + 30_000), { logger }, now)).toThrow(MergeStoryError);
    expect(() => linkLifetime(3600, new Date(now - 1000), { logger }, now)).toThrow(/expire too soon/);
  });
});

describe('directLinks', () => {
  it('builds the addresses from the public base URL and the folder, and nothing expires', async () => {
    const files = await classifyBundle((await makeBundle()).bundle);
    expect(directLinks('https://cdn.example.com/media', 'team/v/0123/', files)).toEqual({
      urls: {
        video: 'https://cdn.example.com/media/team/v/0123/video.mp4',
        poster: 'https://cdn.example.com/media/team/v/0123/poster.jpg',
        captions: 'https://cdn.example.com/media/team/v/0123/captions.vtt',
        linkExpiresAt: null,
      },
      watchUrl: 'https://cdn.example.com/media/team/v/0123/index.html',
    });
  });

  it('leaves out the poster and the captions that the bundle does not have', async () => {
    const { bundle } = await makeBundle();
    const files = await classifyBundle({ files: bundle.files.filter((file) => file.name === 'video.mp4') });
    const { urls } = directLinks('https://cdn.example.com', 'v/0123/', files);
    expect(urls.poster).toBeNull();
    expect(urls.captions).toBeNull();
  });

  it('writes each part of the folder as a safe part of an address', async () => {
    const files = await classifyBundle((await makeBundle()).bundle);
    expect(directLinks('https://cdn.example.com', 'my folder/v/a?b#c/', files).urls.video).toBe(
      'https://cdn.example.com/my%20folder/v/a%3Fb%23c/video.mp4',
    );
  });
});

describe('signedLinks', () => {
  const libs = {
    GetObjectCommand: class {
      input: { Bucket: string; Key: string };
      constructor(input: { Bucket: string; Key: string }) {
        this.input = input;
      }
    },
    // Signs with what it is given, so that the test sees the key, the lifetime and the moment of signing.
    getSignedUrl: async (
      _client: unknown,
      command: { input: { Bucket: string; Key: string } },
      options: { expiresIn: number; signingDate: Date },
    ) =>
      `signed:${command.input.Bucket}/${command.input.Key}|${options.expiresIn}|${options.signingDate.toISOString()}`,
  } as unknown as S3Libs;
  const client = {} as S3Client;
  const ctx = { logger: silentLogger };

  it('signs every address with one lifetime and one moment, and says when they stop working', async () => {
    const files = await classifyBundle((await makeBundle()).bundle);
    const links = await signedLinks({
      libs,
      client,
      bucket: 'media',
      keyPrefix: 'v/0123/',
      files,
      lifetimeSec: 3600,
      credentialsExpire: undefined,
      ctx,
    });
    const signed = [links.urls.video, links.urls.poster, links.urls.captions, links.watchUrl];
    const parts = signed.map((link) => /^signed:media\/v\/0123\/(.*)\|(\d+)\|(.*)$/.exec(link ?? ''));
    expect(parts.map((m) => m?.[1])).toEqual(['video.mp4', 'poster.jpg', 'captions.vtt', 'index.html']);
    expect(new Set(parts.map((m) => m?.[2]))).toEqual(new Set(['3600']));
    const moments = new Set(parts.map((m) => m?.[3]));
    expect(moments.size).toBe(1);
    const [moment] = [...moments];
    expect(links.urls.linkExpiresAt).toBe(new Date(Date.parse(moment ?? '') + 3600 * 1000).toISOString());
  });

  it('leaves out the poster and the captions that the bundle does not have', async () => {
    const { bundle } = await makeBundle();
    const files = await classifyBundle({ files: bundle.files.filter((file) => file.name === 'video.mp4') });
    const { urls } = await signedLinks({
      libs,
      client,
      bucket: 'media',
      keyPrefix: 'v/0123/',
      files,
      lifetimeSec: 3600,
      credentialsExpire: undefined,
      ctx,
    });
    expect([urls.poster, urls.captions]).toEqual([null, null]);
  });

  it('keeps the lifetime within what the credentials allow, and within what signed links allow', async () => {
    const files = await classifyBundle((await makeBundle()).bundle);
    const lifetimeOf = async (lifetimeSec: number, credentialsExpire?: Date) =>
      Number(
        /\|(\d+)\|/.exec(
          (
            await signedLinks({
              libs,
              client,
              bucket: 'media',
              keyPrefix: 'v/0123/',
              files,
              lifetimeSec,
              credentialsExpire,
              ctx,
            })
          ).urls.video,
        )?.[1],
      );
    expect(await lifetimeOf(99_999_999)).toBe(604_800);
    const inTwoHours = new Date(Date.now() + 2 * 3600 * 1000);
    expect(Math.abs((await lifetimeOf(604_800, inTwoHours)) - 7200)).toBeLessThan(5);
  });
});
