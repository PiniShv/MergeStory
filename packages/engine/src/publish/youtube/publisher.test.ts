import { chmod, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigInput, SecretName } from '../../core/config.ts';
import { MergeStoryError } from '../../core/errors.ts';
import type { ProgressEvent, PublishResult } from '../../core/types.ts';
import { type TestContextOptions, testContext } from '../../testing/context.ts';
import { publishMeta } from '../../testing/publish.ts';
import {
  type BundleOptions,
  FAKE_CLIENT_ID,
  FAKE_CLIENT_SECRET,
  FAKE_REFRESH_TOKEN,
  FAKE_VIDEO_ID,
  FAST_TIMING,
  type FakeGoogle,
  type FakeGoogleOptions,
  FORCE_SSL_SCOPE,
  googleError,
  makeBundle,
  makeTempDir,
  removeDir,
  startFakeGoogle,
  UPLOAD_SCOPE,
} from '../../testing/youtube.ts';
import { createPublisher } from '../index.ts';
import { credentialsPath, writeCredentialsFile } from './credentials.ts';
import { utf8Length } from './description.ts';
import { createYouTubePublisher, YouTubePublisher } from './publisher.ts';
import { CHUNK_UNIT } from './upload.ts';

const SECRETS: Partial<Record<SecretName, string>> = {
  MERGESTORY_YOUTUBE_CLIENT_ID: FAKE_CLIENT_ID,
  MERGESTORY_YOUTUBE_CLIENT_SECRET: FAKE_CLIENT_SECRET,
  MERGESTORY_YOUTUBE_REFRESH_TOKEN: FAKE_REFRESH_TOKEN,
};

let dir: string;
const fakes: FakeGoogle[] = [];

beforeEach(async () => {
  dir = await makeTempDir('mergestory-publisher-');
});

afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.stop()));
  await removeDir(dir);
});

interface SetupOptions {
  fake?: FakeGoogleOptions;
  youtube?: NonNullable<NonNullable<ConfigInput['publish']>['youtube']>;
  allowPublicForPrivateRepos?: boolean;
  secrets?: Partial<Record<SecretName, string>>;
  bundle?: BundleOptions;
  dryRun?: boolean;
  signal?: AbortSignal;
  onProgress?: TestContextOptions['onProgress'];
}

async function setup(options: SetupOptions = {}) {
  const fake = await startFakeGoogle(options.fake);
  fakes.push(fake);
  const t = testContext({
    home: dir,
    runId: 'run-1',
    captureLogs: true,
    config: {
      publish: {
        provider: 'youtube',
        ...(options.allowPublicForPrivateRepos === undefined
          ? {}
          : { allowPublicForPrivateRepos: options.allowPublicForPrivateRepos }),
        youtube: options.youtube ?? {},
      },
    },
    secrets: options.secrets ?? SECRETS,
    dryRun: options.dryRun,
    signal: options.signal,
    onProgress: options.onProgress,
  });
  const publisher = new YouTubePublisher(t.ctx.config, {
    endpoints: { apiBase: fake.url, tokenUrl: `${fake.url}/token` },
    timing: FAST_TIMING,
    chunkBytes: CHUNK_UNIT,
  });
  const { bundle, video } = await makeBundle(join(dir, 'render'), options.bundle);
  const { events: progress, ...rest } = t;
  return { fake, ...rest, progress, publisher, bundle, video };
}

const VIDEO_BYTES = 600 * 1024;
/** The request that carries the last byte of the video. */
const isFinalChunk = (r: { method: string; path: string; headers: Record<string, unknown> }): boolean =>
  r.method === 'PUT' &&
  r.path === '/upload/youtube/v3/videos' &&
  String(r.headers['content-range']).endsWith(`-${VIDEO_BYTES - 1}/${VIDEO_BYTES}`);
const warnings = (progress: ProgressEvent[]) =>
  progress.filter((event) => event.status === 'warn').map((event) => event.message);
const isVideoStart = (r: { method: string; path: string }) =>
  r.method === 'POST' && r.path === '/upload/youtube/v3/videos';

async function failure(promise: Promise<unknown>): Promise<MergeStoryError> {
  const error = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(MergeStoryError);
  return error as MergeStoryError;
}

describe('dry runs', () => {
  it('refuses to upload and touches nothing', async () => {
    const { publisher, bundle, ctx, fake } = await setup({ dryRun: true });
    const error = await failure(publisher.publish(bundle, ctx));
    expect(error.code).toBe('PUBLISH_FAILED');
    expect(error.message).toContain('dry run');
    expect(fake.requests).toEqual([]);
  });
});

