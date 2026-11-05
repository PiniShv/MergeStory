/**
 * Helpers for the S3 tests: the settings and secrets of an upload, a publisher with its run context
 * and a bundle on disk, a mocked S3 client, and a fake S3 server on the loopback interface. Not part
 * of the build.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PutObjectCommand, type PutObjectCommandInput, S3Client } from '@aws-sdk/client-s3';
import { type AwsClientStub, mockClient } from 'aws-sdk-client-mock';
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { noCache } from '../core/cache.ts';
import { type Config, type ConfigInput, resolveConfig, type SecretName, Secrets } from '../core/config.ts';
import { createRunContext, type RunContext } from '../core/context.ts';
import { type Logger, silentLogger } from '../core/logger.ts';
import { Redactor } from '../core/redact.ts';
import type { EgressContent, ProgressEvent, PublishResult } from '../core/types.ts';
import { S3Publisher } from '../publish/s3/publisher.ts';
import { type TestBundle, writeBundle } from './publish.ts';

export const ACCESS_KEY = 'test-access-key-id';
export const SECRET_KEY = 'test-secret-access-key-value-0123456789';
export const SECRETS: Partial<Record<SecretName, string>> = {
  MERGESTORY_S3_ACCESS_KEY_ID: ACCESS_KEY,
  MERGESTORY_S3_SECRET_ACCESS_KEY: SECRET_KEY,
};
export const MIB = 1024 * 1024;

export type PublishInput = NonNullable<ConfigInput['publish']>;

export interface SetupOptions {
  publish?: PublishInput;
  s3?: NonNullable<PublishInput['s3']>;
  secrets?: Partial<Record<SecretName, string>>;
  dryRun?: boolean;
  signal?: AbortSignal;
  logger?: Logger;
  onProgress?: (event: ProgressEvent) => void;
}

export interface BundleOptions {
  repoIsPrivate?: boolean | null;
  /** The size of the video in bytes. */
  videoBytes?: number;
  contains?: EgressContent[];
}

interface S3Setup {
  ctx: RunContext;
  config: Config;
  publisher: S3Publisher;
}

/** The folder in the bucket that a result went into: "<prefix>/v/<random token>/". */
export const folderOf = (result: PublishResult): string => result.location.replace(/^s3:\/\/[^/]+\//, '');
/** The random part of that folder, which keeps a link from being guessed. */
export const tokenOf = (result: PublishResult): string => folderOf(result).split('/')[2] ?? 'missing';

/** Settings for the bucket "media" in us-east-1 with signed links that last an hour, and a publisher for them. */
function createSetup(root: string, options: SetupOptions): S3Setup {
  const config = resolveConfig({
    skipFile: true,
    env: {},
    overrides: {
      publish: {
        provider: 's3',
        linkExpirySec: 3600,
        ...options.publish,
        s3: { bucket: 'media', region: 'us-east-1', ...options.s3 },
      },
    },
  });
  const ctx = createRunContext({
    config,
    runId: 'run-1',
    runDir: join(root, 'run'),
    logger: options.logger ?? silentLogger,
    cache: noCache,
    secrets: new Secrets(options.secrets ?? SECRETS, new Redactor()),
    dryRun: options.dryRun,
    signal: options.signal,
    onProgress: options.onProgress,
  });
  return { ctx, config, publisher: new S3Publisher(config) };
}

/** Make the AWS credential chain and region lookup find nothing on this machine. */
function emptyAwsEnvironment(root: string): void {
  for (const name of [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_PROFILE',
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
    'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'AWS_ROLE_ARN',
  ]) {
    vi.stubEnv(name, '');
  }
  vi.stubEnv('AWS_EC2_METADATA_DISABLED', 'true');
  vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', join(root, 'no-credentials'));
  vi.stubEnv('AWS_CONFIG_FILE', join(root, 'no-config'));
}

interface S3Tests {
  /** The temporary folder of the running test. */
  root(): string;
  /** Settings, a run context and a publisher for an upload. */
  setup(options?: SetupOptions): S3Setup;
  /** A video, a poster and captions in a folder of the test, as a bundle. */
  makeBundle(options?: BundleOptions): Promise<TestBundle>;
  /** Make the AWS credential chain and region lookup find nothing on this machine. */
  emptyAwsEnvironment(): void;
}

/** Hooks for a test file: a temporary folder for each test, and the clock and environment put back after it. */
export function useS3Tests(): S3Tests {
  let root = '';
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mergestory-s3-'));
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root: () => root,
    setup: (options = {}) => createSetup(root, options),
    makeBundle: ({ videoBytes, ...rest } = {}) =>
      writeBundle({
        dir: join(root, 'render'),
        ...(videoBytes === undefined ? {} : { video: videoBytes }),
        ...rest,
      }),
    emptyAwsEnvironment: () => emptyAwsEnvironment(root),
  };
}

interface MockedS3 {
  /** The mock of the S3 client: every PutObject works unless a test says otherwise. */
  s3Mock: AwsClientStub<S3Client>;
  /** The input of every PutObject so far, in order. */
  puts(): PutObjectCommandInput[];
  /** The text of the watch page that was uploaded. */
  pageBody(): string;
}

