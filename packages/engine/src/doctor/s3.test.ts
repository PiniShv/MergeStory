import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { createStyle } from '../cli/style.ts';
import { type Config, type ConfigInput, Secrets } from '../core/config.ts';
import { homeLayout } from '../core/paths.ts';
import { Redactor } from '../core/redact.ts';
import type { AccessProbeResult } from '../publish/access-probe.ts';
import { createPublisher } from '../publish/index.ts';
import type { BucketCheck } from '../publish/s3/index.ts';
import { byId, configWith, doctor, healthyDeps, PROTECTED_PROBE } from '../testing/doctor.ts';
import { defaultDoctorDeps } from './deps.ts';
import { formatDoctor } from './format.ts';
import { runDoctor } from './index.ts';

describe('publishing: s3 settings', () => {
  const s3 = (extra: ConfigInput['publish'] = {}, bucket: ConfigInput['publish'] = {}) =>
    ({
      publish: {
        provider: 's3' as const,
        ...extra,
        s3: { bucket: 'videos', endpoint: 'https://abc.r2.cloudflarestorage.com/secret/path', ...bucket.s3 },
      },
    }) satisfies ConfigInput;

  it('needs a bucket, and then checks nothing else about the storage', async () => {
    const noBucket = await doctor({ publish: { provider: 's3' } });
    expect(byId(noBucket.checks, 'publish')).toMatchObject({ status: 'fail' });
    expect(byId(noBucket.checks, 'publish').fix).toContain('MERGESTORY_S3_BUCKET');
    expect(noBucket.checks.map((c) => c.id).filter((id) => id.startsWith('publish'))).toEqual(['publish']);
    expect(noBucket.ok).toBe(false);
  });

  it('names the bucket and the host of the endpoint, never the rest of the address', async () => {
    const report = await doctor(s3());
    const check = byId(report.checks, 'publish');
    expect(check.status).toBe('pass');
    expect(check.detail).toContain('bucket videos');
    expect(check.detail).toContain('abc.r2.cloudflarestorage.com');
    expect(check.detail).not.toContain('secret/path');
    expect(check.detail).toContain('private links (signed; they stop working after 7 days)');
    const aws = await doctor({ publish: { provider: 's3', s3: { bucket: 'videos' } } });
    expect(byId(aws.checks, 'publish').detail).toContain('endpoint AWS default');
  });

  it('says how long private links last', async () => {
    for (const [seconds, text] of [
      [604_800, '7 days'],
      [86_400, '1 day'],
      [7_200, '2 hours'],
      [3_600, '1 hour'],
      [5_400, '90 minutes'],
      [60, '1 minute'],
    ] as const) {
      const report = await doctor(s3({ linkExpirySec: seconds }));
      expect(byId(report.checks, 'publish').detail, text).toContain(`stop working after ${text})`);
    }
  });

  describe('protected links', () => {
    const protectedLinks = (s3Settings: object = {}, publish: object = {}) =>
      s3(
        { visibility: 'protected', ...publish },
        { s3: { publicBaseUrl: 'https://videos.example.com', ...s3Settings } },
      );

    it('need a public base URL, and the fix names the setting', async () => {
      const report = await doctor(s3({ visibility: 'protected' }));
      const check = byId(report.checks, 'publish');
      expect(check.status).toBe('fail');
      expect(check.detail).toContain('protected links, but no public base URL is set');
      expect(check.fix).toContain('MERGESTORY_S3_PUBLIC_BASE_URL');
      expect(check.fix).toContain('access proxy');
      expect(check.fix).toContain('docs/hosting.md in the MergeStory repository');
      expect(report.ok).toBe(false);
    });

    it('pass when the address is set and checked before every upload', async () => {
      const report = await doctor(protectedLinks());
      const check = byId(report.checks, 'publish');
      expect(check.status).toBe('pass');
      expect(check.detail).toContain(
        'protected links through videos.example.com, checked before every upload',
      );
      expect(check.detail).toContain('mergestory doctor --online');
    });

    it('fail for an r2.dev address, which Cloudflare Access cannot protect', async () => {
      const report = await doctor(protectedLinks({ publicBaseUrl: 'https://pub-0123abcd.r2.dev' }));
      const check = byId(report.checks, 'publish');
      expect(check.status).toBe('fail');
      expect(check.detail).toContain('r2.dev addresses cannot be put behind Cloudflare Access');
      expect(check.fix).toContain('custom domain');
      expect(report.ok).toBe(false);
    });

    it('fail for the storage address itself, but not for another port on the same machine', async () => {
      const api = await doctor(
        protectedLinks({
          endpoint: 'https://abc.r2.cloudflarestorage.com',
          publicBaseUrl: 'https://abc.r2.cloudflarestorage.com/videos',
        }),
      );
      expect(byId(api.checks, 'publish')).toMatchObject({ status: 'fail' });
      expect(byId(api.checks, 'publish').detail).toContain('storage API address');
      const otherPort = await doctor(
        protectedLinks({ endpoint: 'http://127.0.0.1:9000', publicBaseUrl: 'http://127.0.0.1:8080' }),
      );
      expect(byId(otherPort.checks, 'publish').status).toBe('pass');
    });

    it('warn when the check before upload is switched off', async () => {
      const report = await doctor(protectedLinks({ verifyProtection: false }));
      const check = byId(report.checks, 'publish');
      expect(check.status).toBe('warn');
      expect(check.detail).toContain('NOT checked before upload');
      expect(check.fix).toContain('MERGESTORY_S3_VERIFY_PROTECTION=true');
      expect(report.ok).toBe(true);
    });

    it('show only the host of the address, never its path or query', async () => {
      const report = await doctor(
        protectedLinks({ publicBaseUrl: 'https://videos.example.com:8443/team?x=1' }),
      );
      const text = JSON.stringify(report);
      expect(text).toContain('videos.example.com:8443');
      for (const hidden of ['/team', 'x=1']) expect(text).not.toContain(hidden);
    });

    it.each([
      ['is not http or https', 'ftp://videos.example.com'],
      ['has a user name and a password', 'https://user:hunter2@videos.example.com'],
      ['has a password only', 'https://:hunter2@videos.example.com'],
      ['has a user name only', 'https://hunter2@videos.example.com'],
    ])('fail for an address that %s, as the upload does, and never show it', async (_why, address) => {
      const report = await doctor(protectedLinks({ publicBaseUrl: address }));
      const check = byId(report.checks, 'publish');
      expect(check.status).toBe('fail');
      expect(check.detail).toContain(
        'protected links, but the public base URL is not a plain http(s) address (no user name or password)',
      );
      expect(check.fix).toContain('MERGESTORY_S3_PUBLIC_BASE_URL');
      expect(report.ok).toBe(false);
      const text = JSON.stringify(report);
      for (const hidden of ['hunter2', 'videos.example.com']) expect(text).not.toContain(hidden);
    });
  });

  describe('public links', () => {
    it('need a public base URL', async () => {
      const report = await doctor(s3({ visibility: 'public' }));
      const check = byId(report.checks, 'publish');
      expect(check).toMatchObject({ status: 'fail' });
      expect(check.fix).toContain('MERGESTORY_S3_PUBLIC_BASE_URL');
    });

    it('pass when the address is set, and say that private repositories are blocked', async () => {
      const report = await doctor(
        s3({ visibility: 'public' }, { s3: { publicBaseUrl: 'https://cdn.example.com' } }),
      );
      const check = byId(report.checks, 'publish');
      expect(check.status).toBe('pass');
      expect(check.detail).toContain('public links through cdn.example.com');
      expect(check.detail).toContain('blocked for private repositories');
    });

    it('warn when public links are allowed for private repositories', async () => {
      const report = await doctor(
        s3(
          { visibility: 'public', allowPublicForPrivateRepos: true },
          { s3: { publicBaseUrl: 'https://cdn.example.com' } },
        ),
      );
      const check = byId(report.checks, 'publish');
      expect(check.status).toBe('warn');
      expect(check.detail).toContain('publish.allowPublicForPrivateRepos is on');
      expect(check.fix).toContain('allowPublicForPrivateRepos');
    });

    it('fail for an address that the upload refuses, and never show it', async () => {
      for (const address of ['ftp://cdn.example.com', 'https://user:hunter2@cdn.example.com']) {
        const report = await doctor(s3({ visibility: 'public' }, { s3: { publicBaseUrl: address } }));
        const check = byId(report.checks, 'publish');
        expect(check.status, address).toBe('fail');
        expect(check.detail, address).toContain(
          'public links, but the public base URL is not a plain http(s) address (no user name or password)',
        );
        expect(report.ok, address).toBe(false);
        for (const hidden of ['hunter2', 'cdn.example.com'])
          expect(JSON.stringify(report)).not.toContain(hidden);
      }
    });
  });

  describe('the public base URL', () => {
    const addresses = [
      'https://videos.example.com',
      'https://videos.example.com/team?x=1',
      'HTTPS://Videos.Example.com:443/',
      'http://127.0.0.1:8080',
      'ftp://videos.example.com',
      'file:///srv/videos',
      'https://user:hunter2@videos.example.com',
      'https://hunter2@videos.example.com',
      'https://:hunter2@videos.example.com',
    ];

    it.each(['protected', 'public'] as const)(
      'is accepted for %s links when the run accepts it, and refused when the run refuses it',
      async (visibility) => {
        for (const publicBaseUrl of addresses) {
          const settings = s3({ visibility }, { s3: { publicBaseUrl } });
          const config = configWith(settings);
          const problem = await createPublisher(config)?.check(
            {
              secrets: new Secrets({}, new Redactor()),
              redactor: new Redactor(),
              home: homeLayout(config.home),
            },
            false,
          );
          const check = byId((await doctor(settings)).checks, 'publish');
          expect(check.status === 'fail', `${visibility} ${publicBaseUrl}`).toBe((problem ?? null) !== null);
        }
      },
    );
  });
});