describe('the privacy guard', () => {
  const blocked = async (options: SetupOptions) => {
    // No sign-in is configured: the guard must fire before credentials are even looked up.
    const { publisher, bundle, ctx, fake } = await setup({ ...options, secrets: {} });
    const error = await failure(publisher.publish(bundle, ctx));
    expect(fake.requests).toEqual([]);
    return error;
  };

  it('blocks an unlisted video of a private repository', async () => {
    const error = await blocked({ bundle: { repoIsPrivate: true }, youtube: { privacyStatus: 'unlisted' } });
    expect(error.code).toBe('PRIVACY_BLOCKED');
    expect(error.message).toContain('private');
    expect(error.hint).toContain('publish.youtube.privacyStatus');
    expect(error.hint).toContain('publish.allowPublicForPrivateRepos');
  });

  it('blocks a public video of a private repository', async () => {
    expect(
      (await blocked({ bundle: { repoIsPrivate: true }, youtube: { privacyStatus: 'public' } })).code,
    ).toBe('PRIVACY_BLOCKED');
  });

  it('blocks when the repository may be private (unknown), unless the video is private', async () => {
    const error = await blocked({ bundle: { repoIsPrivate: null }, youtube: { privacyStatus: 'unlisted' } });
    expect(error.code).toBe('PRIVACY_BLOCKED');
    expect(error.message).toContain('cannot tell');
  });

  it('uses the default privacy (unlisted), so a private repository is blocked by default', async () => {
    expect((await blocked({ bundle: { repoIsPrivate: true } })).code).toBe('PRIVACY_BLOCKED');
  });

  it('allows a private video of a private or unknown repository', async () => {
    for (const repoIsPrivate of [true, null]) {
      const { publisher, bundle, ctx } = await setup({
        bundle: { repoIsPrivate },
        youtube: { privacyStatus: 'private' },
      });
      const result = await publisher.publish(bundle, ctx);
      expect(result.visibility).toBe('private');
    }
  });

  it('allows a video of a private repository with the explicit opt-in', async () => {
    const { publisher, bundle, ctx } = await setup({
      bundle: { repoIsPrivate: true },
      youtube: { privacyStatus: 'unlisted' },
      allowPublicForPrivateRepos: true,
    });
    expect((await publisher.publish(bundle, ctx)).visibility).toBe('unlisted');
  });

  it('allows any privacy for a public repository', async () => {
    for (const privacyStatus of ['private', 'unlisted', 'public'] as const) {
      const { publisher, bundle, ctx } = await setup({
        bundle: { repoIsPrivate: false },
        youtube: { privacyStatus },
      });
      expect((await publisher.publish(bundle, ctx)).visibility).toBe(privacyStatus);
    }
  });

  it('treats a bundle that does not say as unknown', async () => {
    const { publisher, bundle, ctx } = await setup({ secrets: {} });
    delete (bundle as { repoIsPrivate?: boolean | null }).repoIsPrivate;
    expect((await failure(publisher.publish(bundle, ctx))).code).toBe('PRIVACY_BLOCKED');
  });
});

describe('YouTubePublisher.check', () => {
  it('finds nothing to complain about when the video may be shown and a sign-in exists', async () => {
    for (const [repoIsPrivate, privacyStatus] of [
      [false, 'unlisted'],
      [false, 'public'],
      [true, 'private'],
      [null, 'private'],
    ] as const) {
      const { publisher, ctx } = await setup({ youtube: { privacyStatus } });
      expect(await publisher.check(ctx, repoIsPrivate), `${repoIsPrivate} ${privacyStatus}`).toBeNull();
    }
    const allowed = await setup({ youtube: { privacyStatus: 'unlisted' }, allowPublicForPrivateRepos: true });
    expect(await allowed.publisher.check(allowed.ctx, true)).toBeNull();
  });

  it('blocks a video that others can open for a private repository, or one that cannot be told apart', async () => {
    const { publisher, ctx } = await setup({ youtube: { privacyStatus: 'unlisted' } });
    const privateRepo = await publisher.check(ctx, true);
    expect(privateRepo?.code).toBe('PRIVACY_BLOCKED');
    expect(privateRepo?.message).toBe(
      'This repository is private, so a YouTube video that others can open is blocked.',
    );
    expect(privateRepo?.hint).toContain('publish.youtube.privacyStatus');
    expect((await publisher.check(ctx, null))?.message).toContain(
      'cannot tell whether this repository is private',
    );
  });

  it('wants a sign-in once the privacy rule is met, and asks for the privacy rule first', async () => {
    const noSignIn = await setup({ youtube: { privacyStatus: 'private' }, secrets: {} });
    const missing = await noSignIn.publisher.check(noSignIn.ctx, true);
    expect(missing?.code).toBe('CONFIG_INVALID');
    expect(missing?.message).toBe('No YouTube sign-in was found.');
    const blockedFirst = await setup({ youtube: { privacyStatus: 'unlisted' }, secrets: {} });
    expect((await blockedFirst.publisher.check(blockedFirst.ctx, true))?.code).toBe('PRIVACY_BLOCKED');
  });

  it('applies the rules of the saved sign-in, as the upload does', async () => {
    const saved = {
      clientId: FAKE_CLIENT_ID,
      clientSecret: FAKE_CLIENT_SECRET,
      refreshToken: FAKE_REFRESH_TOKEN,
      scope: UPLOAD_SCOPE,
      createdAt: null,
    };
    const fromFile = await setup({ secrets: {} });
    await writeCredentialsFile(credentialsPath(dir), saved);
    expect(await fromFile.publisher.check(fromFile.ctx, false)).toBeNull();
    // A client id from the environment must be the one the saved sign-in was made with.
    const other = await setup({
      secrets: { MERGESTORY_YOUTUBE_CLIENT_ID: 'another-client.apps.googleusercontent.com' },
    });
    expect((await other.publisher.check(other.ctx, false))?.message).toBe(
      'MERGESTORY_YOUTUBE_CLIENT_ID is not the client the saved sign-in was made with.',
    );
    if (process.platform !== 'win32') {
      await chmod(credentialsPath(dir), 0o644);
      const open = await setup({ secrets: {} });
      expect((await open.publisher.check(open.ctx, false))?.message).toContain('other users');
    }
  });

  it('is what publish() throws first, before any request', async () => {
    for (const options of [
      { bundle: { repoIsPrivate: true }, youtube: { privacyStatus: 'unlisted' } },
      { bundle: { repoIsPrivate: false }, secrets: {} },
    ] as const) {
      const { publisher, bundle, ctx, fake } = await setup(options);
      const problem = await publisher.check(ctx, bundle.repoIsPrivate ?? null);
      const error = await failure(publisher.publish(bundle, ctx));
      expect(error).toMatchObject({ code: problem?.code, message: problem?.message, hint: problem?.hint });
      expect(fake.requests).toEqual([]);
    }
  });
});