/** Replace the S3 client of the file's tests by a mock, so that nothing is sent. */
export function useMockedS3(): MockedS3 {
  const s3Mock = mockClient(S3Client);
  beforeEach(() => {
    s3Mock.reset();
    s3Mock.on(PutObjectCommand).resolves({ ETag: '"etag"' });
  });
  afterAll(() => {
    s3Mock.restore();
  });
  const puts = () => s3Mock.commandCalls(PutObjectCommand).map((call) => call.args[0].input);
  const pageBody = () => {
    const page = puts().find((input) => input.Key?.endsWith('/index.html'));
    return Buffer.from(page?.Body as Buffer).toString('utf8');
  };
  return { s3Mock, puts, pageBody };
}

/** The real setTimeout, kept from before a test fakes it, for pauses in real time. */
const realSetTimeout = globalThis.setTimeout;

/**
 * Drive fake timers until the promise settles. Real file and module work needs real time, so the
 * fake clock moves one second at a time, after a short real pause. Fake time then never runs far
 * ahead of the real work (a stall timer would fire too early), and a slow machine only makes the
 * test take longer.
 */
export async function withClock<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  const tracked = promise.finally(() => {
    settled = true;
  });
  tracked.catch(() => undefined);
  // Date is not faked, so this limit is real time.
  const deadline = Date.now() + 60_000;
  while (!settled) {
    if (Date.now() > deadline) throw new Error('the promise did not settle while the clock ran');
    await new Promise<void>((resolve) => realSetTimeout(resolve, 2));
    await vi.advanceTimersByTimeAsync(1_000);
  }
  return tracked;
}

export interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** What the fake server does when something specific is asked of it. */
interface FakeS3Behaviour {
  /** Status for HeadBucket. */
  bucketStatus: number;
  /** Status for UploadPart requests with this part number (default: 200). */
  failPart: { part: number; status: number } | null;
}

function xml(res: ServerResponse, body: string): void {
  res
    .writeHead(200, { 'content-type': 'application/xml' })
    .end(`<?xml version="1.0" encoding="UTF-8"?>${body}`);
}

/**
 * A fake S3 server on the loopback interface. Nothing is mocked inside the AWS SDK, so a test sees what
 * really goes over the wire: headers, multipart requests and the answers MergeStory has to cope with.
 */
class FakeS3 {
  requests: Recorded[] = [];
  behaviour: FakeS3Behaviour = { bucketStatus: 200, failPart: null };
  endpoint = '';
  private uploads = 0;
  private readonly server: Server;

  constructor() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://fake.local');
        const method = req.method ?? '';
        this.requests.push({
          method,
          path: decodeURIComponent(url.pathname),
          query: url.searchParams,
          headers: req.headers,
          body: Buffer.concat(chunks),
        });
        this.answer(method, url.searchParams, res);
      });
    });
  }

  private answer(method: string, q: URLSearchParams, res: ServerResponse): void {
    const { behaviour } = this;
    if (method === 'HEAD') {
      res.writeHead(behaviour.bucketStatus).end();
    } else if (method === 'POST' && q.has('uploads')) {
      this.uploads += 1;
      xml(
        res,
        `<InitiateMultipartUploadResult><Bucket>media</Bucket><Key>k</Key><UploadId>upload-${this.uploads}</UploadId></InitiateMultipartUploadResult>`,
      );
    } else if (method === 'PUT' && q.has('partNumber')) {
      const part = Number(q.get('partNumber'));
      if (behaviour.failPart?.part === part) {
        res
          .writeHead(behaviour.failPart.status, { 'content-type': 'application/xml' })
          .end('<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>no</Message></Error>');
        return;
      }
      res.writeHead(200, { etag: `"etag-${part}"` }).end();
    } else if (method === 'POST' && q.has('uploadId')) {
      xml(
        res,
        '<CompleteMultipartUploadResult><Location>http://fake.local/media/k</Location><Bucket>media</Bucket><Key>k</Key><ETag>"final-2"</ETag></CompleteMultipartUploadResult>',
      );
    } else if (method === 'DELETE' && q.has('uploadId')) {
      res.writeHead(204).end();
    } else if (method === 'PUT') {
      res.writeHead(200, { etag: '"single"' }).end();
    } else {
      res.writeHead(200).end();
    }
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.endpoint = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Forget what was recorded, and answer normally again. */
  reset(): void {
    this.requests = [];
    this.uploads = 0;
    this.behaviour = { bucketStatus: 200, failPart: null };
  }
}

/** A fake S3 server for the file's tests, with a clean record for each of them. */
export function useFakeS3(): FakeS3 {
  const fake = new FakeS3();
  beforeAll(() => fake.start());
  afterAll(() => fake.stop());
  beforeEach(() => fake.reset());
  return fake;
}

/** Names of the headers that the S3 default checksums add. */
export function checksumHeaders(headers: IncomingHttpHeaders): string[] {
  return Object.keys(headers).filter(
    (name) =>
      name.startsWith('x-amz-checksum') ||
      name === 'x-amz-sdk-checksum-algorithm' ||
      name === 'x-amz-trailer' ||
      name === 'x-amz-decoded-content-length',
  );
}
