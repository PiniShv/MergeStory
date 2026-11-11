import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MergeStoryError } from '../../core/errors.ts';
import type { GenerateResult, PublishResult } from '../../core/types.ts';
import { generate, publishRun } from '../../pipeline/index.ts';
import { runCli } from '../program.ts';
import { createStyle } from '../style.ts';
import { formatPublishResult } from './publish.ts';

vi.mock('../../pipeline/index.ts', () => ({
  generate: vi.fn(),
  prepareAuthoring: vi.fn(),
  checkStoryboard: vi.fn(),
  publishRun: vi.fn(),
}));

const publishMock = vi.mocked(publishRun);
const generateMock = vi.mocked(generate);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mergestory-publish-'));
  publishMock.mockReset();
  generateMock.mockReset();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function run(argv: string[], env: Record<string, string> = {}) {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    env: { MERGESTORY_HOME: join(dir, 'home'), ...env },
    cwd: dir,
    handleSignals: false,
    stdoutIsTty: false,
    stderrIsTty: false,
  });
  return { code, stdout, stderr };
}

const PROTECTED_WATCH = 'https://videos.example.com/mergestory/v/0123456789abcdef0123456789abcdef/index.html';
const SIGNED_VIDEO =
  'https://media.acct123.r2.cloudflarestorage.com/mergestory/v/aaaa/video.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=604800&X-Amz-Signature=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function published(overrides: Partial<PublishResult> = {}): PublishResult {
  return {
    provider: 's3',
    watchUrl: PROTECTED_WATCH,
    videoUrl: PROTECTED_WATCH.replace('index.html', 'video.mp4'),
    posterUrl: PROTECTED_WATCH.replace('index.html', 'poster.jpg'),
    captionsUrl: PROTECTED_WATCH.replace('index.html', 'captions.vtt'),
    expiresAt: null,
    visibility: 'protected',
    location: 's3://media/mergestory/v/0123456789abcdef0123456789abcdef/',
    ...overrides,
  };
}

function fakeResult(overrides: Partial<GenerateResult> = {}): GenerateResult {
  return {
    ok: true,
    runId: '20261104-101500-a1b2',
    runDir: '/runs/20261104-101500-a1b2',
    title: 'Add retries to the uploader',
    summary: 'Adds retries.',
    durationSec: 83,
    chapters: [{ title: 'The mission', startSec: 0 }],
    storyboardSource: 'heuristic',
    files: {
      video: '/runs/r1/video.mp4',
      poster: '/runs/r1/poster.jpg',
      captions: '/runs/r1/captions.vtt',
      storyboard: '/runs/r1/storyboard.json',
      watchPage: '/runs/r1/index.html',
    },
    publish: published(),
    notify: null,
    grounding: { groundedClaims: 9, fixes: [], warnings: [] },
    cost: {
      totalUsd: 0,
      budgetUsd: 0.25,
      records: [
        { provider: 's3', kind: 'storage', model: null, bytes: 9_000_000, costUsd: 0, estimated: true },
      ],
    },
    egress: [
      { destination: 'videos.example.com', purpose: 'protection check', bytes: 0, contains: [] },
      {
        destination: 'acct123.r2.cloudflarestorage.com',
        purpose: 'video upload',
        bytes: 9_900_000,
        contains: ['video'],
      },
    ],
    warnings: [],
    ...overrides,
  };
}

function lastOptions() {
  const call = publishMock.mock.calls.at(-1);
  if (!call) throw new Error('publishRun was not called');
  return call[0];
}