describe('YouTubePublisher.plannedEgress', () => {
  it('lists the upload to the host of the Google API, with what a bundle carries', async () => {
    const { ctx } = await setup();
    expect(createYouTubePublisher(ctx.config).plannedEgress(7_000_000)).toEqual([
      {
        destination: 'www.googleapis.com',
        purpose: 'video upload',
        bytes: 7_000_000,
        contains: ['video', 'narration-text', 'storyboard', 'pr-metadata'],
      },
    ]);
  });

  it('names the host that the upload really goes to', async () => {
    const { ctx } = await setup();
    const publisher = new YouTubePublisher(ctx.config, { endpoints: { apiBase: 'http://127.0.0.1:9999' } });
    expect(publisher.plannedEgress(1)[0]?.destination).toBe('127.0.0.1');
  });
});

describe('a bundle without text for YouTube', () => {
  it('is refused, with a hint', async () => {
    const { publisher, bundle, ctx, fake } = await setup({ bundle: { meta: null } });
    const error = await failure(publisher.publish(bundle, ctx));
    expect(error.code).toBe('PUBLISH_FAILED');
    expect(error.message).toContain('title and description');
    expect(fake.requests).toEqual([]);
  });
});

describe('sign-in problems', () => {
  it('asks the person to run setup when there is no sign-in', async () => {
    const { publisher, bundle, ctx, fake } = await setup({ secrets: {} });
    const error = await failure(publisher.publish(bundle, ctx));
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.hint).toContain('mergestory setup youtube');
    expect(fake.requests).toEqual([]);
  });

  it('maps an expired or revoked refresh token to CONFIG_INVALID and mentions the 7-day Testing expiry', async () => {
    const { publisher, bundle, ctx, fake } = await setup({
      secrets: { ...SECRETS, MERGESTORY_YOUTUBE_REFRESH_TOKEN: 'a-revoked-refresh-token-0000' },
    });
    const error = await failure(publisher.publish(bundle, ctx));
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.hint).toContain('mergestory setup youtube');
    expect(error.hint).toContain('7 days');
    expect(fake.requestsTo('POST', '/upload/youtube/v3/videos')).toEqual([]);
  });

  it('maps a rejected access token (401) to CONFIG_INVALID', async () => {
    const { publisher, bundle, ctx, fake } = await setup();
    fake.intercept((r) => isVideoStart(r), googleError(401, 'authError', 'Invalid Credentials'), 5);
    const error = await failure(publisher.publish(bundle, ctx));
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.hint).toContain('mergestory setup youtube');
    expect(error.hint).toContain('Testing');
    // One new token was tried before giving up.
    expect(fake.tokensIssued).toBe(2);
  });

  it('maps a wrong client to CONFIG_INVALID', async () => {
    const { publisher, bundle, ctx } = await setup({
      secrets: { ...SECRETS, MERGESTORY_YOUTUBE_CLIENT_ID: 'other-client.apps.googleusercontent.com' },
    });
    const error = await failure(publisher.publish(bundle, ctx));
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toContain('client id or secret');
  });

  it('refuses a token that is not allowed to upload', async () => {
    const { publisher, bundle, ctx, fake } = await setup({
      fake: { scope: 'https://www.googleapis.com/auth/youtube.readonly' },
    });
    const error = await failure(publisher.publish(bundle, ctx));
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.hint).toContain('youtube.upload');
    expect(fake.requestsTo('POST', '/upload/youtube/v3/videos')).toEqual([]);
  });
});

describe('the saved sign-in file', () => {
  const saved = {
    clientId: FAKE_CLIENT_ID,
    clientSecret: FAKE_CLIENT_SECRET,
    refreshToken: FAKE_REFRESH_TOKEN,
    scope: UPLOAD_SCOPE,
    createdAt: '2026-11-04T10:00:00.000Z',
  };

  it('is used when the environment has no sign-in', async () => {
    const { publisher, bundle, ctx, fake } = await setup({ secrets: {} });
    await writeCredentialsFile(credentialsPath(dir), saved);
    const result = await publisher.publish(bundle, ctx);
    expect(result.provider).toBe('youtube');
    const form = new URLSearchParams(fake.requestsTo('POST', '/token')[0]?.body.toString('utf8'));
    expect(form.get('refresh_token')).toBe(FAKE_REFRESH_TOKEN);
    expect(form.get('client_secret')).toBe(FAKE_CLIENT_SECRET);
  });

  it.runIf(process.platform !== 'win32')(
    'is refused when other users can read it, before any network call',
    async () => {
      const { publisher, bundle, ctx, fake } = await setup({ secrets: {} });
      await writeCredentialsFile(credentialsPath(dir), saved);
      await chmod(credentialsPath(dir), 0o644);
      const error = await failure(publisher.publish(bundle, ctx));
      expect(error.code).toBe('CONFIG_INVALID');
      expect(error.message).toContain('other users');
      expect(error.hint).toContain('chmod 600');
      expect(fake.requests).toEqual([]);
    },
  );
});

