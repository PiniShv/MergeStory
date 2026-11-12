import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MergeStoryError } from '../../core/errors.ts';
import { type Logger, silentLogger } from '../../core/logger.ts';
import type { ProgressEvent } from '../../core/types.ts';
import {
  ACCESS_KEY,
  folderOf,
  type PublishInput,
  SECRET_KEY,
  tokenOf,
  useMockedS3,
  useS3Tests,
} from '../../testing/s3.ts';
import type { AccessProbe } from '../access-probe.ts';
import { addressMistake } from './protected-links.ts';
import { S3Publisher } from './publisher.ts';

const { setup, makeBundle } = useS3Tests();
const { s3Mock, puts, pageBody } = useMockedS3();

describe('addressMistake', () => {
  it('knows an address that cannot be put behind Cloudflare Access, with or without a port, in any case', () => {
    for (const host of ['pub-0123abcd.r2.dev', 'PUB-0123ABCD.R2.DEV:8443', 'a.b.r2.dev']) {
      expect(addressMistake(host, null), host).toBe('r2-dev');
    }
    expect(addressMistake('r2.dev.example.com', null)).toBeNull();
    expect(addressMistake('videos.example.com', null)).toBeNull();
  });

  it('knows the storage API address itself, but not another port on the same machine', () => {
    const endpoint = 'https://ABC.r2.cloudflarestorage.com/some/path';
    expect(addressMistake('abc.r2.cloudflarestorage.com', endpoint)).toBe('storage-api');
    expect(addressMistake('http://x', 'http://127.0.0.1:9000')).toBeNull();
    expect(addressMistake('127.0.0.1:8080', 'http://127.0.0.1:9000')).toBeNull();
    expect(addressMistake('127.0.0.1:9000', 'http://127.0.0.1:9000')).toBe('storage-api');
    expect(addressMistake('abc.r2.cloudflarestorage.com', 'not an address')).toBeNull();
    expect(addressMistake('abc.r2.cloudflarestorage.com', null)).toBeNull();
  });
});