describe('publish: flags become PublishRunOptions', () => {
  it('passes the run as typed and sets nothing else when no flag is given', async () => {
    publishMock.mockResolvedValue(fakeResult());
    const { code } = await run(['publish', '20261104-101500-a1b2']);
    expect(code).toBe(0);
    const options = lastOptions();
    expect(options.run).toBe('20261104-101500-a1b2');
    expect(options.config).toBeUndefined();
    expect(options.configPath).toBeUndefined();
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.logger).toBeDefined();
  });

  it('maps every flag to the matching setting', async () => {
    publishMock.mockResolvedValue(fakeResult());
    const { code } = await run([
      'publish',
      '20261104-101500-a1b2',
      '--publish',
      's3',
      '--visibility',
      'protected',
      '--comment',
      '--update-description',
    ]);
    expect(code).toBe(0);
    const options = lastOptions();
    expect(options.config).toEqual({
      publish: { provider: 's3', visibility: 'protected' },
      github: { comment: true, updateDescription: true },
    });
    expect(options.configPath).toBeUndefined();
  });

  it.each([
    ['local', {}],
    ['s3', {}],
    ['youtube', {}],
  ])('accepts --publish %s', async (provider) => {
    publishMock.mockResolvedValue(fakeResult());
    const { code } = await run(['publish', 'r1', '--publish', provider]);
    expect(code).toBe(0);
    expect(lastOptions().config).toEqual({ publish: { provider } });
  });

  it.each(['private', 'protected', 'public'])('accepts --visibility %s', async (visibility) => {
    publishMock.mockResolvedValue(fakeResult());
    await run(['publish', 'r1', '--visibility', visibility]);
    expect(lastOptions().config).toEqual({ publish: { visibility } });
  });

  it('does not switch anything on that was not asked for', async () => {
    publishMock.mockResolvedValue(fakeResult());
    await run(['publish', 'r1', '--comment']);
    expect(lastOptions().config).toEqual({ github: { comment: true } });
  });

  it('turns a run folder next to the user into an absolute path, and leaves a run id alone', async () => {
    await mkdir(join(dir, 'runs', 'one'), { recursive: true });
    publishMock.mockResolvedValue(fakeResult());
    await run(['publish', 'runs/one']);
    expect(lastOptions().run).toBe(join(dir, 'runs', 'one'));
    await run(['publish', resolve(dir, 'elsewhere')]);
    expect(lastOptions().run).toBe(resolve(dir, 'elsewhere'));
    await run(['publish', '20261104-101500-a1b2']);
    expect(lastOptions().run).toBe('20261104-101500-a1b2');
  });

  it('reads the config file named in MERGESTORY_CONFIG before it publishes, and reports a broken one', async () => {
    await writeFile(join(dir, 'broken.json'), '{not json');
    for (const file of ['broken.json', 'missing.json']) {
      const { code, stderr } = await run(['publish', 'r1'], { MERGESTORY_CONFIG: file });
      expect(code, file).toBe(2);
      expect(stderr).toContain('error [CONFIG_INVALID]');
    }
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('uses the publish provider of the config file', async () => {
    await writeFile(join(dir, 'ms.json'), JSON.stringify({ publish: { provider: 'none' } }));
    const { code, stderr } = await run(['publish', 'r1'], { MERGESTORY_CONFIG: 'ms.json' });
    expect(code).toBe(2);
    expect(stderr).toContain('nowhere to publish');
    expect(publishMock).not.toHaveBeenCalled();
  });
});

describe('publish: input that is refused', () => {
  it('needs a run', async () => {
    const { code, stderr } = await run(['publish']);
    expect(code).toBe(2);
    expect(stderr).toContain('error [USAGE]');
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('rejects an empty run', async () => {
    const { code, stderr } = await run(['publish', '']);
    expect(code).toBe(2);
    expect(stderr).toContain('error [USAGE]');
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('rejects unknown choices, and "none", which would publish nothing', async () => {
    for (const flags of [
      ['--publish', 'ftp'],
      ['--publish', 'none'],
      ['--visibility', 'unlisted'],
      ['--visibility', 'secret'],
    ]) {
      const { code, stderr } = await run(['publish', 'r1', ...flags]);
      expect(code, flags.join(' ')).toBe(2);
      expect(stderr).toContain('error [USAGE]');
    }
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('says so when the settings send the video nowhere', async () => {
    const { code, stderr } = await run(['publish', 'r1'], { MERGESTORY_PUBLISH_PROVIDER: 'none' });
    expect(code).toBe(2);
    expect(stderr).toContain('error [USAGE]');
    expect(stderr).toContain('nowhere to publish');
    expect(stderr).toContain('--publish local, s3 or youtube');
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('lets a flag win over the environment', async () => {
    publishMock.mockResolvedValue(fakeResult());
    const { code } = await run(['publish', 'r1', '--publish', 's3'], { MERGESTORY_PUBLISH_PROVIDER: 'none' });
    expect(code).toBe(0);
  });
});

describe('publish: output', () => {
  it('shows the link, who can open it, the pull request and everything that was sent', async () => {
    publishMock.mockResolvedValue(
      fakeResult({
        notify: {
          commentUrl: 'https://github.com/acme/app/pull/42#issuecomment-1',
          descriptionUpdated: true,
        },
      }),
    );
    const { code, stdout } = await run(['publish', 'r1', '--publish', 's3']);
    expect(code).toBe(0);
    expect(stdout).toContain('Published: Add retries to the uploader');
    expect(stdout).toContain(`Shared`);
    expect(stdout).toContain(PROTECTED_WATCH);
    expect(stdout).toContain('protected: a permanent link that needs a team sign-in');
    expect(stdout).toContain(
      'comment https://github.com/acme/app/pull/42#issuecomment-1, description updated',
    );
    expect(stdout).toContain('/runs/20261104-101500-a1b2');
    expect(stdout).toContain('videos.example.com: protection check, 0 B');
    expect(stdout).toContain('acct123.r2.cloudflarestorage.com: video upload, 9.4 MB (video)');
    expect(stdout).not.toContain('Expires');
    expect(stdout).not.toContain('\u001b[');
  });

  it('shows when a private link stops working', async () => {
    publishMock.mockResolvedValue(
      fakeResult({
        publish: published({
          visibility: 'private',
          watchUrl: SIGNED_VIDEO.replace('video.mp4', 'index.html'),
          videoUrl: SIGNED_VIDEO,
          expiresAt: '2026-11-11T10:15:00.000Z',
        }),
      }),
    );
    const { stdout } = await run(['publish', 'r1']);
    expect(stdout).toContain('private: a signed link that stops working when it expires');
    expect(stdout).toContain('Expires');
    expect(stdout).toContain('2026-11-11 10:15:00 UTC');
  });

  it('keeps a signed link intact: a link without its signature does not work', async () => {
    publishMock.mockResolvedValue(
      fakeResult({
        publish: published({
          visibility: 'private',
          videoUrl: SIGNED_VIDEO,
          expiresAt: '2026-11-11T10:15:00.000Z',
        }),
      }),
    );
    const human = await run(['publish', 'r1']);
    expect(human.stdout).toContain(SIGNED_VIDEO);
    const json = await run(['publish', 'r1', '--json']);
    expect(JSON.parse(json.stdout).publish.videoUrl).toBe(SIGNED_VIDEO);
  });

  it('says a local copy is only on this machine', async () => {
    publishMock.mockResolvedValue(
      fakeResult({
        publish: published({
          provider: 'local',
          watchUrl: 'file:///runs/r1/publish/index.html',
          videoUrl: 'file:///runs/r1/publish/video.mp4',
          visibility: 'private',
        }),
        egress: [],
      }),
    );
    const { stdout } = await run(['publish', 'r1', '--publish', 'local']);
    expect(stdout).toContain('Saved');
    expect(stdout).toContain('only on this machine');
    expect(stdout).toContain('nothing left this machine');
    expect(stdout).not.toContain('Shared');
  });

  it('describes a YouTube link', async () => {
    publishMock.mockResolvedValue(
      fakeResult({
        publish: published({
          provider: 'youtube',
          watchUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
          videoUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
          visibility: 'unlisted',
          location: 'youtube:abcdefghijk',
        }),
        egress: [
          {
            destination: 'www.googleapis.com',
            purpose: 'video upload',
            bytes: 10_000_000,
            contains: ['video'],
          },
        ],
      }),
    );
    const { stdout } = await run(['publish', 'r1', '--publish', 'youtube']);
    expect(stdout).toContain('https://www.youtube.com/watch?v=abcdefghijk');
    expect(stdout).toContain('unlisted: anyone with the link can watch');
  });

  it('prints the warnings of the run', async () => {
    publishMock.mockResolvedValue(
      fakeResult({ warnings: ['Skipped the PR update: the video is only on this machine.'] }),
    );
    const { stdout } = await run(['publish', 'r1']);
    expect(stdout).toContain('Warnings');
    expect(stdout).toContain('- Skipped the PR update');
  });

  it('prints one JSON document and nothing else with --json', async () => {
    const result = fakeResult();
    publishMock.mockResolvedValue(result);
    const { code, stdout } = await run(['publish', 'r1', '--json']);
    expect(code).toBe(0);
    expect(stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(stdout)).toEqual(result);
  });

  it('removes secrets from every other string', async () => {
    const token = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
    publishMock.mockResolvedValue(fakeResult({ warnings: [`The comment failed with ${token}`] }));
    const json = await run(['publish', 'r1', '--json']);
    expect(json.stdout).not.toContain(token);
    const human = await run(['publish', 'r1']);
    expect(human.stdout).not.toContain(token);
  });

  it('says what to do when nothing was published', async () => {
    publishMock.mockResolvedValue(fakeResult({ publish: null }));
    const { code, stdout } = await run(['publish', 'r1']);
    expect(code).toBe(0);
    expect(stdout).toContain('Nothing was published');
    expect(stdout).toContain('--publish local, s3 or youtube');
  });
});

describe('publish: failures', () => {
  it('exits 7 and explains when the privacy check blocks the upload', async () => {
    publishMock.mockRejectedValue(
      new MergeStoryError(
        'PRIVACY_BLOCKED',
        'Protected links are blocked: videos.example.com is not behind a sign-in.',
        {
          hint: 'Put the address behind an access proxy.',
        },
      ),
    );
    const { code, stdout, stderr } = await run([
      'publish',
      'r1',
      '--publish',
      's3',
      '--visibility',
      'protected',
    ]);
    expect(code).toBe(7);
    expect(stdout).toBe('');
    expect(stderr).toContain('error [PRIVACY_BLOCKED]: Protected links are blocked');
    expect(stderr).toContain('hint: Put the address behind an access proxy.');
  });

  it('prints the error as JSON with --json', async () => {
    publishMock.mockRejectedValue(
      new MergeStoryError('PRIVACY_BLOCKED', 'blocked', {
        hint: 'fix it',
        details: { host: 'videos.example.com' },
      }),
    );
    const { code, stdout } = await run(['publish', 'r1', '--json']);
    expect(code).toBe(7);
    expect(JSON.parse(stdout)).toEqual({
      ok: false,
      error: {
        code: 'PRIVACY_BLOCKED',
        message: 'blocked',
        hint: 'fix it',
        details: { host: 'videos.example.com' },
      },
    });
  });

  it('exits 2 when there is no such run', async () => {
    publishMock.mockRejectedValue(
      new MergeStoryError('SOURCE_NOT_FOUND', 'No rendered run found for "nope".', {
        hint: 'Pass the run folder (runDir in the generate result) or its run id.',
      }),
    );
    const { code, stderr } = await run(['publish', 'nope']);
    expect(code).toBe(2);
    expect(stderr).toContain('error [SOURCE_NOT_FOUND]');
  });

  it.each([
    ['PUBLISH_FAILED', 5],
    ['CONFIG_INVALID', 2],
    ['ABORTED', 130],
  ] as const)('exits with the code of %s', async (errorCode, exitCode) => {
    publishMock.mockRejectedValue(new MergeStoryError(errorCode, 'it failed'));
    const { code } = await run(['publish', 'r1']);
    expect(code).toBe(exitCode);
  });

  it('removes secrets from an error', async () => {
    const token = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
    publishMock.mockRejectedValue(new MergeStoryError('NOTIFY_FAILED', `rejected ${token}`));
    const { stderr } = await run(['publish', 'r1']);
    expect(stderr).not.toContain(token);
  });
});

describe('publish: help', () => {
  it('lists the flags and says what each choice means', async () => {
    const { code, stdout: raw } = await run(['publish', '--help']);
    expect(code).toBe(0);
    // The help text wraps lines, so compare it as one line.
    const stdout = raw.replace(/\s+/g, ' ');
    expect(stdout).toContain('--publish <provider>');
    expect(stdout).toContain('local = a folder on this machine');
    expect(stdout).toContain('s3 = S3-compatible storage');
    expect(stdout).toContain('youtube = your YouTube channel');
    expect(stdout).not.toContain('none = nowhere');
    expect(stdout).toContain('--visibility <visibility>');
    expect(stdout).toContain('private = signed, expires in 7 days at most');
    expect(stdout).toContain('protected = permanent, behind your sign-in proxy');
    expect(stdout).toContain('public = permanent, open to anyone');
    expect(stdout).toContain('--comment');
    expect(stdout).toContain('--update-description');
    expect(stdout).toContain('--json');
    expect(stdout).toContain('Examples:');
    expect(stdout).not.toContain('--budget');
  });

  it('is listed with the other commands that make a video', async () => {
    const { stdout } = await run(['--help']);
    expect(stdout).toMatch(/\n\s+publish \[options\] <run>/);
  });
});

describe('generate: publish flags', () => {
  it('offers youtube and protected, and says what each choice means', async () => {
    const { code, stdout: raw } = await run(['generate', '--help']);
    expect(code).toBe(0);
    const stdout = raw.replace(/\s+/g, ' ');
    expect(stdout).toContain('local = a folder on this machine');
    expect(stdout).toContain('youtube = your YouTube channel');
    expect(stdout).toContain('none = nowhere');
    expect(stdout).toContain('"youtube"');
    expect(stdout).toContain('"protected"');
    expect(stdout).toContain('protected = permanent, behind your sign-in proxy');
  });

  it('maps --publish youtube and --visibility protected to the settings', async () => {
    generateMock.mockResolvedValue(fakeResult());
    await run(['generate', 'acme/app#1', '--publish', 'youtube', '--visibility', 'protected']);
    const options = generateMock.mock.calls.at(-1)?.[0];
    expect(options?.config).toEqual({ publish: { provider: 'youtube', visibility: 'protected' } });
  });

  it('still accepts --publish none', async () => {
    generateMock.mockResolvedValue(fakeResult());
    const { code } = await run(['generate', 'acme/app#1', '--publish', 'none']);
    expect(code).toBe(0);
  });
});

describe('formatPublishResult', () => {
  it('uses color only when asked to', () => {
    expect(formatPublishResult(fakeResult(), createStyle(false))).not.toContain('\u001b[');
    expect(formatPublishResult(fakeResult(), createStyle(true))).toContain('\u001b[');
  });

  it('leaves out the video line for a result without a watch page', () => {
    const text = formatPublishResult(
      fakeResult({ publish: published({ watchUrl: null, videoUrl: 'https://videos.example.com/v.mp4' }) }),
      createStyle(false),
    );
    expect(text).toContain('https://videos.example.com/v.mp4');
    expect(text).not.toMatch(/\n\s+Video\s/);
  });
});