describe('the upload', () => {
  it('sends the video with the details YouTube needs, and the privacy status explicitly', async () => {
    const { publisher, bundle, ctx, fake, video } = await setup();
    await publisher.publish(bundle, ctx);

    const [start] = fake.requestsTo('POST', '/upload/youtube/v3/videos');
    expect(start?.query.get('uploadType')).toBe('resumable');
    expect(start?.query.get('part')).toBe('snippet,status');
    expect(start?.query.get('notifySubscribers')).toBe('false');
    expect(start?.headers['x-upload-content-type']).toBe('video/mp4');
    expect(start?.headers['x-upload-content-length']).toBe(String(video.length));

    const sent = fake.sessionMetadata('video') as {
      snippet: Record<string, unknown>;
      status: Record<string, unknown>;
    };
    expect(sent.status).toEqual({
      privacyStatus: 'unlisted',
      selfDeclaredMadeForKids: false,
      embeddable: true,
    });
    expect(sent.snippet.title).toBe('Add retry with backoff');
    expect(sent.snippet.categoryId).toBe('28');
    expect(sent.snippet.defaultLanguage).toBe('en');
    expect(sent.snippet.tags).toEqual(['MergeStory', 'pull request', 'code review', 'weather']);
    expect(String(sent.snippet.description)).toContain('Failed forecast calls are retried');
    expect(Object.keys(sent.snippet).sort()).toEqual([
      'categoryId',
      'defaultLanguage',
      'description',
      'tags',
      'title',
    ]);
    expect(fake.uploaded('video').equals(video)).toBe(true);
  });

  it('sends the privacy status that is set, whatever it is', async () => {
    for (const privacyStatus of ['private', 'unlisted', 'public'] as const) {
      const { publisher, bundle, ctx, fake } = await setup({ youtube: { privacyStatus } });
      await publisher.publish(bundle, ctx);
      expect(
        (fake.sessionMetadata('video') as { status: { privacyStatus: string } }).status.privacyStatus,
      ).toBe(privacyStatus);
    }
  });

  it('uses the category from the settings', async () => {
    const { publisher, bundle, ctx, fake } = await setup({ youtube: { categoryId: '27' } });
    await publisher.publish(bundle, ctx);
    expect((fake.sessionMetadata('video') as { snippet: { categoryId: string } }).snippet.categoryId).toBe(
      '27',
    );
  });

  it('uploads in chunks of 256 KiB', async () => {
    const { publisher, bundle, ctx, fake, video } = await setup({ bundle: { videoBytes: 600 * 1024 } });
    await publisher.publish(bundle, ctx);
    const chunks = fake.requests.filter((r) => r.method === 'PUT' && r.path === '/upload/youtube/v3/videos');
    expect(chunks).toHaveLength(3);
    expect(chunks.slice(0, -1).every((r) => r.body.length === CHUNK_UNIT)).toBe(true);
    expect(fake.uploaded('video').equals(video)).toBe(true);
  });

  it('resumes an interrupted upload', async () => {
    const { publisher, bundle, ctx, fake, video } = await setup();
    fake.intercept(
      (r) => r.method === 'PUT' && String(r.headers['content-range']).startsWith(`bytes ${CHUNK_UNIT}-`),
      { kind: 'store-then-drop', storeBytes: 70_000 },
    );
    const result = await publisher.publish(bundle, ctx);
    expect(result.location).toBe(`youtube:${FAKE_VIDEO_ID}`);
    expect(fake.uploaded('video').equals(video)).toBe(true);
  });

  it('returns the links and the visibility', async () => {
    const { publisher, bundle, ctx } = await setup();
    const result: PublishResult = await publisher.publish(bundle, ctx);
    expect(result).toEqual({
      provider: 'youtube',
      watchUrl: `https://www.youtube.com/watch?v=${FAKE_VIDEO_ID}`,
      videoUrl: `https://www.youtube.com/watch?v=${FAKE_VIDEO_ID}`,
      posterUrl: `https://i.ytimg.com/vi/${FAKE_VIDEO_ID}/hqdefault.jpg`,
      captionsUrl: null,
      expiresAt: null,
      visibility: 'unlisted',
      location: `youtube:${FAKE_VIDEO_ID}`,
    });
  });

  it('has no poster address for a private video', async () => {
    const { publisher, bundle, ctx } = await setup({ youtube: { privacyStatus: 'private' } });
    const result = await publisher.publish(bundle, ctx);
    expect(result.posterUrl).toBeNull();
    expect(result.visibility).toBe('private');
  });

  it('reports a public video as public', async () => {
    const { publisher, bundle, ctx } = await setup({ youtube: { privacyStatus: 'public' } });
    const result = await publisher.publish(bundle, ctx);
    expect(result.visibility).toBe('public');
    expect(result.posterUrl).toContain('i.ytimg.com');
  });

  it('signs in once and sends the token only in the Authorization header', async () => {
    const { publisher, bundle, ctx, fake } = await setup({ youtube: { setThumbnail: true } });
    await publisher.publish(bundle, ctx);
    expect(fake.tokensIssued).toBe(1);
    for (const request of fake.requests.filter((r) => r.path !== '/token')) {
      expect(request.headers.authorization).toBe(`Bearer ${fake.accessToken(1)}`);
      expect(`${request.path}?${request.query}`).not.toContain('ya29');
    }
    const [tokenRequest] = fake.requestsTo('POST', '/token');
    expect(tokenRequest?.query.size).toBe(0);
    const form = new URLSearchParams(tokenRequest?.body.toString('utf8'));
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe(FAKE_REFRESH_TOKEN);
  });

  it('keeps tokens and secrets out of the logs and progress messages', async () => {
    const { publisher, bundle, ctx, fake, logs, progress } = await setup({
      fake: { scope: FORCE_SSL_SCOPE },
      youtube: { uploadCaptions: true, playlistId: 'PLabcdefghijklmn' },
    });
    fake.intercept((r) => r.path === '/upload/youtube/v3/thumbnails/set', googleError(403, 'forbidden'));
    await publisher.publish(bundle, ctx);
    const everything = [...logs, ...progress.map((p) => p.message)].join('\n');
    expect(everything.length).toBeGreaterThan(0);
    for (const secret of [FAKE_REFRESH_TOKEN, FAKE_CLIENT_SECRET, fake.accessToken(1)]) {
      expect(everything).not.toContain(secret);
    }
    for (const sessionId of fake.sessions.keys()) expect(everything).not.toContain(sessionId);
  });

  it('reports progress while uploading', async () => {
    const { publisher, bundle, ctx, progress } = await setup();
    await publisher.publish(bundle, ctx);
    const events = progress.filter((e) => e.status === 'progress');
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.stage === 'publish' && (e.progress ?? 0) > 0 && (e.progress ?? 0) < 1)).toBe(
      true,
    );
  });
});

