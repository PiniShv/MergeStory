/**
 * The S3 publisher against a fake S3 server on the loopback interface. Nothing is mocked inside the
 * AWS SDK, so these tests see what really goes over the wire: headers, multipart requests and
 * the answers MergeStory has to cope with.
 */
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import {
  ACCESS_KEY,
  checksumHeaders,
  folderOf,
  MIB,
  type Recorded,
  type SetupOptions,
  useFakeS3,
  useS3Tests,
} from '../../testing/s3.ts';

const fake = useFakeS3();
const { setup: baseSetup, makeBundle: baseMakeBundle } = useS3Tests();
const setup = (options: SetupOptions = {}) =>
  baseSetup({ ...options, s3: { endpoint: fake.endpoint, forcePathStyle: true, ...options.s3 } });
/** A bundle of a public repository, so that every kind of link may be asked for. */
const makeBundle = (videoBytes: number) => baseMakeBundle({ videoBytes, repoIsPrivate: false });

const describeRequest = (r: Recorded): string => `${r.method} ${r.path}?${[...r.query.keys()].join('&')}`;

describe('the test server', () => {
  it('can see the checksum headers that the SDK sends by default', async () => {
    // A control: with the SDK defaults the checksum headers are there, so their absence below means something.
    const client = new S3Client({
      region: 'us-east-1',
      endpoint: fake.endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: 'a', secretAccessKey: 'b' },
    });
    await client.send(new PutObjectCommand({ Bucket: 'media', Key: 'k.txt', Body: Buffer.from('hello') }));
    client.destroy();
    const put = fake.requests.find((r) => r.method === 'PUT');
    expect(put?.headers['x-amz-checksum-crc32']).toBeTypeOf('string');
    expect(put?.headers['x-amz-sdk-checksum-algorithm']).toBe('CRC32');
  });
});

describe('uploads to an S3-compatible endpoint', () => {
  it('sends no checksum headers on any request, multipart included', async () => {
    const { bundle } = await makeBundle(9 * MIB);
    const { ctx, publisher } = setup();
    const keyPrefix = folderOf(await publisher.publish(bundle, ctx));

    expect(fake.requests.length).toBeGreaterThan(0);
    for (const request of fake.requests) {
      expect(checksumHeaders(request.headers), describeRequest(request)).toEqual([]);
      expect(String(request.headers['content-encoding'] ?? ''), describeRequest(request)).not.toContain(
        'aws-chunked',
      );
      expect(String(request.headers['x-amz-content-sha256'] ?? ''), describeRequest(request)).not.toMatch(
        /^STREAMING-/,
      );
      // Every request is signed, with the region that was configured.
      expect(request.headers.authorization, describeRequest(request)).toMatch(
        new RegExp(`^AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/\\d{8}/us-east-1/s3/aws4_request`),
      );
      expect(request.headers.authorization, describeRequest(request)).not.toMatch(/checksum/i);
    }

    const video = `/media/${keyPrefix}video.mp4`;
    const create = fake.requests.filter((r) => r.method === 'POST' && r.query.has('uploads'));
    expect(create.map((r) => r.path)).toEqual([video]);
    expect(create[0]?.headers['content-type']).toBe('video/mp4');
    expect(create[0]?.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(create[0]?.headers['content-disposition']).toBe('inline');
  });

  it('uploads a big video in parts of one fixed size and completes the upload with their tags', async () => {
    const { bundle } = await makeBundle(9 * MIB);
    const { ctx, publisher } = setup();
    const keyPrefix = folderOf(await publisher.publish(bundle, ctx));

    const video = `/media/${keyPrefix}video.mp4`;
    const parts = fake.requests
      .filter((r) => r.method === 'PUT' && r.query.has('partNumber'))
      .map((r) => ({ path: r.path, part: Number(r.query.get('partNumber')), bytes: r.body.length }))
      .sort((a, b) => a.part - b.part);
    expect(parts).toEqual([
      { path: video, part: 1, bytes: 8 * MIB },
      { path: video, part: 2, bytes: 1 * MIB },
    ]);

    const complete = fake.requests.filter((r) => r.method === 'POST' && r.query.has('uploadId'));
    expect(complete).toHaveLength(1);
    const body = complete[0]?.body.toString('utf8') ?? '';
    expect(body).toContain('<PartNumber>1</PartNumber>');
    expect(body).toContain('<PartNumber>2</PartNumber>');
    expect(body).toContain('etag-1');
    expect(body).toContain('etag-2');
    expect(body).not.toMatch(/Checksum/);

    // The other files are small, so each goes up in one request.
    const singles = fake.requests.filter((r) => r.method === 'PUT' && !r.query.has('partNumber'));
    expect(singles.map((r) => r.path.split('/').pop())).toEqual(['captions.vtt', 'poster.jpg', 'index.html']);
    expect(singles.map((r) => r.headers['content-type'])).toEqual([
      'text/vtt; charset=utf-8',
      'image/jpeg',
      'text/html; charset=utf-8',
    ]);
    expect(singles.every((r) => !('x-amz-acl' in r.headers))).toBe(true);
  });

  it('uploads a small video in one request without checksum headers', async () => {
    const { bundle } = await makeBundle(2048);
    const { ctx, publisher } = setup();
    const keyPrefix = folderOf(await publisher.publish(bundle, ctx));
    expect(fake.requests.some((r) => r.query.has('uploads'))).toBe(false);
    const put = fake.requests.find((r) => r.path === `/media/${keyPrefix}video.mp4`);
    expect(put?.method).toBe('PUT');
    expect(put?.headers['content-length']).toBe('2048');
    expect(put?.body.length).toBe(2048);
    expect(checksumHeaders(put?.headers ?? {})).toEqual([]);
  });

  it('gives no signed link a checksum parameter either', async () => {
    const { bundle } = await makeBundle(2048);
    const { ctx, publisher } = setup();
    const result = await publisher.publish(bundle, ctx);
    for (const link of [result.videoUrl, result.posterUrl, result.captionsUrl, result.watchUrl]) {
      const params = [...new URL(link ?? '').searchParams.keys()].map((k) => k.toLowerCase());
      expect(params.filter((k) => k.includes('checksum'))).toEqual([]);
    }
  });

  it('works the same with a public link', async () => {
    const { bundle } = await makeBundle(9 * MIB);
    const { ctx, publisher } = setup({
      publish: { visibility: 'public' },
      s3: { publicBaseUrl: 'https://cdn.example.com/media' },
    });
    const result = await publisher.publish(bundle, ctx);
    expect(result.visibility).toBe('public');
    for (const request of fake.requests) expect(checksumHeaders(request.headers)).toEqual([]);
  });

  it('stops an unfinished multipart upload with AbortMultipartUpload, and never with DeleteObjects', async () => {
    fake.behaviour.failPart = { part: 2, status: 403 };
    const { bundle } = await makeBundle(9 * MIB);
    const { ctx, publisher } = setup();
    await expect(publisher.publish(bundle, ctx)).rejects.toMatchObject({ code: 'PUBLISH_FAILED' });

    const deletes = fake.requests.filter((r) => r.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.query.get('uploadId')).toBe('upload-1');
    // No bulk delete (POST ?delete), which would need a checksum that other services do not know.
    expect(fake.requests.filter((r) => r.query.has('delete'))).toEqual([]);
    // The watch page is never uploaded after a failure.
    expect(fake.requests.some((r) => r.path.endsWith('/index.html'))).toBe(false);
  });
});
