/**
 * `mergestory publish` with nothing mocked inside MergeStory: the command, the pipeline and the
 * S3 publisher run together against a fake S3 server and a fake access proxy on this machine.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredPublishInput } from '../../core/run-folder.ts';
import type { GenerateResult } from '../../core/types.ts';
import { pageData } from '../../testing/publish.ts';
import { runCli } from '../program.ts';

const RUN_ID = '20261104-101500-a1b2';
const MIB = 1024 * 1024;

let root: string;
let runDir: string;
let s3: Server;
let access: Server;
let s3Url: string;
let accessUrl: string;
let s3Requests: string[];
let accessRequests: string[];
let accessAnswer: (req: IncomingMessage, res: ServerResponse) => void;

const signIn = (_req: IncomingMessage, res: ServerResponse): void => {
  res
    .writeHead(302, { location: 'https://acme.cloudflareaccess.com/cdn-cgi/access/login/videos.example.com' })
    .end();
};

beforeAll(async () => {
  s3 = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake.local');
      s3Requests.push(
        `${req.method} ${decodeURIComponent(url.pathname)}${url.search ? '?' : ''}${[...url.searchParams.keys()].join('&')}`,
      );
      const q = url.searchParams;
      if (req.method === 'POST' && q.has('uploads')) {
        res
          .writeHead(200, { 'content-type': 'application/xml' })
          .end(
            '<?xml version="1.0"?><InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>',
          );
      } else if (req.method === 'PUT' && q.has('partNumber')) {
        res.writeHead(200, { etag: `"p${q.get('partNumber')}"` }).end();
      } else if (req.method === 'POST' && q.has('uploadId')) {
        res
          .writeHead(200, { 'content-type': 'application/xml' })
          .end(
            '<?xml version="1.0"?><CompleteMultipartUploadResult><ETag>"x"</ETag></CompleteMultipartUploadResult>',
          );
      } else {
        res.writeHead(200, { etag: '"one"' }).end();
      }
    });
  });
  access = createServer((req, res) => {
    accessRequests.push(`${req.method} ${req.url}`);
    accessAnswer(req, res);
  });
  await Promise.all([
    new Promise<void>((resolve) => s3.listen(0, '127.0.0.1', resolve)),
    new Promise<void>((resolve) => access.listen(0, '127.0.0.1', resolve)),
  ]);
  s3Url = `http://127.0.0.1:${(s3.address() as AddressInfo).port}`;
  accessUrl = `http://127.0.0.1:${(access.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const server of [s3, access]) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

beforeEach(async () => {
  s3Requests = [];
  accessRequests = [];
  accessAnswer = signIn;
  root = await mkdtemp(join(tmpdir(), 'mergestory-publish-it-'));
  runDir = join(root, 'home', 'runs', RUN_ID);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'video.mp4'), Buffer.alloc(9 * MIB, 7));
  await writeFile(join(runDir, 'poster.jpg'), 'POSTER');
  await writeFile(join(runDir, 'captions.vtt'), 'WEBVTT\n\n00:00.000 --> 00:02.000\nHello\n');

  const watch: StoredPublishInput['watch'] = pageData({
    title: 'Add retries to the uploader',
    summary: 'Failed uploads are retried.',
    changeLabel: 'PR #42',
    headSha: '3f9c2ab1d0e49b7a55c3',
    durationSec: 83,
    chapters: [{ title: 'The mission', startSec: 0 }],
  });
  const stored: StoredPublishInput = {
    version: 1,
    runId: RUN_ID,
    source: 'local',
    prUrl: null,
    // A private repository: protected links are meant for exactly this.
    repoIsPrivate: true,
    headSha: watch.headSha,
    language: 'en',
    watch,
  };
  await writeFile(join(runDir, 'publish-input.json'), JSON.stringify(stored));
  const previous: GenerateResult = {
    ok: true,
    runId: RUN_ID,
    runDir,
    title: watch.title,
    summary: watch.summary,
    durationSec: 83,
    chapters: watch.chapters,
    storyboardSource: 'heuristic',
    files: {
      video: join(runDir, 'video.mp4'),
      poster: join(runDir, 'poster.jpg'),
      captions: join(runDir, 'captions.vtt'),
      storyboard: join(runDir, 'storyboard.json'),
      watchPage: join(runDir, 'index.html'),
    },
    publish: null,
    notify: null,
    grounding: { groundedClaims: 3, fixes: [], warnings: [] },
    cost: { totalUsd: 0, budgetUsd: 0.25, records: [] },
    egress: [],
    warnings: [],
  };
  await writeFile(join(runDir, 'result.json'), JSON.stringify(previous));

  // The pipeline reads the settings from the process environment.
  vi.stubEnv('MERGESTORY_HOME', join(root, 'home'));
  vi.stubEnv('MERGESTORY_S3_BUCKET', 'media');
  vi.stubEnv('MERGESTORY_S3_ENDPOINT', s3Url);
  vi.stubEnv('MERGESTORY_S3_REGION', 'us-east-1');
  vi.stubEnv('MERGESTORY_S3_FORCE_PATH_STYLE', 'true');
  vi.stubEnv('MERGESTORY_S3_PUBLIC_BASE_URL', `${accessUrl}/media`);
  vi.stubEnv('MERGESTORY_S3_ACCESS_KEY_ID', 'AKIATESTTESTTEST0123');
  vi.stubEnv('MERGESTORY_S3_SECRET_ACCESS_KEY', 'test-secret-value-0123456789abcdef');
  vi.stubEnv('MERGESTORY_PUBLISH_PROVIDER', '');
  vi.stubEnv('MERGESTORY_VISIBILITY', '');
  vi.stubEnv('MERGESTORY_S3_VERIFY_PROTECTION', '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function run(argv: string[]) {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    env: { ...process.env },
    cwd: root,
    handleSignals: false,
    stdoutIsTty: false,
    stderrIsTty: false,
  });
  return { code, stdout, stderr };
}

describe('mergestory publish, from the command line to the storage service', () => {
  it('checks the address, uploads into a random folder and prints a permanent link', async () => {
    const { code, stdout } = await run(['publish', runDir, '--publish', 's3', '--visibility', 'protected']);
    expect(code).toBe(0);

    // One check of the address first, in the folder of the videos.
    expect(accessRequests).toHaveLength(1);
    const folder = /^GET \/media\/(mergestory\/v\/[0-9a-f]{32}\/)mergestory-check-[0-9a-f]{16}$/.exec(
      accessRequests[0] ?? '',
    );
    expect(folder).not.toBeNull();
    const prefix = folder?.[1] ?? '';

    // Then the files, all in that folder, and never at the root of the bucket.
    expect(s3Requests.every((r) => r.split(' ')[1]?.startsWith(`/media/${prefix}`))).toBe(true);
    expect(s3Requests.map((r) => r.split(' ')[1]?.split('?')[0]?.split('/').pop())).toContain('video.mp4');
    expect(s3Requests.at(-1)).toBe(`PUT /media/${prefix}index.html?x-id`);

    expect(stdout).toContain(`${accessUrl}/media/${prefix}index.html`);
    expect(stdout).toContain('protected: a permanent link that needs a team sign-in');
    expect(stdout).not.toContain('Expires');
    expect(stdout).toContain('protection check, 0 B');
    expect(stdout).toContain('video upload');
  });

  it('saves the links in the run folder, so a later command can use them', async () => {
    await run(['publish', runDir, '--publish', 's3', '--visibility', 'protected']);
    const saved = JSON.parse(await readFile(join(runDir, 'result.json'), 'utf8')) as GenerateResult;
    expect(saved.publish).toMatchObject({ provider: 's3', visibility: 'protected', expiresAt: null });
    expect(saved.publish?.watchUrl).toMatch(
      new RegExp(`^${accessUrl.replace(/[.]/g, '\\.')}/media/mergestory/v/[0-9a-f]{32}/index\\.html$`),
    );
    expect(saved.egress.map((e) => e.purpose)).toEqual(['protection check', 'video upload']);
  });

  it('prints the same result as JSON', async () => {
    const { code, stdout } = await run([
      'publish',
      runDir,
      '--publish',
      's3',
      '--visibility',
      'protected',
      '--json',
    ]);
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as GenerateResult;
    expect(result.ok).toBe(true);
    expect(result.publish).toMatchObject({ provider: 's3', visibility: 'protected', expiresAt: null });
    expect(result.cost.totalUsd).toBe(0);
  });

  it('uploads nothing and exits 7 when the address is open to anyone', async () => {
    accessAnswer = (_req, res) => {
      res.writeHead(404).end();
    };
    const { code, stdout, stderr } = await run([
      'publish',
      runDir,
      '--publish',
      's3',
      '--visibility',
      'protected',
    ]);
    expect(code).toBe(7);
    expect(stdout).toBe('');
    expect(stderr).toContain('error [PRIVACY_BLOCKED]: Protected links are blocked');
    expect(stderr).toContain('MERGESTORY_S3_VERIFY_PROTECTION=false');
    expect(s3Requests).toEqual([]);
    const saved = JSON.parse(await readFile(join(runDir, 'result.json'), 'utf8')) as GenerateResult;
    expect(saved.publish).toBeNull();
  });

  it('skips the check when it is switched off, for a domain this machine cannot reach', async () => {
    accessAnswer = (_req, res) => {
      res.writeHead(404).end();
    };
    vi.stubEnv('MERGESTORY_S3_VERIFY_PROTECTION', 'false');
    const { code } = await run(['publish', runDir, '--publish', 's3', '--visibility', 'protected']);
    expect(code).toBe(0);
    expect(accessRequests).toEqual([]);
    expect(s3Requests.length).toBeGreaterThan(0);
  });

  it('refuses public links for a private repository, and uploads nothing', async () => {
    const { code, stderr } = await run(['publish', runDir, '--publish', 's3', '--visibility', 'public']);
    expect(code).toBe(7);
    expect(stderr).toContain('This repository is private, so public video links are blocked.');
    expect(accessRequests).toEqual([]);
    expect(s3Requests).toEqual([]);
  });

  it('gives signed links that expire when nothing else is asked for', async () => {
    const { code, stdout } = await run(['publish', runDir, '--publish', 's3']);
    expect(code).toBe(0);
    expect(accessRequests).toEqual([]);
    expect(stdout).toContain('private: a signed link that stops working when it expires');
    expect(stdout).toContain('Expires');
    expect(stdout).toContain('X-Amz-Signature=');
    expect(stdout).not.toContain('x-amz-checksum');
  });
});