describe('the description', () => {
  const descriptionOf = (fake: FakeGoogle) =>
    String((fake.sessionMetadata('video') as { snippet: { description: string } }).snippet.description);

  it('makes chapters from timestamps when the video is long enough for them', async () => {
    const { publisher, bundle, ctx, fake } = await setup({
      bundle: { meta: publishMeta({ durationSec: 90 }) },
    });
    await publisher.publish(bundle, ctx);
    const description = descriptionOf(fake);
    expect(description).toContain(
      '00:00 Why this change\n00:12 The retry loop\n00:30 Tests\n00:55 What to review',
    );
  });

  it('uses a plain list when the last chapter would be shorter than ten seconds', async () => {
    const { publisher, bundle, ctx, fake } = await setup({
      bundle: { meta: publishMeta({ durationSec: 60 }) },
    });
    await publisher.publish(bundle, ctx);
    const description = descriptionOf(fake);
    expect(description).toContain('Chapters\n- Why this change\n- The retry loop\n- Tests\n- What to review');
    expect(description).not.toMatch(/\d\d:\d\d/);
  });

  it('includes the pull request link only when the repository is public', async () => {
    const pub = await setup({ bundle: { repoIsPrivate: false } });
    await pub.publisher.publish(pub.bundle, pub.ctx);
    expect(descriptionOf(pub.fake)).toContain('Pull request: https://github.com/example/weather/pull/482');

    const priv = await setup({ bundle: { repoIsPrivate: true }, youtube: { privacyStatus: 'private' } });
    await priv.publisher.publish(priv.bundle, priv.ctx);
    expect(descriptionOf(priv.fake)).not.toContain('github.com');
    expect(descriptionOf(priv.fake)).not.toContain('acme');

    const unknown = await setup({ bundle: { repoIsPrivate: null }, youtube: { privacyStatus: 'private' } });
    await unknown.publisher.publish(unknown.bundle, unknown.ctx);
    expect(descriptionOf(unknown.fake)).not.toContain('github.com');
    const tags = (unknown.fake.sessionMetadata('video') as { snippet: { tags: string[] } }).snippet.tags;
    expect(tags).not.toContain('weather');
  });

  it('keeps the title, description and tags within YouTube limits and free of < and >', async () => {
    const hostile = publishMeta({
      title: `<b>${'T'.repeat(300)}</b>`,
      summary: `${'<script>'.repeat(50)}${'ü'.repeat(4_000)}`,
      checklist: Array.from({ length: 40 }, (_, i) => ({ title: `Item ${i} <x>`, severity: 'low' as const })),
    });
    const { publisher, bundle, ctx, fake } = await setup({ bundle: { meta: hostile } });
    await publisher.publish(bundle, ctx);
    const { snippet } = fake.sessionMetadata('video') as {
      snippet: { title: string; description: string; tags: string[] };
    };
    expect(snippet.title.length).toBeLessThanOrEqual(100);
    expect(utf8Length(snippet.description)).toBeLessThanOrEqual(5_000);
    expect(JSON.stringify(snippet)).not.toMatch(/[<>]/);
    expect(
      snippet.description.endsWith('This video explains the change; it does not replace code review.'),
    ).toBe(true);
  });

  it('normalises the language code, and leaves out one it does not understand', async () => {
    const a = await setup({ bundle: { meta: publishMeta({ language: 'pt_BR' }) } });
    await a.publisher.publish(a.bundle, a.ctx);
    expect(
      (a.fake.sessionMetadata('video') as { snippet: { defaultLanguage: string } }).snippet.defaultLanguage,
    ).toBe('pt-BR');

    const b = await setup({ bundle: { meta: publishMeta({ language: 'not a language' }) } });
    await b.publisher.publish(b.bundle, b.ctx);
    expect(b.fake.sessionMetadata('video') as object).toHaveProperty('snippet');
    expect((b.fake.sessionMetadata('video') as { snippet: object }).snippet).not.toHaveProperty(
      'defaultLanguage',
    );
  });
});

