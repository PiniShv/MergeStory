import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { MergeStoryError } from '../../core/errors.ts';
import { SECRET_KEY, useMockedS3, useS3Tests, withClock } from '../../testing/s3.ts';

const { setup, makeBundle } = useS3Tests();
const { s3Mock } = useMockedS3();

describe('S3Publisher failures', () => {
  function storageError(name: string, status: number, message = name): Error {
    return Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status } });
  }

  it('explains a denied upload and does not try again', async () => {
    s3Mock.reset();
    s3Mock.on(PutObjectCommand).rejects(storageError('AccessDenied', 403));
    const { bundle } = await makeBundle();
    const { ctx, publisher } = setup();
    const error = await publisher.publish(bundle, ctx).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MergeStoryError);
    expect(error).toMatchObject({
      code: 'PUBLISH_FAILED',
      message: 'Uploading video.mp4 failed: access to the bucket was denied.',
      hint: expect.stringContaining('s3:PutObject'),
      retryable: false,
      details: { error: 'AccessDenied', status: 403 },
    });
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
    expect(ctx.egress.list()).toEqual([]);
  });

  it('removes the files that were already uploaded when a later upload fails', async () => {
    s3Mock.reset();
    s3Mock.on(PutObjectCommand).resolvesOnce({ ETag: '"etag"' }).rejects(storageError('AccessDenied', 403));
    s3Mock.on(DeleteObjectCommand).resolves({});
    const { bundle } = await makeBundle();
    const { ctx, publisher } = setup();
    const error = await publisher.publish(bundle, ctx).catch((e: unknown) => e);

    expect(error).toMatchObject({
      message: 'Uploading captions.vtt failed: access to the bucket was denied.',
    });
    expect((error as MergeStoryError).hint).not.toContain('could not be removed');
    const deleted = s3Mock
      .commandCalls(DeleteObjectCommand)
      .map((call) => call.args[0].input.Key?.split('/').pop());
    expect(deleted.sort()).toEqual(['captions.vtt', 'video.mp4']);
  });

  it('names the folder to check when the uploaded files cannot be removed', async () => {
    s3Mock.reset();
    s3Mock.on(PutObjectCommand).resolvesOnce({ ETag: '"etag"' }).rejects(storageError('AccessDenied', 403));
    s3Mock.on(DeleteObjectCommand).rejects(storageError('AccessDenied', 403));
    const { bundle } = await makeBundle();
    const { ctx, publisher } = setup();
    const error = (await publisher.publish(bundle, ctx).catch((e: unknown) => e)) as MergeStoryError;

    expect(error.message).toBe('Uploading captions.vtt failed: access to the bucket was denied.');
    expect(error.hint).toContain('s3:PutObject');
    expect(error.hint).toContain('could not be removed');
    expect(error.hint).toMatch(/media\/mergestory\/v\/[0-9a-f]+\//);
    expect(error.details).toMatchObject({ error: 'AccessDenied', status: 403 });
  });

  it.each([
    ['NoSuchBucket', 404, 'bucket was not found'],
    ['InvalidAccessKeyId', 403, 'rejected the credentials'],
    ['SignatureDoesNotMatch', 403, 'rejected the credentials'],
    ['PermanentRedirect', 301, 'different region'],
    ['EntityTooLarge', 400, 'larger than the bucket allows'],
    ['NotImplemented', 501, 'does not support a request'],
  ])('describes %s', async (name, status, text) => {
    s3Mock.reset();
    s3Mock.on(PutObjectCommand).rejects(storageError(name, status));
    const { bundle } = await makeBundle();
    const { ctx, publisher } = setup();
    await expect(publisher.publish(bundle, ctx)).rejects.toMatchObject({
      code: 'PUBLISH_FAILED',
      message: expect.stringContaining(text),
    });
  });

  it('never repeats what the storage service said, in case it holds a secret', async () => {
    s3Mock.reset();
    s3Mock
      .on(PutObjectCommand)
      .rejects(
        storageError(
          'Strange',
          400,
          `rejected ${SECRET_KEY} for https://media.example.com/x?X-Amz-Signature=abcdef`,
        ),
      );
    const { bundle } = await makeBundle();
    const { ctx, publisher } = setup();
    const error = (await publisher.publish(bundle, ctx).catch((e: unknown) => e)) as MergeStoryError;
    const shown = JSON.stringify(error.toJSON());
    expect(shown).not.toContain(SECRET_KEY);
    expect(shown).not.toContain('X-Amz-Signature');
    expect(error.message).toContain('Strange');
  });

  it('tries again after a temporary error', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    s3Mock.reset();
    s3Mock
      .on(PutObjectCommand)
      .rejectsOnce(storageError('ServiceUnavailable', 503))
      .resolves({ ETag: '"etag"' });
    const { bundle } = await makeBundle();
    const { ctx, publisher } = setup();
    await expect(withClock(publisher.publish(bundle, ctx))).resolves.toMatchObject({ provider: 's3' });
    // The video is sent twice, the other three files once.
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(5);
  });

  it('gives up after three temporary errors in a row', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    s3Mock.reset();
    s3Mock.on(PutObjectCommand).rejects(storageError('SlowDown', 503));
    const { bundle } = await makeBundle();
    const { ctx, publisher } = setup();
    const error = await withClock(publisher.publish(bundle, ctx).catch((e: unknown) => e));
    expect(error).toMatchObject({ code: 'PUBLISH_FAILED', retryable: true });
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(3);
  });

  it('gives up on an upload that stalls', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    s3Mock.reset();
    s3Mock.on(PutObjectCommand).callsFake(() => new Promise(() => {}));
    const { bundle } = await makeBundle();
    const { ctx, publisher } = setup();
    const error = await withClock(publisher.publish(bundle, ctx).catch((e: unknown) => e));
    expect(error).toMatchObject({ code: 'PUBLISH_FAILED', message: expect.stringContaining('stalled') });
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(3);
  });
});