describe('publishing: s3 keys', () => {
  const s3 = { publish: { provider: 's3' as const, s3: { bucket: 'videos' } } };
  const secret = 'wJalrXUtnFEMI-SECRET-0123456789abcdef';

  it('warn without keys in the environment, and say what to set', async () => {
    const report = await doctor(s3);
    const check = byId(report.checks, 'publish-credentials');
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('AWS default credential chain');
    expect(check.fix).toContain('MERGESTORY_S3_ACCESS_KEY_ID');
    expect(report.ok).toBe(true);
  });

  it('pass with the MergeStory pair or with the AWS pair, and show names only', async () => {
    const own = await doctor(
      s3,
      {},
      { MERGESTORY_S3_ACCESS_KEY_ID: 'AKIAEXAMPLE0123456789', MERGESTORY_S3_SECRET_ACCESS_KEY: secret },
    );
    expect(byId(own.checks, 'publish-credentials')).toMatchObject({
      status: 'pass',
      detail: 'MERGESTORY_S3_ACCESS_KEY_ID and MERGESTORY_S3_SECRET_ACCESS_KEY are set',
    });
    const aws = await doctor(
      s3,
      {},
      { AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE0123456789', AWS_SECRET_ACCESS_KEY: secret },
    );
    expect(byId(aws.checks, 'publish-credentials').detail).toBe(
      'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are set',
    );
    for (const report of [own, aws]) {
      const text = JSON.stringify(report) + formatDoctor(report, createStyle(false));
      expect(text).not.toContain(secret);
      expect(text).not.toContain('AKIAEXAMPLE0123456789');
    }
  });

  it('warn for half an AWS pair, which the credential chain may complete', async () => {
    const half = await doctor(s3, {}, { AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE0123456789' });
    expect(byId(half.checks, 'publish-credentials').status).toBe('warn');
  });

  it('shows a problem with the address and a problem with the keys, each on its own line', async () => {
    const report = await doctor(
      { publish: { provider: 's3', visibility: 'protected', s3: { bucket: 'videos' } } },
      {},
      { MERGESTORY_S3_ACCESS_KEY_ID: 'only-one-of-the-pair-0123456789' },
    );
    expect(byId(report.checks, 'publish')).toMatchObject({ status: 'fail' });
    expect(byId(report.checks, 'publish').detail).toContain('no public base URL is set');
    expect(byId(report.checks, 'publish-credentials')).toMatchObject({ status: 'fail' });
    expect(byId(report.checks, 'publish-credentials').detail).toContain(
      'only MERGESTORY_S3_ACCESS_KEY_ID is set',
    );
  });

  it('fail for half a MergeStory pair, because the upload would refuse it', async () => {
    for (const name of ['MERGESTORY_S3_ACCESS_KEY_ID', 'MERGESTORY_S3_SECRET_ACCESS_KEY']) {
      const half = await doctor(
        s3,
        {},
        {
          [name]: 'only-one-of-the-pair-0123456789',
          AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE0123456789',
          AWS_SECRET_ACCESS_KEY: secret,
        },
      );
      const check = byId(half.checks, 'publish-credentials');
      expect(check.status).toBe('fail');
      expect(check.detail).toContain(`only ${name} is set`);
      expect(check.fix).toContain('Set both');
      expect(half.ok).toBe(false);
    }
  });
});

describe('publishing: s3 without --online', () => {
  const protectedS3: ConfigInput = {
    publish: {
      provider: 's3',
      visibility: 'protected',
      s3: { bucket: 'videos', publicBaseUrl: 'https://videos.example.com' },
    },
  };

  it('makes no network call and reads no credentials file', async () => {
    const headBucket = vi.fn();
    const probeAccess = vi.fn();
    const readYouTubeLogin = vi.fn(async () => null);
    for (const provider of ['s3', 'local', 'none', 'youtube'] as const) {
      const config = provider === 's3' ? protectedS3 : { publish: { provider } };
      await doctor(config, { headBucket, probeAccess, readYouTubeLogin });
    }
    expect(headBucket).not.toHaveBeenCalled();
    expect(probeAccess).not.toHaveBeenCalled();
    // Only the YouTube check reads a file, and it is local.
    expect(readYouTubeLogin).toHaveBeenCalledTimes(1);
  });

  it('reports the same checks every time and marks the report as offline', async () => {
    const report = await doctor(protectedS3);
    expect(report.online).toBe(false);
    expect(report.checks.map((c) => c.id).filter((id) => id.startsWith('publish'))).toEqual([
      'publish',
      'publish-credentials',
    ]);
  });
});

describe('publishing: s3 with --online', () => {
  const protectedS3: ConfigInput = {
    publish: {
      provider: 's3',
      visibility: 'protected',
      s3: {
        bucket: 'videos',
        endpoint: 'https://abc.r2.cloudflarestorage.com',
        publicBaseUrl: 'https://videos.example.com',
      },
    },
  };
  const privateS3: ConfigInput = {
    publish: { provider: 's3', s3: { bucket: 'videos', endpoint: 'https://abc.r2.cloudflarestorage.com' } },
  };
  const bucket = (found: BucketCheck) => ({ headBucket: async () => found });
  const probe = (found: Partial<AccessProbeResult>) => ({
    probeAccess: async () => ({ ...PROTECTED_PROBE, ...found }),
  });

  it('asks the storage service with the real settings and keys, and the address without any', async () => {
    const headBucket = vi.fn(async (): Promise<BucketCheck> => ({ kind: 'ok', httpStatus: 200, code: null }));
    const probeAccess = vi.fn(async () => PROTECTED_PROBE);
    const report = await doctor(
      protectedS3,
      { headBucket, probeAccess },
      {
        MERGESTORY_S3_ACCESS_KEY_ID: 'AKIAEXAMPLE0123456789',
        MERGESTORY_S3_SECRET_ACCESS_KEY: 'secret-value-0123456789',
      },
      true,
    );
    expect(report.online).toBe(true);
    expect(headBucket).toHaveBeenCalledTimes(1);
    const [config, secrets] = headBucket.mock.calls[0] as unknown as [Config, { has(name: string): boolean }];
    expect(config.publish.s3.bucket).toBe('videos');
    expect(secrets.has('MERGESTORY_S3_ACCESS_KEY_ID')).toBe(true);
    // The probe gets the address and the folder that the videos go into, and nothing else.
    expect(probeAccess).toHaveBeenCalledTimes(1);
    expect(probeAccess).toHaveBeenCalledWith('https://videos.example.com', 'mergestory/');
    expect(report.checks.map((c) => c.id).filter((id) => id.startsWith('publish'))).toEqual([
      'publish',
      'publish-credentials',
      'publish-bucket',
      'publish-protection',
    ]);
  });

  it('uses the configured folder name for the probe', async () => {
    const probeAccess = vi.fn(async () => PROTECTED_PROBE);
    await doctor(
      { publish: { ...protectedS3.publish, s3: { ...protectedS3.publish?.s3, prefix: 'Team Videos/2026' } } },
      { probeAccess },
      {},
      true,
    );
    expect(probeAccess).toHaveBeenCalledWith('https://videos.example.com', 'team-videos/2026/');
  });

  it('only runs the protection check for protected links that are checked before upload', async () => {
    const probeAccess = vi.fn(async () => PROTECTED_PROBE);
    const configs: ConfigInput[] = [
      privateS3,
      { publish: { ...protectedS3.publish, visibility: 'public' } },
      { publish: { ...protectedS3.publish, s3: { ...protectedS3.publish?.s3, verifyProtection: false } } },
      { publish: { provider: 's3', visibility: 'protected', s3: { bucket: 'videos' } } },
    ];
    for (const config of configs) await doctor(config, { probeAccess }, {}, true);
    expect(probeAccess).not.toHaveBeenCalled();
  });

  it('does not ask an address that the upload refuses', async () => {
    const probeAccess = vi.fn(async () => PROTECTED_PROBE);
    for (const publicBaseUrl of ['ftp://videos.example.com', 'https://user:hunter2@videos.example.com']) {
      const settings = {
        publish: { ...protectedS3.publish, s3: { ...protectedS3.publish?.s3, publicBaseUrl } },
      };
      const report = await doctor(settings, { probeAccess }, {}, true);
      expect(byId(report.checks, 'publish').status, publicBaseUrl).toBe('fail');
    }
    expect(probeAccess).not.toHaveBeenCalled();
  });

  it('does not contact anything when the provider is not s3, or when there is no bucket', async () => {
    const headBucket = vi.fn();
    const probeAccess = vi.fn();
    for (const config of [
      { publish: { provider: 'local' as const } },
      { publish: { provider: 'none' as const } },
      { publish: { provider: 'youtube' as const } },
      { publish: { provider: 's3' as const } },
    ]) {
      await doctor(config, { headBucket, probeAccess }, {}, true);
    }
    expect(headBucket).not.toHaveBeenCalled();
    expect(probeAccess).not.toHaveBeenCalled();
  });

  it('passes when the bucket answers', async () => {
    const report = await doctor(privateS3, bucket({ kind: 'ok', httpStatus: 200, code: null }), {}, true);
    const check = byId(report.checks, 'publish-bucket');
    expect(check).toMatchObject({ status: 'pass', name: 'Storage access' });
    expect(check.detail).toContain('bucket videos exists at abc.r2.cloudflarestorage.com');
  });

  it.each([
    [
      { kind: 'access-denied', httpStatus: 403, code: 'Forbidden' },
      'warn',
      /HTTP 403.*list the bucket/,
      /write and read files/,
    ],
    [
      { kind: 'not-found', httpStatus: 404, code: 'NotFound' },
      'fail',
      /bucket videos was not found at abc\.r2\.cloudflarestorage\.com/,
      /MERGESTORY_S3_ENDPOINT/,
    ],
    [
      { kind: 'wrong-region', httpStatus: 301, code: 'PermanentRedirect' },
      'fail',
      /another region or at another address \(HTTP 301\)/,
      /MERGESTORY_S3_REGION/,
    ],
    [
      { kind: 'unreachable', httpStatus: null, code: 'ENOTFOUND' },
      'fail',
      /could not be reached \(ENOTFOUND\)/,
      /network/,
    ],
    [
      { kind: 'other', httpStatus: 500, code: 'InternalError' },
      'warn',
      /unexpected answer \(HTTP 500\) \(InternalError\)/,
      /try again/,
    ],
    [
      {
        kind: 'config',
        httpStatus: null,
        code: null,
        problem: { message: 'No storage credentials were found.', hint: 'Set the keys.' },
      },
      'fail',
      /No storage credentials were found\./,
      /Set the keys\./,
    ],
  ] as [BucketCheck, string, RegExp, RegExp][])(
    'maps a bucket answer of kind %o to %s',
    async (found, status, detail, fix) => {
      const report = await doctor(privateS3, bucket(found), {}, true);
      const check = byId(report.checks, 'publish-bucket');
      expect(check.status).toBe(status);
      expect(check.detail).toMatch(detail);
      expect(check.fix).toMatch(fix);
      expect(report.ok).toBe(status !== 'fail');
    },
  );

  it('passes the protection check when the address redirects to a sign-in', async () => {
    const report = await doctor(protectedS3, probe({}), {}, true);
    const check = byId(report.checks, 'publish-protection');
    expect(check).toMatchObject({ status: 'pass', name: 'Link protection' });
    expect(check.detail).toContain('videos.example.com redirected to the Cloudflare Access sign-in page');
  });

  it('fails the protection check for an open address, because protected links would be blocked', async () => {
    const report = await doctor(
      protectedS3,
      probe({
        verdict: 'not-protected',
        reason: 'not-found',
        status: 404,
        detail:
          'answered HTTP 404 for a file that does not exist and did not ask for a sign-in: the address looks open to anyone',
      }),
      {},
      true,
    );
    const check = byId(report.checks, 'publish-protection');
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('Protected links are blocked until this is fixed.');
    expect(check.fix).toContain('Cloudflare Access');
    expect(check.fix).toContain('--visibility private');
    expect(report.ok).toBe(false);
  });

  it('fails the protection check when the answer proves nothing, and names the way out', async () => {
    const report = await doctor(
      protectedS3,
      probe({
        verdict: 'unknown',
        reason: 'denied',
        status: 403,
        detail: 'answered HTTP 403 without a sign-in page or challenge',
      }),
      {},
      true,
    );
    const check = byId(report.checks, 'publish-protection');
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('could not confirm that videos.example.com needs a sign-in');
    expect(check.fix).toContain('MERGESTORY_S3_VERIFY_PROTECTION=false');
  });

  it('turns a check that throws into a failed check and still runs the others', async () => {
    const report = await doctor(
      protectedS3,
      {
        headBucket: async () => {
          throw new Error('the SDK could not be loaded');
        },
      },
      {},
      true,
    );
    expect(
      report.checks.find((c) => c.detail.includes('the check itself failed: the SDK could not be loaded')),
    ).toBeDefined();
    expect(byId(report.checks, 'node').status).toBe('pass');
    expect(report.ok).toBe(false);
  });

  it('never puts a key, a token or a full address into the report', async () => {
    const secret = 'wJalrXUtnFEMI-SECRET-0123456789abcdef';
    const report = await doctor(
      {
        publish: {
          ...protectedS3.publish,
          s3: { ...protectedS3.publish?.s3, publicBaseUrl: 'https://videos.example.com/team?token=abc123' },
        },
      },
      {},
      { MERGESTORY_S3_ACCESS_KEY_ID: 'AKIAEXAMPLE0123456789', MERGESTORY_S3_SECRET_ACCESS_KEY: secret },
      true,
    );
    const text = JSON.stringify(report) + formatDoctor(report, createStyle(false));
    for (const hidden of [secret, 'AKIAEXAMPLE0123456789', 'token=abc123', '/team'])
      expect(text).not.toContain(hidden);
  });

  it('shows the fix line of a failed online check in the printed report', async () => {
    const report = await doctor(
      privateS3,
      bucket({ kind: 'not-found', httpStatus: 404, code: 'NotFound' }),
      {},
      true,
    );
    const text = formatDoctor(report, createStyle(false));
    expect(text).toContain('FAIL  Storage access');
    expect(text).toContain('fix: Check the bucket name');
    expect(text).toContain('Fix the failed checks above');
  });
});

describe('publishing: the real online checks, against a local server', () => {
  /** A server that is a bucket for HEAD requests and a sign-in redirect for everything else. */
  async function withServer<T>(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
    work: (base: string, requests: string[]) => Promise<T>,
  ): Promise<T> {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      return await work(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  const env = {
    MERGESTORY_S3_ACCESS_KEY_ID: 'AKIAEXAMPLE0123456789',
    MERGESTORY_S3_SECRET_ACCESS_KEY: 'secret-value-0123456789',
  };

  async function online(base: string) {
    const real = defaultDoctorDeps(env);
    return runDoctor({
      config: configWith({
        publish: {
          provider: 's3',
          visibility: 'protected',
          s3: {
            bucket: 'videos',
            endpoint: base,
            region: 'us-east-1',
            forcePathStyle: true,
            publicBaseUrl: base,
          },
        },
      }),
      online: true,
      deps: healthyDeps({ env, headBucket: real.headBucket, probeAccess: real.probeAccess }),
    });
  }

  it('contacts the bucket and the public address, and nothing else', async () => {
    await withServer(
      (req, res) => {
        if (req.method === 'HEAD') res.writeHead(200).end();
        else
          res
            .writeHead(302, {
              location: 'https://acme.cloudflareaccess.com/cdn-cgi/access/login/videos.example.com',
            })
            .end();
      },
      async (base, requests) => {
        const report = await online(base);
        expect(byId(report.checks, 'publish-bucket').status).toBe('pass');
        expect(byId(report.checks, 'publish-protection').status).toBe('pass');
        expect(requests).toHaveLength(2);
        expect(requests[0]).toBe('HEAD /videos/');
        expect(requests[1]).toMatch(/^GET \/mergestory\/mergestory-check-[0-9a-f]{16}$/);
      },
    );
  });

  it('fails the protection check when the address is open', async () => {
    await withServer(
      (req, res) => {
        res.writeHead(req.method === 'HEAD' ? 200 : 404).end();
      },
      async (base) => {
        const report = await online(base);
        expect(byId(report.checks, 'publish-bucket').status).toBe('pass');
        expect(byId(report.checks, 'publish-protection')).toMatchObject({ status: 'fail' });
        expect(report.ok).toBe(false);
      },
    );
  });

  it('reports a bucket that is not there', async () => {
    await withServer(
      (req, res) => {
        res.writeHead(req.method === 'HEAD' ? 404 : 302, { location: '/login' }).end();
      },
      async (base) => {
        const report = await online(base);
        expect(byId(report.checks, 'publish-bucket')).toMatchObject({ status: 'fail' });
        expect(byId(report.checks, 'publish-bucket').detail).toContain('was not found');
      },
    );
  });
});