describe('the thumbnail', () => {
  it('sets the poster as the thumbnail by default', async () => {
    const { publisher, bundle, ctx, fake } = await setup();
    await publisher.publish(bundle, ctx);
    const [request] = fake.requestsTo('POST', '/upload/youtube/v3/thumbnails/set');
    expect(request?.query.get('videoId')).toBe(FAKE_VIDEO_ID);
    expect(request?.query.get('uploadType')).toBe('media');
    expect(request?.headers['content-type']).toBe('image/jpeg');
    expect(request?.body.toString('utf8')).toBe('POSTER-BYTES');
  });

  it('sends a PNG poster as image/png', async () => {
    const { publisher, bundle, ctx, fake } = await setup({ bundle: { poster: 'poster.png' } });
    await publisher.publish(bundle, ctx);
    expect(fake.requestsTo('POST', '/upload/youtube/v3/thumbnails/set')[0]?.headers['content-type']).toBe(
      'image/png',
    );
  });

  it('is skipped when switched off or when there is no poster', async () => {
    const off = await setup({ youtube: { setThumbnail: false } });
    await off.publisher.publish(off.bundle, off.ctx);
    expect(off.fake.requestsTo('POST', '/upload/youtube/v3/thumbnails/set')).toEqual([]);

    const none = await setup({ bundle: { poster: false } });
    await none.publisher.publish(none.bundle, none.ctx);
    expect(none.fake.requestsTo('POST', '/upload/youtube/v3/thumbnails/set')).toEqual([]);
  });

  it('is skipped with a warning for a format YouTube does not take, or a file that is too big', async () => {
    const webp = await setup({ bundle: { poster: 'poster.webp' } });
    await webp.publisher.publish(webp.bundle, webp.ctx);
    expect(webp.fake.requestsTo('POST', '/upload/youtube/v3/thumbnails/set')).toEqual([]);
    expect(warnings(webp.progress).join('\n')).toContain('JPEG and PNG');

    const big = await setup();
    await truncate(join(dir, 'render', 'poster.jpg'), 51 * 1024 * 1024);
    await big.publisher.publish(big.bundle, big.ctx);
    expect(big.fake.requestsTo('POST', '/upload/youtube/v3/thumbnails/set')).toEqual([]);
    expect(warnings(big.progress).join('\n')).toContain('50 MB');
  });

  it('only warns when YouTube refuses it (for example on an unverified channel)', async () => {
    const { publisher, bundle, ctx, fake, progress } = await setup();
    fake.intercept((r) => r.path === '/upload/youtube/v3/thumbnails/set', googleError(403, 'forbidden'));
    const result = await publisher.publish(bundle, ctx);
    expect(result.watchUrl).toContain(FAKE_VIDEO_ID);
    const [warning] = warnings(progress);
    expect(warning).toContain('thumbnail failed');
    expect(warning).toContain('verified');
  });

  it('only warns when YouTube limits thumbnails (429)', async () => {
    const { publisher, bundle, ctx, fake, progress } = await setup();
    fake.intercept(
      (r) => r.path === '/upload/youtube/v3/thumbnails/set',
      googleError(429, 'uploadRateLimitExceeded'),
    );
    await publisher.publish(bundle, ctx);
    expect(fake.requestsTo('POST', '/upload/youtube/v3/thumbnails/set')).toHaveLength(1);
    expect(warnings(progress)).toHaveLength(1);
  });
});

describe('captions and playlists', () => {
  const both = { uploadCaptions: true, playlistId: 'PLabcdefghijklmn' } as const;

  it('are not touched by default', async () => {
    const { publisher, bundle, ctx, fake } = await setup();
    await publisher.publish(bundle, ctx);
    expect(fake.requestsTo('POST', '/upload/youtube/v3/captions')).toEqual([]);
    expect(fake.requestsTo('POST', '/youtube/v3/playlistItems')).toEqual([]);
  });

  it('upload the caption track and add the video to the playlist when switched on', async () => {
    const { publisher, bundle, ctx, fake, progress } = await setup({
      fake: { scope: FORCE_SSL_SCOPE },
      youtube: both,
    });
    await publisher.publish(bundle, ctx);

    const [start] = fake.requestsTo('POST', '/upload/youtube/v3/captions');
    expect(start?.query.get('uploadType')).toBe('resumable');
    expect(start?.query.get('part')).toBe('snippet');
    expect(start?.headers['x-upload-content-type']).toBe('application/octet-stream');
    expect(fake.sessionMetadata('captions')).toEqual({
      snippet: { videoId: FAKE_VIDEO_ID, language: 'en', name: 'English', isDraft: false },
    });
    expect(fake.uploaded('captions').toString('utf8')).toBe('WEBVTT\n\n00:00.000 --> 00:02.000\nHello\n');

    const [item] = fake.requestsTo('POST', '/youtube/v3/playlistItems');
    expect(item?.query.get('part')).toBe('snippet');
    expect(JSON.parse(item?.body.toString('utf8') ?? '')).toEqual({
      snippet: {
        playlistId: 'PLabcdefghijklmn',
        resourceId: { kind: 'youtube#video', videoId: FAKE_VIDEO_ID },
      },
    });
    expect(warnings(progress)).toEqual([]);
  });

  it('skip captions and playlists the saved sign-in cannot do, without calling YouTube', async () => {
    const { publisher, bundle, ctx, fake, progress } = await setup({
      fake: { scope: UPLOAD_SCOPE },
      youtube: both,
    });
    const result = await publisher.publish(bundle, ctx);
    expect(result.watchUrl).toContain(FAKE_VIDEO_ID);
    expect(fake.requestsTo('POST', '/upload/youtube/v3/captions')).toEqual([]);
    expect(fake.requestsTo('POST', '/youtube/v3/playlistItems')).toEqual([]);
    const text = warnings(progress).join('\n');
    expect(text).toContain('Skipped the captions');
    expect(text).toContain('youtube.force-ssl');
    expect(text).toContain('Skipped the playlist');
    expect(text).toContain('mergestory setup youtube');
  });

  it('skip captions when the bundle has no caption file', async () => {
    const { publisher, bundle, ctx, fake, progress } = await setup({
      fake: { scope: FORCE_SSL_SCOPE },
      youtube: { uploadCaptions: true },
      bundle: { captions: false },
    });
    await publisher.publish(bundle, ctx);
    expect(fake.requestsTo('POST', '/upload/youtube/v3/captions')).toEqual([]);
    expect(warnings(progress).join('\n')).toContain('no caption file');
  });

  it('skip an empty caption file', async () => {
    const { publisher, bundle, ctx, fake, progress } = await setup({
      fake: { scope: FORCE_SSL_SCOPE },
      youtube: { uploadCaptions: true },
    });
    await writeFile(join(dir, 'render', 'captions.vtt'), '');
    await publisher.publish(bundle, ctx);
    expect(fake.requestsTo('POST', '/upload/youtube/v3/captions')).toEqual([]);
    expect(warnings(progress).join('\n')).toContain('empty');
  });

  it('only warn when they fail, and still return the video', async () => {
    const { publisher, bundle, ctx, fake, progress } = await setup({
      fake: { scope: FORCE_SSL_SCOPE },
      youtube: both,
    });
    fake.intercept(
      (r) => r.method === 'POST' && r.path === '/upload/youtube/v3/captions',
      googleError(409, 'captionExists'),
    );
    fake.intercept((r) => r.path === '/youtube/v3/playlistItems', googleError(404, 'playlistNotFound'));
    const result = await publisher.publish(bundle, ctx);
    expect(result.location).toBe(`youtube:${FAKE_VIDEO_ID}`);
    const text = warnings(progress);
    expect(text).toHaveLength(2);
    expect(text[0]).toContain('captions failed');
    expect(text[1]).toContain('playlist entry failed');
  });

  it('use the language of the video for the caption track', async () => {
    const { publisher, bundle, ctx, fake } = await setup({
      fake: { scope: FORCE_SSL_SCOPE },
      youtube: { uploadCaptions: true },
      bundle: { meta: publishMeta({ language: 'de' }) },
    });
    await publisher.publish(bundle, ctx);
    expect(fake.sessionMetadata('captions')).toMatchObject({ snippet: { language: 'de', name: 'German' } });
  });
});

