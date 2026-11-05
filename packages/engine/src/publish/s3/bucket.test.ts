import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { Secrets } from '../../core/config.ts';
import { Redactor } from '../../core/redact.ts';
import { ACCESS_KEY, checksumHeaders, SECRETS, useFakeS3, useS3Tests } from '../../testing/s3.ts';
import { checkBucket } from './bucket.ts';

const fake = useFakeS3();
const { setup: baseSetup, emptyAwsEnvironment } = useS3Tests();
const setup = () => baseSetup({ s3: { endpoint: fake.endpoint, forcePathStyle: true } });

describe('checkBucket (HeadBucket for mergestory doctor --online)', () => {
  const settings = () => setup().config.publish.s3;
  const secrets = new Secrets(SECRETS, new Redactor());

  it('says ok when the bucket answers, and sends a signed HEAD for the bucket only', async () => {
    const result = await checkBucket(settings(), secrets);
    expect(result).toEqual({ kind: 'ok', httpStatus: 200, code: null });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ method: 'HEAD', path: '/media/' });
    expect(fake.requests[0]?.headers.authorization).toMatch(
      new RegExp(`^AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/`),
    );
    expect(checksumHeaders(fake.requests[0]?.headers ?? {})).toEqual([]);
  });

  it.each([
    [403, 'access-denied'],
    [404, 'not-found'],
    [301, 'wrong-region'],
    [400, 'wrong-region'],
    [500, 'other'],
  ] as const)('maps HTTP %i to %s', async (status, kind) => {
    fake.behaviour.bucketStatus = status;
    const result = await checkBucket(settings(), secrets);
    expect(result.kind).toBe(kind);
    expect(result.httpStatus).toBe(status);
  });

  it('says unreachable, with the error code, when nothing listens', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const result = await checkBucket({ ...settings(), endpoint: `http://127.0.0.1:${port}` }, secrets, {
      timeoutMs: 5000,
    });
    expect(result).toMatchObject({ kind: 'unreachable', code: 'ECONNREFUSED' });
  });

  it('says unreachable when the answer takes too long', async () => {
    const silent = createServer(() => {
      // Never answers.
    });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    try {
      const port = (silent.address() as AddressInfo).port;
      const result = await checkBucket({ ...settings(), endpoint: `http://127.0.0.1:${port}` }, secrets, {
        timeoutMs: 200,
      });
      expect(result).toMatchObject({ kind: 'unreachable', code: 'TIMEOUT' });
    } finally {
      silent.closeAllConnections();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });

  it('reports a missing bucket, missing credentials and half a pair as configuration problems', async () => {
    emptyAwsEnvironment();
    const noBucket = await checkBucket({ ...settings(), bucket: null }, secrets);
    expect(noBucket).toMatchObject({
      kind: 'config',
      problem: { message: 'No storage bucket is configured.' },
    });

    const none = await checkBucket(settings(), new Secrets({}, new Redactor()));
    expect(none).toMatchObject({
      kind: 'config',
      problem: { message: 'No storage credentials were found.' },
    });

    const half = await checkBucket(
      settings(),
      new Secrets({ MERGESTORY_S3_ACCESS_KEY_ID: 'only-the-id-0123456789' }, new Redactor()),
    );
    expect(half.kind).toBe('config');
    // Nothing was sent in any of these cases.
    expect(fake.requests).toEqual([]);
  });
});
