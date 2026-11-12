/**
 * Publishing a run folder that was rendered earlier. The folder may have been moved, copied from a CI
 * artifact or written by somebody else, so nothing in publish-input.json is trusted to name files,
 * and a failed upload or pull request update leaves the run usable.
 */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ConfigInput, resolveConfig } from '../core/config.ts';
import { MergeStoryError } from '../core/errors.ts';
import type { PublishBundle, Publisher } from '../core/providers.ts';
import { PublishInputSchema, parseRunJson, type StoredPublishInput } from '../core/run-folder.ts';
import type { GenerateResult, PublishResult } from '../core/types.ts';
import { GitHubClient, updatePullRequestDescription, upsertPullRequestComment } from '../github/index.ts';
import { createPublisher } from '../publish/index.ts';
import { pageData } from '../testing/publish.ts';
import { publishRun } from './index.ts';
import { decidePullRequestUpdate, dependsOnPublicRepository } from './publish-run.ts';

vi.mock('../publish/index.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../publish/index.ts')>()),
  createPublisher: vi.fn(),
}));
vi.mock('../github/index.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../github/index.ts')>()),
  upsertPullRequestComment: vi.fn(),
  updatePullRequestDescription: vi.fn(),
  GitHubClient: { create: vi.fn() },
}));

const RUN_ID = '20261104-101500-a1b2';
const PR_URL = 'https://github.com/example/weather/pull/42';
const publisherMock = vi.mocked(createPublisher);
const commentMock = vi.mocked(upsertPullRequestComment);
const descriptionMock = vi.mocked(updatePullRequestDescription);
const clientMock = vi.mocked(GitHubClient.create);

const uploaded: PublishResult = {
  provider: 's3',
  watchUrl: 'https://videos.example.com/mergestory/v/0123456789abcdef0123456789abcdef/index.html',
  videoUrl: 'https://videos.example.com/mergestory/v/0123456789abcdef0123456789abcdef/video.mp4',
  posterUrl: null,
  captionsUrl: null,
  expiresAt: null,
  visibility: 'protected',
  location: 's3://media/mergestory/v/0123456789abcdef0123456789abcdef/',
};

const S3: ConfigInput = {
  publish: {
    provider: 's3',
    visibility: 'protected',
    s3: { bucket: 'media', publicBaseUrl: 'https://videos.example.com' },
  },
};
const PUBLIC: ConfigInput = {
  publish: {
    provider: 's3',
    visibility: 'public',
    s3: { bucket: 'media', publicBaseUrl: 'https://videos.example.com' },
  },
};

let root: string;
let runDir: string;
let received: PublishBundle[];

function watchData(): StoredPublishInput['watch'] {
  return pageData({
    title: 'Add retries to the uploader',
    summary: 'Failed uploads are retried.',
    changeLabel: 'PR #42',
    changeUrl: PR_URL,
    headSha: '3f9c2ab1d0e49b7a55c3',
    durationSec: 83,
    chapters: [{ title: 'The mission', startSec: 0 }],
  });
}

function storedInput(overrides: Partial<StoredPublishInput> = {}): StoredPublishInput {
  return {
    version: 1,
    runId: RUN_ID,
    source: 'github',
    prUrl: PR_URL,
    repoIsPrivate: true,
    headSha: '3f9c2ab1d0e49b7a55c3',
    language: 'en',
    watch: watchData(),
    ...overrides,
  };
}

async function writeRun(stored: unknown = storedInput(), withResult = true): Promise<void> {
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'video.mp4'), Buffer.alloc(2048, 7));
  await writeFile(join(runDir, 'poster.jpg'), 'POSTER');
  await writeFile(join(runDir, 'captions.vtt'), 'WEBVTT\n\n00:00.000 --> 00:02.000\nHello\n');
  await writeFile(join(runDir, 'publish-input.json'), JSON.stringify(stored));
  if (!withResult) return;
  const previous: GenerateResult = {
    ok: true,
    runId: RUN_ID,
    runDir,
    title: 'Add retries to the uploader',
    summary: 'Failed uploads are retried.',
    durationSec: 83,
    chapters: [{ title: 'The mission', startSec: 0 }],
    storyboardSource: 'heuristic',
    files: {
      video: join(runDir, 'video.mp4'),
      poster: join(runDir, 'poster.jpg'),
      captions: join(runDir, 'captions.vtt'),
      storyboard: join(runDir, 'storyboard.json'),
      watchPage: join(runDir, 'watch', 'index.html'),
    },
    publish: null,
    notify: null,
    grounding: { groundedClaims: 3, fixes: [], warnings: [] },
    cost: { totalUsd: 0.01, budgetUsd: 0.25, records: [] },
    egress: [],
    warnings: ['Earlier warning'],
  };
  await writeFile(join(runDir, 'result.json'), JSON.stringify(previous));
}