describe('what YouTube makes of the privacy status', () => {
  it('warns when YouTube makes the video more private than requested, and reports the real status', async () => {
    const { publisher, bundle, ctx, progress } = await setup({
      fake: { privacyStatus: 'private' },
      youtube: { privacyStatus: 'unlisted' },
    });
    const result = await publisher.publish(bundle, ctx);
    expect(result.visibility).toBe('private');
    expect(result.posterUrl).toBeNull();
    const [warning] = warnings(progress);
    expect(warning).toContain('"private" although "unlisted" was requested');
    expect(warning).toContain(`https://studio.youtube.com/video/${FAKE_VIDEO_ID}/edit`);
  });

  it('warns loudly when YouTube makes the video more public than requested', async () => {
    const { publisher, bundle, ctx, progress } = await setup({
      fake: { privacyStatus: 'public' },
      youtube: { privacyStatus: 'private' },
      bundle: { repoIsPrivate: true },
    });
    const result = await publisher.publish(bundle, ctx);
    expect(result.visibility).toBe('public');
    expect(warnings(progress)[0]).toContain('now');
  });

  it('is quiet when the status is as requested', async () => {
    const { publisher, bundle, ctx, progress } = await setup();
    await publisher.publish(bundle, ctx);
    expect(warnings(progress)).toEqual([]);
  });

  it('keeps the requested status when YouTube does not report one', async () => {
    const { publisher, bundle, ctx, fake } = await setup();
    fake.intercept(isFinalChunk, { kind: 'json', status: 201, body: { id: FAKE_VIDEO_ID } });
    const result = await publisher.publish(bundle, ctx);
    expect(result.visibility).toBe('unlisted');
  });
});

describe('errors from YouTube', () => {
  const failAtStart = async (reply: ReturnType<typeof googleError>, options: SetupOptions = {}) => {
    const { publisher, bundle, ctx, fake, progress } = await setup(options);
    fake.intercept((r) => isVideoStart(r), reply, 5);
    const error = await failure(publisher.publish(bundle, ctx));
    return { error, fake, progress };
  };

  it('maps a used-up quota to PUBLISH_FAILED with a quota hint, and stops at once', async () => {
    const { error, fake } = await failAtStart(googleError(403, 'quotaExceeded'));
    expect(error.code).toBe('PUBLISH_FAILED');
    expect(error.message).toContain('Uploading the video to YouTube failed');
    expect(error.hint).toContain('quota');
    expect(error.hint).toContain('midnight Pacific Time');
    expect(fake.requestsTo('POST', '/upload/youtube/v3/videos')).toHaveLength(1);
  });

  it('maps the daily upload limit to PUBLISH_FAILED', async () => {
    const { error } = await failAtStart(googleError(400, 'uploadLimitExceeded'));
    expect(error.code).toBe('PUBLISH_FAILED');
    expect(error.message).toContain('upload limit');
  });

  it('maps forbidden to PUBLISH_FAILED with a scope and channel hint', async () => {
    const { error } = await failAtStart(googleError(403, 'forbidden'));
    expect(error.code).toBe('PUBLISH_FAILED');
    expect(error.hint).toContain('channel');
    expect(error.hint).toContain('permissions');
  });

  it('maps a rejected title to PUBLISH_FAILED', async () => {
    const { error } = await failAtStart(googleError(400, 'invalidTitle'));
    expect(error.code).toBe('PUBLISH_FAILED');
    expect(error.message).toContain('invalidTitle');
  });

  it('retries temporary server errors when starting', async () => {
    const { publisher, bundle, ctx, fake } = await setup();
    fake.intercept((r) => isVideoStart(r), googleError(503, 'backendError'), 2);
    const result = await publisher.publish(bundle, ctx);
    expect(result.provider).toBe('youtube');
    expect(fake.requestsTo('POST', '/upload/youtube/v3/videos')).toHaveLength(3);
  });

  it('fails with a clear error when YouTube does not return a video id', async () => {
    const { publisher, bundle, ctx, fake } = await setup();
    fake.intercept(isFinalChunk, { kind: 'json', status: 201, body: { kind: 'youtube#video' } });
    const error = await failure(publisher.publish(bundle, ctx));
    expect(error.code).toBe('PUBLISH_FAILED');
    expect(error.message).toContain('video id');
  });

  it('never leaks a video id from an odd answer into a link', async () => {
    const { publisher, bundle, ctx, fake } = await setup();
    fake.intercept(isFinalChunk, {
      kind: 'json',
      status: 201,
      body: { id: '../../evil?x=1', status: { privacyStatus: 'private' } },
    });
    const error = await failure(publisher.publish(bundle, ctx));
    expect(error.message).toContain('video id');
  });
});