describe('S3Publisher with protected links', () => {
  let access: Server;
  let origin: string;
  let probed: { url: string; headers: IncomingHttpHeaders }[];
  let answer: (req: IncomingMessage, res: ServerResponse) => void;

  /** What Cloudflare Access answers to an anonymous request. */
  const signIn = (_req: IncomingMessage, res: ServerResponse): void => {
    res
      .writeHead(302, {
        location:
          'https://acme.cloudflareaccess.com/cdn-cgi/access/login/videos.example.com?kid=4f2a&redirect_url=%2Fx',
        server: 'cloudflare',
      })
      .end();
  };

  beforeAll(async () => {
    access = createServer((req, res) => {
      probed.push({ url: req.url ?? '', headers: req.headers });
      answer(req, res);
    });
    await new Promise<void>((resolve) => access.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(access.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    access.closeAllConnections();
    await new Promise<void>((resolve) => access.close(() => resolve()));
  });

  beforeEach(() => {
    probed = [];
    answer = signIn;
  });

  const options = (s3: NonNullable<PublishInput['s3']> = {}) =>
    ({ publish: { visibility: 'protected' }, s3: { publicBaseUrl: `${origin}/media/`, ...s3 } }) as const;

  it('checks the address first, then uploads like a public link', async () => {
    const { bundle, seen } = await makeBundle({ repoIsPrivate: true });
    const { ctx, publisher } = setup(options());
    const result = await publisher.publish(bundle, ctx);
    const keyPrefix = folderOf(result);

    const base = `${origin}/media/${keyPrefix}`;
    expect(result).toEqual({
      provider: 's3',
      watchUrl: `${base}index.html`,
      videoUrl: `${base}video.mp4`,
      posterUrl: `${base}poster.jpg`,
      captionsUrl: `${base}captions.vtt`,
      expiresAt: null,
      visibility: 'protected',
      location: `s3://media/${keyPrefix}`,
    });
    expect(seen.urls?.linkExpiresAt).toBeNull();
    // One anonymous request for a file that does not exist, in the folder of the videos.
    expect(probed).toHaveLength(1);
    expect(probed[0]?.url.startsWith(`/media/${keyPrefix}mergestory-check-`)).toBe(true);
    expect(probed[0]?.headers.cookie).toBeUndefined();
    expect(probed[0]?.headers.authorization).toBeUndefined();
    expect(puts()).toHaveLength(4);
  });

  it('keeps shared caches from storing the files', async () => {
    const { bundle } = await makeBundle();
    const { ctx, publisher } = setup(options());
    await publisher.publish(bundle, ctx);
    expect(puts().map((i) => [i.Key?.split('/').pop(), i.CacheControl])).toEqual([
      ['video.mp4', 'private, max-age=31536000, immutable'],
      ['captions.vtt', 'private, max-age=31536000, immutable'],
      ['poster.jpg', 'private, max-age=31536000, immutable'],
      ['index.html', 'private, no-cache'],
    ]);
  });

  it('builds the watch page with permanent links and no expiry', async () => {
    const { bundle } = await makeBundle();
    const { ctx, publisher } = setup(options());
    const keyPrefix = folderOf(await publisher.publish(bundle, ctx));
    const html = pageBody();
    expect(html).toContain(`${origin}/media/${keyPrefix}video.mp4`);
    expect(html).toContain(`media-src ${origin}`);
    expect(html).not.toContain('X-Amz');
    expect(html).not.toContain('This link expires');
  });

  it('does not block protected links for a private repository, or when that is not known', async () => {
    for (const repoIsPrivate of [true, false, null]) {
      const { bundle } = await makeBundle({ repoIsPrivate });
      const { ctx, publisher } = setup(options());
      await expect(publisher.publish(bundle, ctx)).resolves.toMatchObject({ visibility: 'protected' });
    }
  });

  it('reports the check as an outbound request without any content, and the upload after it', async () => {
    const { bundle, bytes } = await makeBundle();
    const events: ProgressEvent[] = [];
    const { ctx, publisher } = setup({ ...options(), onProgress: (e) => events.push(e) });
    await publisher.publish(bundle, ctx);

    const total = bytes + Buffer.byteLength(pageBody());
    expect(ctx.egress.list()).toEqual([
      { destination: new URL(origin).hostname, purpose: 'protection check', bytes: 0, contains: [] },
      {
        destination: 'media.s3.us-east-1.amazonaws.com',
        purpose: 'video upload',
        bytes: total,
        contains: ['video'],
      },
    ]);
    expect(events[0]?.message).toBe('Checked that the link address needs a sign-in');
    expect(events.slice(1).map((e) => e.message)).toEqual([
      'Uploaded video.mp4',
      'Uploaded captions.vtt',
      'Uploaded poster.jpg',
      'Uploaded index.html',
    ]);
  });

  describe('when the address is not behind a sign-in', () => {
    it('uploads nothing and explains what was seen and how to fix it', async () => {
      answer = (_req, res) => {
        res.writeHead(404, { server: 'cloudflare' }).end('<Error><Code>NoSuchKey</Code></Error>');
      };
      const { bundle } = await makeBundle();
      const { ctx, publisher } = setup(options());
      const error = await publisher.publish(bundle, ctx).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(MergeStoryError);
      expect(error).toMatchObject({
        code: 'PRIVACY_BLOCKED',
        message: `Protected links are blocked: ${new URL(origin).host} is not behind a sign-in.`,
        details: { verdict: 'not-protected', reason: 'not-found', status: 404 },
      });
      const hint = (error as MergeStoryError).hint ?? '';
      expect(hint).toContain('answered HTTP 404');
      expect(hint).toContain('Cloudflare Access');
      expect(hint).toContain('MergeStory/blob/main/docs/hosting.md');
      expect(hint).toContain('--visibility private');
      expect(hint).toContain('publish.s3.verifyProtection');
      expect(hint).toContain('MERGESTORY_S3_VERIFY_PROTECTION=false');
      expect(hint).toContain('VPN');
      // No request reached the storage service, and nothing was recorded as uploaded or paid for.
      expect(s3Mock.calls()).toHaveLength(0);
      expect(ctx.cost.report().records).toEqual([]);
      expect(ctx.egress.list().map((r) => r.purpose)).toEqual(['protection check']);
    });

    it('blocks an address that answers 200', async () => {
      answer = (_req, res) => {
        res.writeHead(200).end('hello');
      };
      const { bundle } = await makeBundle();
      const { ctx, publisher } = setup(options());
      await expect(publisher.publish(bundle, ctx)).rejects.toMatchObject({ code: 'PRIVACY_BLOCKED' });
      expect(s3Mock.calls()).toHaveLength(0);
    });

    it.each([
      [
        'CloudFront answers 403 for a missing file',
        (_req: IncomingMessage, res: ServerResponse) => {
          res
            .writeHead(403, { server: 'CloudFront', 'x-cache': 'Error from cloudfront' })
            .end('AccessDenied');
        },
        /CloudFront also answers 403/,
      ],
      [
        'the server fails',
        (_req: IncomingMessage, res: ServerResponse) => {
          res.writeHead(503).end('busy');
        },
        /HTTP 503/,
      ],
      [
        'a bare 401',
        (_req: IncomingMessage, res: ServerResponse) => {
          res.writeHead(401).end('not authorized');
        },
        /HTTP 401 without a sign-in/,
      ],
      [
        'a redirect to somewhere else',
        (_req: IncomingMessage, res: ServerResponse) => {
          res.writeHead(301, { location: 'https://www.example.org/' }).end();
        },
        /www\.example\.org/,
      ],
    ])('blocks it when the answer proves nothing: %s', async (_name, reply, seen) => {
      answer = reply;
      const { bundle } = await makeBundle();
      const { ctx, publisher } = setup(options());
      const error = (await publisher.publish(bundle, ctx).catch((e: unknown) => e)) as MergeStoryError;
      expect(error.code).toBe('PRIVACY_BLOCKED');
      expect(error.message).toContain('could not confirm');
      expect(error.hint).toMatch(seen);
      expect(error.hint).toContain('MERGESTORY_S3_VERIFY_PROTECTION=false');
      expect(error.details).toMatchObject({ verdict: 'unknown' });
      expect(s3Mock.calls()).toHaveLength(0);
    });

    it('blocks an address that cannot be reached', async () => {
      const closed = createServer();
      await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
      const port = (closed.address() as AddressInfo).port;
      await new Promise<void>((resolve) => closed.close(() => resolve()));
      const { bundle } = await makeBundle();
      const { ctx, publisher } = setup(options({ publicBaseUrl: `http://127.0.0.1:${port}` }));
      const error = (await publisher.publish(bundle, ctx).catch((e: unknown) => e)) as MergeStoryError;
      expect(error).toMatchObject({ code: 'PRIVACY_BLOCKED', details: { reason: 'unreachable' } });
      expect(error.hint).toContain('could not be reached');
      expect(s3Mock.calls()).toHaveLength(0);
    });

    it('does not put a secret, a signed address or the key prefix into the error', async () => {
      answer = (_req, res) => {
        res.writeHead(200).end(`token=${SECRET_KEY}`);
      };
      const { bundle } = await makeBundle();
      const { ctx, publisher } = setup(options());
      const error = (await publisher.publish(bundle, ctx).catch((e: unknown) => e)) as MergeStoryError;
      // The check asked for a file in the folder of the videos: that is where the random token is.
      const token = /^\/media\/[^/]+\/v\/([0-9a-f]{32})\//.exec(probed[0]?.url ?? '')?.[1] ?? '';
      expect(token).not.toBe('');
      const shown = JSON.stringify(error.toJSON());
      expect(shown).not.toContain(SECRET_KEY);
      expect(shown).not.toContain(ACCESS_KEY);
      expect(shown).not.toContain(token);
      expect(shown).not.toContain('mergestory-check');
    });

    it('tells people with an r2.dev address to connect a custom domain', async () => {
      const probeAccess: AccessProbe = async () => ({
        verdict: 'not-protected',
        reason: 'open',
        detail: 'answered HTTP 200 without a sign-in: the address is open to anyone',
        status: 200,
        host: 'pub-0123abcd.r2.dev',
      });
      const { bundle } = await makeBundle();
      const { ctx, config } = setup(options({ publicBaseUrl: 'https://pub-0123abcd.r2.dev' }));
      const error = (await new S3Publisher(config, { probeAccess })
        .publish(bundle, ctx)
        .catch((e: unknown) => e)) as MergeStoryError;
      expect(error.hint).toContain('r2.dev cannot be put behind Cloudflare Access');
      expect(error.hint).toContain('custom domain');
    });

    it('tells people who used the storage address that no access proxy sits in front of it', async () => {
      const probeAccess: AccessProbe = async () => ({
        verdict: 'unknown',
        reason: 'denied',
        detail: 'answered HTTP 403 without a sign-in page or challenge',
        status: 403,
        host: 'acct123.r2.cloudflarestorage.com',
      });
      const { bundle } = await makeBundle();
      const { ctx, config } = setup(
        options({
          publicBaseUrl: 'https://acct123.r2.cloudflarestorage.com/media',
          endpoint: 'https://acct123.r2.cloudflarestorage.com',
        }),
      );
      const error = (await new S3Publisher(config, { probeAccess })
        .publish(bundle, ctx)
        .catch((e: unknown) => e)) as MergeStoryError;
      expect(error.hint).toContain('storage API address');
      expect(error.hint).toContain('custom domain');
    });

    it('does not call a proxy on the same machine the storage address, when only the port differs', async () => {
      const probeAccess: AccessProbe = async () => ({
        verdict: 'not-protected',
        reason: 'not-found',
        detail: 'answered HTTP 404 for a file that does not exist and did not ask for a sign-in',
        status: 404,
        host: '127.0.0.1:8080',
      });
      const { bundle } = await makeBundle();
      const { ctx, config } = setup(
        options({ publicBaseUrl: 'http://127.0.0.1:8080/media', endpoint: 'http://127.0.0.1:9000' }),
      );
      const error = (await new S3Publisher(config, { probeAccess })
        .publish(bundle, ctx)
        .catch((e: unknown) => e)) as MergeStoryError;
      expect(error.code).toBe('PRIVACY_BLOCKED');
      expect(error.hint).not.toContain('storage API address');
    });
  });

  describe('settings', () => {
    it('skips the check when verifyProtection is off', async () => {
      answer = (_req, res) => {
        res.writeHead(200).end('open');
      };
      const { bundle } = await makeBundle();
      const { ctx, publisher } = setup(options({ verifyProtection: false }));
      await expect(publisher.publish(bundle, ctx)).resolves.toMatchObject({ visibility: 'protected' });
      expect(probed).toHaveLength(0);
      expect(ctx.egress.list().map((r) => r.purpose)).toEqual(['video upload']);
    });

    it('needs a public base URL, and says which one', async () => {
      const { bundle } = await makeBundle();
      const { ctx, publisher } = setup({ publish: { visibility: 'protected' } });
      const error = (await publisher.publish(bundle, ctx).catch((e: unknown) => e)) as MergeStoryError;
      expect(error.code).toBe('CONFIG_INVALID');
      expect(error.message).toBe('Protected links need a public base URL.');
      expect(error.hint).toContain('MERGESTORY_S3_PUBLIC_BASE_URL');
      expect(error.hint).toContain('publish.s3.publicBaseUrl');
      expect(error.hint).toContain('MergeStory/blob/main/docs/hosting.md');
      expect(s3Mock.calls()).toHaveLength(0);
      expect(probed).toHaveLength(0);
    });

    it('only accepts an http(s) base URL', async () => {
      const { bundle } = await makeBundle();
      const { ctx, publisher } = setup(options({ publicBaseUrl: 'ftp://videos.example.com' }));
      await expect(publisher.publish(bundle, ctx)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
      expect(probed).toHaveLength(0);
    });

    it('does not check anything for private or public links', async () => {
      const privateBundle = await makeBundle();
      const first = setup({ s3: { publicBaseUrl: `${origin}/media` } });
      await first.publisher.publish(privateBundle.bundle, first.ctx);
      const publicBundle = await makeBundle({ repoIsPrivate: false });
      const second = setup({ publish: { visibility: 'public' }, s3: { publicBaseUrl: `${origin}/media` } });
      await second.publisher.publish(publicBundle.bundle, second.ctx);
      expect(probed).toHaveLength(0);
    });
  });

  describe('what is passed to the check', () => {
    const protectedResult = {
      verdict: 'protected' as const,
      reason: 'cloudflare-access',
      detail: 'redirected to the Cloudflare Access sign-in page',
      status: 302,
      host: 'videos.example.com',
    };

    it('asks about the folder of the videos and passes the cancel signal on', async () => {
      const calls: Parameters<AccessProbe>[] = [];
      const probeAccess: AccessProbe = async (...args) => {
        calls.push(args);
        return protectedResult;
      };
      const controller = new AbortController();
      const { bundle } = await makeBundle();
      const { ctx, config } = setup({
        ...options({ publicBaseUrl: 'https://videos.example.com/team/?x=1#y' }),
        signal: controller.signal,
      });
      const keyPrefix = folderOf(await new S3Publisher(config, { probeAccess }).publish(bundle, ctx));
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0]).toBe('https://videos.example.com/team');
      expect(calls[0]?.[1]?.pathPrefix).toBe(keyPrefix);
      expect(calls[0]?.[1]?.signal).toBe(ctx.signal);
    });

    it('stops when the run is cancelled during the check', async () => {
      answer = () => {
        // Never answers.
      };
      const controller = new AbortController();
      const { bundle } = await makeBundle();
      const { ctx, publisher } = setup({ ...options(), signal: controller.signal });
      const pending = publisher.publish(bundle, ctx);
      setTimeout(() => controller.abort(), 100);
      await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
      expect(s3Mock.calls()).toHaveLength(0);
    });

    it('warns about an http address, and not about one on this machine', async () => {
      const warnings: string[] = [];
      const logger: Logger = { ...silentLogger, warn: (message: string) => void warnings.push(message) };
      const probeAccess: AccessProbe = async () => protectedResult;
      const { bundle } = await makeBundle();

      const remote = setup({ ...options({ publicBaseUrl: 'http://videos.example.com' }), logger });
      await new S3Publisher(remote.config, { probeAccess }).publish(bundle, remote.ctx);
      expect(warnings).toEqual([
        'The public base URL uses http, so the sign-in and the video are not encrypted',
      ]);

      warnings.length = 0;
      const local = setup({ ...options(), logger });
      await new S3Publisher(local.config, { probeAccess }).publish(bundle, local.ctx);
      expect(warnings).toEqual([]);
    });

    it('treats every name of this machine as local, and a public name that starts like one as remote', async () => {
      const warnings: string[] = [];
      const logger: Logger = { ...silentLogger, warn: (message: string) => void warnings.push(message) };
      const probeAccess: AccessProbe = async () => protectedResult;
      const { bundle } = await makeBundle();
      const warned = async (publicBaseUrl: string): Promise<number> => {
        warnings.length = 0;
        const run = setup({ ...options({ publicBaseUrl }), logger });
        await new S3Publisher(run.config, { probeAccess }).publish(bundle, run.ctx);
        return warnings.length;
      };
      for (const url of [
        'http://localhost:8080',
        'http://127.0.0.1:8080',
        'http://[::1]:8080',
        'http://media.localhost:8080',
      ]) {
        expect(await warned(url), url).toBe(0);
      }
      for (const url of ['http://127.0.0.1.example.com', 'http://127.evil.example.com']) {
        expect(await warned(url), url).toBe(1);
      }
    });

    it('keeps addresses and keys out of the log', async () => {
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
      const { ctx, publisher } = setup({ ...options(), logger: spy });
      const result = await publisher.publish(bundle, ctx);
      const log = lines.join('\n');
      expect(log).toContain('Checked the link address');
      for (const secret of ['127.0.0.1', 'http://', 'https://', ACCESS_KEY, SECRET_KEY, tokenOf(result)]) {
        expect(log).not.toContain(secret);
      }
    });
  });
});