function publisher(outcome: 'ok' | Error = 'ok'): Publisher {
  return {
    id: 's3',
    check: async () => null,
    plannedEgress: () => [],
    publish: async (bundle, ctx) => {
      received.push(bundle);
      ctx.egress.record('videos.example.com', 'video upload', 2048, ['video']);
      if (outcome !== 'ok') throw outcome;
      return uploaded;
    },
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mergestory-publish-run-'));
  runDir = join(root, 'home', 'runs', RUN_ID);
  received = [];
  vi.stubEnv('MERGESTORY_HOME', join(root, 'home'));
  for (const mock of [publisherMock, commentMock, descriptionMock, clientMock]) mock.mockReset();
  publisherMock.mockReturnValue(publisher());
  commentMock.mockResolvedValue({ url: `${PR_URL}#issuecomment-1`, created: true });
  descriptionMock.mockResolvedValue(undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const publish = (config: ConfigInput = S3) =>
  publishRun({ run: runDir, config: { home: join(root, 'home'), ...config } });
const resultFile = async () =>
  JSON.parse(await readFile(join(runDir, 'result.json'), 'utf8')) as GenerateResult;

async function failure(promise: Promise<unknown>): Promise<MergeStoryError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(MergeStoryError);
    return error as MergeStoryError;
  }
  throw new Error('expected an error');
}

describe('the files that are uploaded', () => {
  it('are the fixed names in the run folder, whatever publish-input.json says', async () => {
    const secret = join(root, 'credentials');
    await writeFile(secret, 'aws_secret_access_key = very-secret');
    await writeRun({ ...storedInput(), files: { video: secret, poster: secret, captions: secret } });
    await publish();
    const [bundle] = received;
    expect(bundle?.files.map((f) => f.name)).toEqual(['video.mp4', 'poster.jpg', 'captions.vtt']);
    for (const file of bundle?.files ?? []) {
      expect(file.path.endsWith(`${RUN_ID}/${file.name}`), file.path).toBe(true);
      expect(file.path).not.toContain('credentials');
    }
  });

  it('are refused when a name in the folder leads outside of it, and nothing is uploaded', async () => {
    const secret = join(root, 'credentials');
    await writeFile(secret, 'aws_secret_access_key = very-secret');
    for (const name of ['captions.vtt', 'poster.jpg', 'video.mp4']) {
      await rm(runDir, { recursive: true, force: true });
      await writeRun();
      await rm(join(runDir, name));
      await symlink(secret, join(runDir, name));
      const error = await failure(publish());
      expect(error.code, name).toBe('PRIVACY_BLOCKED');
      expect(error.message).toContain(`${name} in the run folder leads outside the folder`);
    }
    expect(received).toEqual([]);
  });

  it('may be links to other files inside the folder', async () => {
    await writeRun();
    await rm(join(runDir, 'captions.vtt'));
    await writeFile(join(runDir, 'subtitles.txt'), 'WEBVTT\n');
    await symlink(join(runDir, 'subtitles.txt'), join(runDir, 'captions.vtt'));
    await publish();
    expect(received[0]?.files.map((f) => f.name)).toContain('captions.vtt');
  });

  it('leave out a poster or captions that are not there, but need the video', async () => {
    await writeRun();
    await rm(join(runDir, 'poster.jpg'));
    await rm(join(runDir, 'captions.vtt'));
    await publish();
    expect(received[0]?.files.map((f) => f.name)).toEqual(['video.mp4']);
    await rm(join(runDir, 'video.mp4'));
    const error = await failure(publish());
    expect(error.code).toBe('SOURCE_NOT_FOUND');
    expect(error.message).toBe('This run has no video.mp4.');
  });
});

describe('what publish-input.json says about the repository', () => {
  const bundlePrivacy = () => received.at(-1)?.repoIsPrivate;

  it('is believed when it says private, and needs no question to GitHub for that', async () => {
    await writeRun(storedInput({ repoIsPrivate: true }));
    await publish(PUBLIC);
    expect(bundlePrivacy()).toBe(true);
    expect(clientMock).not.toHaveBeenCalled();
  });

  it('is not believed when it says public: GitHub is asked again, and only public links need the answer', async () => {
    await writeRun(storedInput({ repoIsPrivate: false }));
    clientMock.mockResolvedValue({ getRepo: async () => ({ isPrivate: false }) } as unknown as GitHubClient);
    await publish(PUBLIC);
    expect(bundlePrivacy()).toBe(false);
    expect(clientMock).toHaveBeenCalledTimes(1);

    // The repository is private after all: the file was wrong.
    clientMock.mockResolvedValue({ getRepo: async () => ({ isPrivate: true }) } as unknown as GitHubClient);
    await publish(PUBLIC);
    expect(bundlePrivacy()).toBe(true);

    // Protected links do not depend on it, so GitHub is not asked and the answer stays unknown.
    clientMock.mockClear();
    received = [];
    await publish(S3);
    expect(clientMock).not.toHaveBeenCalled();
    expect(bundlePrivacy()).toBeNull();
  });

  it('counts as unknown when GitHub cannot say, or the file names no pull request', async () => {
    await writeRun(storedInput({ repoIsPrivate: false }));
    clientMock.mockRejectedValue(new MergeStoryError('GITHUB_FAILED', 'GitHub is down'));
    await publish(PUBLIC);
    expect(bundlePrivacy()).toBeNull();

    clientMock.mockResolvedValue({ getRepo: async () => ({ isPrivate: null }) } as unknown as GitHubClient);
    await publish(PUBLIC);
    expect(bundlePrivacy()).toBeNull();

    clientMock.mockClear();
    await writeRun(storedInput({ repoIsPrivate: false, source: 'local', prUrl: null }));
    await publish(PUBLIC);
    expect(bundlePrivacy()).toBeNull();
    expect(clientMock).not.toHaveBeenCalled();
  });
});

describe('a file that is not a MergeStory run file', () => {
  it('is refused with a clear message', async () => {
    for (const broken of [
      { ...storedInput(), version: 2 },
      { ...storedInput(), runId: 42 },
      { ...storedInput(), source: 'ftp' },
      { ...storedInput(), watch: { title: 'x' } },
      { ...storedInput(), repoIsPrivate: 'no' },
      [],
      'text',
    ]) {
      expect(
        () => parseRunJson(broken, PublishInputSchema, 'publish-input.json'),
        JSON.stringify(broken).slice(0, 40),
      ).toThrow(/publish-input.json is not a MergeStory run file/);
    }
    expect(parseRunJson(storedInput(), PublishInputSchema, 'publish-input.json').runId).toBe(RUN_ID);
    await writeRun({ ...storedInput(), version: 2 });
    expect((await failure(publish())).code).toBe('SOURCE_INVALID');
  });

  it('is refused as SOURCE_INVALID when it is not JSON at all', async () => {
    await writeRun();
    await writeFile(join(runDir, 'publish-input.json'), '{ not json');
    const error = await failure(publish());
    expect(error.code).toBe('SOURCE_INVALID');
    expect(error.message).toMatch(/publish-input.json is not a MergeStory run file \(not valid JSON\)/);
  });
});

describe('a run folder made before the watch data held the caption settings', () => {
  /** The page that the upload would carry, for an upload of this run. */
  async function pageOf(stored: unknown, renderPlan?: unknown): Promise<string> {
    await writeRun(stored);
    if (renderPlan !== undefined)
      await writeFile(join(runDir, 'render-plan.json'), JSON.stringify(renderPlan));
    await publish();
    const cues = [{ startSec: 0, endSec: 2, text: 'Hello' }];
    const urls = {
      video: 'video.mp4',
      poster: null,
      captions: 'captions.vtt',
      linkExpiresAt: null,
      captionCues: cues,
    };
    return received[0]?.buildWatchPage(urls) ?? '';
  }
  const old = (language?: string) => {
    const { language: _language, captionsDefault: _captions, ...watch } = watchData();
    return storedInput({ language: language ?? 'de', watch: watch as StoredPublishInput['watch'] });
  };

  it('takes the caption language from the narration language of the run', async () => {
    expect(await pageOf(old('de'))).toContain('data-lang="de"');
  });

  it('keeps the caption track off when the render plan says the captions are in the video', async () => {
    expect(await pageOf(old(), { captions: { enabled: true, cues: [] } })).toContain('data-show="false"');
  });

  it('leaves the caption track on when the captions were not drawn, or nothing says so', async () => {
    expect(await pageOf(old(), { captions: { enabled: false, cues: [] } })).toContain('data-show="true"');
    expect(await pageOf(old(), '{ broken')).toContain('data-show="true"');
  });

  it('keeps what the watch data says when it has the settings', async () => {
    const stored = storedInput({ watch: { ...watchData(), language: 'fr', captionsDefault: true } });
    const page = await pageOf(stored, { captions: { enabled: true, cues: [] } });
    expect(page).toContain('data-lang="fr"');
    expect(page).toContain('data-show="true"');
  });
});

describe('a pull request update that fails', () => {
  const PR_CONFIG: ConfigInput = { ...S3, github: { comment: true } };

  it('is a warning: the video is published, its link is kept and saved, and the way to try again is given', async () => {
    await writeRun();
    commentMock.mockRejectedValue(
      new MergeStoryError(
        'NOTIFY_FAILED',
        'Could not write to GitHub. Resource not accessible by integration.',
        {
          hint: 'Give the token the pull-requests: write permission.',
        },
      ),
    );
    const result = await publish(PR_CONFIG);
    expect(result.publish).toEqual(uploaded);
    expect(result.notify).toEqual({ commentUrl: null, descriptionUpdated: false });
    const warning = result.warnings.find((w) => w.startsWith('The pull request was not updated:'));
    expect(warning).toContain('Resource not accessible by integration.');
    expect(warning).toContain('Give the token the pull-requests: write permission.');
    expect(warning).toContain('The video itself is published.');
    expect(warning).toContain(`mergestory publish ${runDir} --publish s3 --visibility protected --comment`);
    expect(warning).toContain('this uploads the video again');
    expect((await resultFile()).publish).toEqual(uploaded);
  });

  it('keeps what worked when only the description fails', async () => {
    await writeRun();
    descriptionMock.mockRejectedValue(new MergeStoryError('NOTIFY_FAILED', 'The description is too long.'));
    const result = await publish({ ...S3, github: { comment: true, updateDescription: true } });
    expect(result.notify).toEqual({ commentUrl: `${PR_URL}#issuecomment-1`, descriptionUpdated: false });
    expect(result.warnings.some((w) => w.startsWith('The pull request was not updated:'))).toBe(true);
  });

  it('is replaced, not repeated, when the next attempt works', async () => {
    await writeRun();
    commentMock.mockRejectedValueOnce(new MergeStoryError('NOTIFY_FAILED', 'Forbidden.'));
    await publish(PR_CONFIG);
    const retried = await publish(PR_CONFIG);
    expect(retried.notify?.commentUrl).toBe(`${PR_URL}#issuecomment-1`);
    expect(retried.warnings).toEqual(['Earlier warning']);
    expect((await resultFile()).warnings).toEqual(['Earlier warning']);
  });
});

describe('an upload that fails', () => {
  it('is reported as it is, and what was sent before it failed is saved', async () => {
    await writeRun();
    publisherMock.mockReturnValue(
      publisher(
        new MergeStoryError('PUBLISH_FAILED', 'The upload of video.mp4 stalled.', { retryable: true }),
      ),
    );
    const error = await failure(publish());
    expect(error.code).toBe('PUBLISH_FAILED');
    expect(error.message).toBe('The upload of video.mp4 stalled.');
    const saved = await resultFile();
    expect(saved.publish).toBeNull();
    expect(saved.egress.map((e) => e.purpose)).toEqual(['video upload']);
    expect(saved.cost.totalUsd).toBe(0.01);
  });
});

describe('a run that has no result.json', () => {
  it('is rebuilt from publish-input.json, with a note', async () => {
    await writeRun(storedInput(), false);
    const result = await publish();
    expect(result.publish).toEqual(uploaded);
    expect(result).toMatchObject({
      title: 'Add retries to the uploader',
      durationSec: 83,
      runDir,
      files: { video: join(runDir, 'video.mp4') },
    });
    expect(result.warnings[0]).toContain('was not found');
    expect((await resultFile()).publish).toEqual(uploaded);

    // A damaged file is treated the same way.
    await writeFile(join(runDir, 'result.json'), '{"ok": tr');
    expect((await publish()).warnings[0]).toContain('was not found');
  });
});

describe('the time a run took', () => {
  it('is kept when publish rewrites result.json, and a result from 1.0.0 without it still publishes', async () => {
    await writeRun();
    const old = await resultFile();
    expect((await publish()).elapsedSec).toBeUndefined();
    await writeFile(join(runDir, 'result.json'), JSON.stringify({ ...old, elapsedSec: 92.4 }));
    expect((await publish()).elapsedSec).toBe(92.4);
    expect((await resultFile()).elapsedSec).toBe(92.4);
  });
});

describe('decidePullRequestUpdate', () => {
  const asked = (github: NonNullable<ConfigInput['github']>) =>
    resolveConfig({ skipFile: true, env: {}, overrides: { github } });
  const change = { source: 'github' as const, prUrl: PR_URL };

  it('updates the pull request when a comment or a description was asked for, and the video is shared', () => {
    for (const github of [
      { comment: true },
      { updateDescription: true },
      { comment: true, updateDescription: true },
    ]) {
      expect(decidePullRequestUpdate(asked(github), change, 's3')).toEqual({ kind: 'update', prUrl: PR_URL });
      expect(decidePullRequestUpdate(asked(github), change, 'youtube')).toEqual({
        kind: 'update',
        prUrl: PR_URL,
      });
    }
  });

  it('does nothing when nothing was asked for, whatever else is true', () => {
    const quiet = asked({ comment: false, updateDescription: false });
    for (const where of ['s3', 'local', null]) {
      expect(decidePullRequestUpdate(quiet, change, where)).toEqual({ kind: 'not-requested' });
      expect(decidePullRequestUpdate(quiet, { source: 'local', prUrl: null }, where)).toEqual({
        kind: 'not-requested',
      });
    }
  });

  it('says so when the change does not come from a pull request, before it looks at the video', () => {
    const config = asked({ comment: true });
    expect(decidePullRequestUpdate(config, { source: 'local', prUrl: null }, 's3')).toEqual({
      kind: 'not-a-pull-request',
    });
    expect(decidePullRequestUpdate(config, { source: 'github', prUrl: null }, 's3')).toEqual({
      kind: 'not-a-pull-request',
    });
    expect(decidePullRequestUpdate(config, { source: 'local', prUrl: PR_URL }, null)).toEqual({
      kind: 'not-a-pull-request',
    });
  });

  it('never links to a video that stays on this machine', () => {
    const config = asked({ comment: true });
    for (const where of ['local', null]) {
      expect(decidePullRequestUpdate(config, change, where)).toEqual({ kind: 'video-stays-local' });
    }
  });
});

describe('dependsOnPublicRepository', () => {
  const settings = (publish: NonNullable<ConfigInput['publish']>) =>
    resolveConfig({ skipFile: true, env: {}, overrides: { publish } });

  it('counts only links that anyone can open', () => {
    expect(dependsOnPublicRepository(settings({ provider: 'drive', visibility: 'public' }))).toBe(true);
    expect(dependsOnPublicRepository(settings({ provider: 'drive', visibility: 'protected' }))).toBe(false);
    expect(dependsOnPublicRepository(settings({ provider: 'drive', visibility: 'private' }))).toBe(false);
    expect(dependsOnPublicRepository(settings({ provider: 's3', visibility: 'public' }))).toBe(true);
    expect(dependsOnPublicRepository(settings({ provider: 'local' }))).toBe(false);
  });
});