describe('what is reported about the run', () => {
  it('records every transfer that carries content, with its host', async () => {
    const { publisher, bundle, ctx, fake, video } = await setup({
      fake: { scope: FORCE_SSL_SCOPE },
      youtube: { uploadCaptions: true },
    });
    await publisher.publish(bundle, ctx);
    const records = ctx.egress.list();
    const host = new URL(fake.url).hostname;
    const byPurpose = (purpose: string) => records.find((r) => r.purpose === purpose);
    expect(byPurpose('video upload')).toEqual({
      destination: host,
      purpose: 'video upload',
      bytes: video.length,
      contains: ['video'],
    });
    expect(byPurpose('video details')?.contains).toEqual(['pr-metadata']);
    expect(byPurpose('video details')?.bytes).toBeGreaterThan(100);
    expect(byPurpose('video thumbnail')).toMatchObject({ bytes: 'POSTER-BYTES'.length, contains: ['video'] });
    expect(byPurpose('captions')).toMatchObject({ contains: ['narration-text'] });
  });

  it('counts the bytes of an interrupted chunk that was sent again', async () => {
    const { publisher, bundle, ctx, fake, video } = await setup();
    fake.intercept(
      (r) => r.method === 'PUT' && String(r.headers['content-range']).startsWith(`bytes ${CHUNK_UNIT}-`),
      { kind: 'drop' },
    );
    await publisher.publish(bundle, ctx);
    const upload = ctx.egress.list().find((r) => r.purpose === 'video upload');
    expect(upload?.bytes).toBe(video.length + CHUNK_UNIT);
  });

  it('records usage with a cost of zero and names the quota it used', async () => {
    const { publisher, bundle, ctx } = await setup({
      fake: { scope: FORCE_SSL_SCOPE },
      youtube: { uploadCaptions: true, playlistId: 'PLabcdefghijklmn' },
    });
    await publisher.publish(bundle, ctx);
    const report = ctx.cost.report();
    expect(report.totalUsd).toBe(0);
    expect(
      report.records.every((r) => r.provider === 'youtube' && r.costUsd === 0 && r.kind === 'other'),
    ).toBe(true);
    expect(report.records.map((r) => r.model)).toEqual([
      'videos.insert (1 upload call)',
      'thumbnails.set (50 units)',
      'captions.insert (400 units)',
      'playlistItems.insert (50 units)',
    ]);
  });

  it('records no usage for a call that failed', async () => {
    const { publisher, bundle, ctx, fake } = await setup();
    fake.intercept((r) => isVideoStart(r), googleError(403, 'quotaExceeded'));
    await failure(publisher.publish(bundle, ctx));
    expect(ctx.cost.report().records).toEqual([]);
  });
});

describe('cancellation', () => {
  it('stops the upload when the run is cancelled', async () => {
    const controller = new AbortController();
    const { publisher, bundle, ctx, fake } = await setup({
      signal: controller.signal,
      onProgress: (event) => {
        if (event.status === 'progress') controller.abort();
      },
    });
    const error = await failure(publisher.publish(bundle, ctx));
    expect(error.code).toBe('ABORTED');
    expect(fake.requestsTo('POST', '/upload/youtube/v3/thumbnails/set')).toEqual([]);
  });

  it('does not start when the run was cancelled before', async () => {
    const controller = new AbortController();
    controller.abort();
    const { publisher, bundle, ctx, fake } = await setup({ signal: controller.signal });
    expect((await failure(publisher.publish(bundle, ctx))).code).toBe('ABORTED');
    expect(fake.requests).toEqual([]);
  });

  it('keeps the link of a finished upload and skips the extras when cancelled afterwards', async () => {
    const controller = new AbortController();
    const { publisher, bundle, ctx, fake, progress } = await setup({
      signal: controller.signal,
      fake: { scope: FORCE_SSL_SCOPE },
      youtube: { uploadCaptions: true, playlistId: 'PLabcdefghijklmn' },
    });
    const record = ctx.cost.record.bind(ctx.cost);
    ctx.cost.record = (entry) => {
      record(entry);
      if (entry.model?.startsWith('videos.insert')) controller.abort();
    };
    const result = await publisher.publish(bundle, ctx);
    expect(result.watchUrl).toContain(FAKE_VIDEO_ID);
    expect(fake.requestsTo('POST', '/upload/youtube/v3/thumbnails/set')).toEqual([]);
    expect(fake.requestsTo('POST', '/upload/youtube/v3/captions')).toEqual([]);
    expect(warnings(progress).join('\n')).toContain('cancelled');
  });
});

describe('the factory', () => {
  it('creates the publisher for provider "youtube"', async () => {
    const { ctx } = await setup();
    const publisher = createYouTubePublisher(ctx.config);
    expect(publisher.id).toBe('youtube');
    expect(publisher).toBeInstanceOf(YouTubePublisher);
    expect(createPublisher(ctx.config)?.id).toBe('youtube');
  });

  it('refuses a chunk size that is not a multiple of 256 KiB', async () => {
    const { ctx } = await setup();
    expect(() => new YouTubePublisher(ctx.config, { chunkBytes: 1000 })).toThrow(MergeStoryError);
  });
});
