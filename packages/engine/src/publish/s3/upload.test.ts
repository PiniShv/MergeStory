import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import type { Logger } from '../../core/logger.ts';
import type { ProgressEvent } from '../../core/types.ts';
import { ACCESS_KEY, folderOf, MIB, SECRET_KEY, tokenOf, useMockedS3, useS3Tests } from '../../testing/s3.ts';

const { setup, makeBundle } = useS3Tests();
const { s3Mock, puts, pageBody } = useMockedS3();

describe('S3Publisher uploads', () => {
  it('uploads the video first and the watch page last, with content types and cache headers', async () => {
    const { bundle } = await makeBundle();
    // Whatever the order of the bundle, the video goes first, then the captions and the poster.
    bundle.files.reverse();
    const { ctx, publisher } = setup();
    const result = await publisher.publish(bundle, ctx);

    const inputs = puts();
    expect(inputs.map((i) => i.Key)).toEqual(
      ['video.mp4', 'captions.vtt', 'poster.jpg', 'index.html'].map((n) => `${folderOf(result)}${n}`),
    );
    expect(inputs.map((i) => i.ContentType)).toEqual([
      'video/mp4',
      'text/vtt; charset=utf-8',
      'image/jpeg',
      'text/html; charset=utf-8',
    ]);
    expect(inputs.map((i) => i.CacheControl)).toEqual([
      'private, max-age=31536000, immutable',
      'private, max-age=31536000, immutable',
      'private, max-age=31536000, immutable',
      'private, no-cache',
    ]);
    for (const input of inputs) {
      expect(input.Bucket).toBe('media');
      expect(input.ContentDisposition).toBe('inline');
      // Buckets that enforce object ownership reject ACLs.
      expect(input).not.toHaveProperty('ACL');
    }
  });

  it('works without a poster and captions', async () => {
    const { bundle } = await makeBundle();
    bundle.files = bundle.files.filter((f) => f.name === 'video.mp4');
    const { ctx, publisher } = setup();
    const result = await publisher.publish(bundle, ctx);
    expect(result.posterUrl).toBeNull();
    expect(result.captionsUrl).toBeNull();
    expect(puts().map((i) => i.Key?.split('/').pop())).toEqual(['video.mp4', 'index.html']);
  });

  it('records where the files went, what they hold and how big they were', async () => {
    const { bundle, bytes } = await makeBundle({ contains: ['video', 'narration-text'] });
    const { ctx, publisher } = setup();
    await publisher.publish(bundle, ctx);

    const total = bytes + Buffer.byteLength(pageBody());
    expect(ctx.egress.list()).toEqual([
      {
        destination: 'media.s3.us-east-1.amazonaws.com',
        purpose: 'video upload',
        bytes: total,
        contains: ['video', 'narration-text'],
      },
    ]);
    expect(ctx.cost.report().records).toEqual([
      { provider: 's3', kind: 'storage', model: null, bytes: total, costUsd: 0, estimated: true },
    ]);
    expect(ctx.cost.totalUsd).toBe(0);
  });

  it('reports progress without any address in the messages', async () => {
    const events: ProgressEvent[] = [];
    const { bundle } = await makeBundle();
    const { ctx, publisher } = setup({ onProgress: (e) => events.push(e) });
    await publisher.publish(bundle, ctx);
    expect(events.map((e) => e.message)).toEqual([
      'Uploaded video.mp4',
      'Uploaded captions.vtt',
      'Uploaded poster.jpg',
      'Uploaded index.html',
    ]);
    expect(events.every((e) => e.stage === 'publish' && e.status === 'progress')).toBe(true);
    expect(events.at(-1)?.progress).toBe(1);
  });

  it('keeps addresses, keys and secrets out of the log', async () => {
    const lines: string[] = [];
    const spy: Logger = {
      level: 'debug',
      debug: (m, f) => lines.push(JSON.stringify([m, f])),
      info: (m, f) => lines.push(JSON.stringify([m, f])),
      warn: (m, f) => lines.push(JSON.stringify([m, f])),
      error: (m, f) => lines.push(JSON.stringify([m, f])),
      child: () => spy,
    };
    const { bundle } = await makeBundle();
    const { ctx, publisher } = setup({ logger: spy });
    const result = await publisher.publish(bundle, ctx);

    const log = lines.join('\n');
    expect(lines.length).toBeGreaterThan(0);
    for (const secret of ['X-Amz', 'https://', ACCESS_KEY, SECRET_KEY, tokenOf(result)]) {
      expect(log).not.toContain(secret);
    }
  });

  it('uses one fixed part size and a multipart upload for a big video', async () => {
    const { bundle } = await makeBundle({ videoBytes: 9 * MIB });
    s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: 'upload-1' });
    s3Mock.on(UploadPartCommand).resolves({ ETag: '"part"' });
    s3Mock.on(CompleteMultipartUploadCommand).resolves({});
    const { ctx, publisher } = setup();
    const keyPrefix = folderOf(await publisher.publish(bundle, ctx));

    const created = s3Mock.commandCalls(CreateMultipartUploadCommand);
    expect(created).toHaveLength(1);
    expect(created[0]?.args[0].input).toMatchObject({
      Bucket: 'media',
      Key: `${keyPrefix}video.mp4`,
      ContentType: 'video/mp4',
      CacheControl: 'private, max-age=31536000, immutable',
      ContentDisposition: 'inline',
    });
    const parts = s3Mock
      .commandCalls(UploadPartCommand)
      .map((call) => ({
        part: call.args[0].input.PartNumber,
        bytes: (call.args[0].input.Body as Uint8Array).byteLength,
      }))
      .sort((a, b) => (a.part ?? 0) - (b.part ?? 0));
    expect(parts).toEqual([
      { part: 1, bytes: 8 * MIB },
      { part: 2, bytes: 1 * MIB },
    ]);
    expect(s3Mock.commandCalls(CompleteMultipartUploadCommand)).toHaveLength(1);
    expect(puts().map((i) => i.Key?.split('/').pop())).toEqual(['captions.vtt', 'poster.jpg', 'index.html']);
  });
});
