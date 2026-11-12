import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigInput, SecretName } from '../../core/config.ts';
import { MergeStoryError } from '../../core/errors.ts';
import type { ProgressEvent } from '../../core/types.ts';
import { testContext } from '../../testing/context.ts';
import {
  type BundleOptions,
  DRIVE_SCOPE,
  FAKE_CLIENT_ID,
  FAKE_CLIENT_SECRET,
  FAKE_FILE_ID,
  FAKE_FOLDER_ID,
  FAKE_REFRESH_TOKEN,
  FAST_TIMING,
  type FakeGoogle,
  type FakeGoogleOptions,
  googleError,
  makeBundle,
  makeTempDir,
  removeDir,
  startFakeGoogle,
  UPLOAD_SCOPE,
} from '../../testing/youtube.ts';
import { CHUNK_UNIT } from '../google/upload.ts';
import { createPublisher } from '../index.ts';
import { BUNDLE_CONTAINS } from '../types.ts';
import { DrivePublisher } from './publisher.ts';

const SECRETS: Partial<Record<SecretName, string>> = {
  MERGESTORY_DRIVE_CLIENT_ID: FAKE_CLIENT_ID,
  MERGESTORY_DRIVE_CLIENT_SECRET: FAKE_CLIENT_SECRET,
  MERGESTORY_DRIVE_REFRESH_TOKEN: FAKE_REFRESH_TOKEN,
};
const VIDEO_BYTES = 600 * 1024;
const FILE_LINK = `https://drive.google.com/file/d/${FAKE_FILE_ID}/view`;
const FOLDER_LINK = `https://drive.google.com/drive/folders/${FAKE_FOLDER_ID}`;

let dir: string;
const fakes: FakeGoogle[] = [];

beforeEach(async () => {
  dir = await makeTempDir('mergestory-drive-');
});

afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.stop()));
  await removeDir(dir);
});

interface SetupOptions {
  fake?: FakeGoogleOptions;
  visibility?: 'private' | 'protected' | 'public';
  allowPublicForPrivateRepos?: boolean;
  secrets?: Partial<Record<SecretName, string>>;
  bundle?: BundleOptions;
  dryRun?: boolean;
}

async function setup(options: SetupOptions = {}) {
  const fake = await startFakeGoogle({ scope: DRIVE_SCOPE, ...options.fake });
  fakes.push(fake);
  const publish: NonNullable<ConfigInput['publish']> = { provider: 'drive' };
  if (options.visibility) publish.visibility = options.visibility;
  if (options.allowPublicForPrivateRepos !== undefined)
    publish.allowPublicForPrivateRepos = options.allowPublicForPrivateRepos;
  const t = testContext({
    home: dir,
    runId: 'run-1',
    captureLogs: true,
    config: { publish },
    secrets: options.secrets ?? SECRETS,
    dryRun: options.dryRun,
  });
  const publisher = new DrivePublisher(t.ctx.config, {
    endpoints: { apiBase: fake.url, tokenUrl: `${fake.url}/token` },
    timing: FAST_TIMING,
    chunkBytes: CHUNK_UNIT,
  });
  const { bundle, video } = await makeBundle(join(dir, 'render'), options.bundle);
  return { fake, ...t, publisher, bundle, video };
}

const warnings = (events: ProgressEvent[]) =>
  events.filter((event) => event.status === 'warn').map((event) => event.message);
const permissions = (fake: FakeGoogle) =>
  fake.requests
    .filter((r) => r.method === 'POST' && r.path.endsWith('/permissions'))
    .map((r) => ({ path: r.path, query: r.query.toString(), body: JSON.parse(r.body.toString('utf8')) }));

async function failure(promise: Promise<unknown>): Promise<MergeStoryError> {
  const error = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(MergeStoryError);
  return error as MergeStoryError;
}

describe('DrivePublisher', () => {
  it('is what createPublisher builds for provider "drive"', async () => {
    const { ctx } = await setup();
    expect(createPublisher(ctx.config)).toBeInstanceOf(DrivePublisher);
  });

  it('creates the MergeStory folder when there is none, uploads in chunks, and keeps the file private', async () => {
    const { publisher, bundle, ctx, fake, video } = await setup();
    const result = await publisher.publish(bundle, ctx);
    expect(result).toEqual({
      provider: 'drive',
      watchUrl: FILE_LINK,
      videoUrl: FILE_LINK,
      posterUrl: null,
      captionsUrl: null,
      expiresAt: null,
      visibility: 'private',
      location: FOLDER_LINK,
    });
    const [list] = fake.requestsTo('GET', '/drive/v3/files');
    expect(list?.query.get('q')).toBe(
      "name = 'MergeStory' and mimeType = 'application/vnd.google-apps.folder' and trashed = false and 'me' in owners and 'root' in parents",
    );
    expect(list?.query.get('spaces')).toBe('drive');
    expect(list?.query.get('fields')).toBe('files(id,name,webViewLink,shared)');
    const [create] = fake.requestsTo('POST', '/drive/v3/files');
    expect(JSON.parse(create?.body.toString('utf8') ?? '')).toEqual({
      name: 'MergeStory',
      mimeType: 'application/vnd.google-apps.folder',
    });
    // 600 KiB in chunks of 256 KiB: three PUTs.
    expect(fake.requestsTo('PUT', '/upload/drive/v3/files')).toHaveLength(3);
    expect(fake.uploaded('video').equals(video)).toBe(true);
    const [start] = fake.requestsTo('POST', '/upload/drive/v3/files');
    expect(start?.query.get('fields')).toBe('id,name,webViewLink');
    expect(start?.headers['x-upload-content-type']).toBe('video/mp4');
    expect(start?.headers['x-upload-content-length']).toBe(String(VIDEO_BYTES));
    expect(fake.sessionMetadata('video')).toMatchObject({
      name: 'Add retry with backoff (PR #482).mp4',
      parents: [FAKE_FOLDER_ID],
      mimeType: 'video/mp4',
    });
    expect(permissions(fake)).toEqual([]);
    // A private file needs nothing from the account.
    expect(fake.requestsTo('GET', '/drive/v3/about')).toEqual([]);
  });

  it('uses the MergeStory folder that already exists', async () => {
    const { publisher, bundle, ctx, fake } = await setup();
    fake.folders.push({
      id: 'existingFolder01',
      name: 'MergeStory',
      webViewLink: 'https://drive.google.com/x',
      shared: false,
    });
    const result = await publisher.publish(bundle, ctx);
    expect(fake.requestsTo('POST', '/drive/v3/files')).toEqual([]);
    expect(fake.sessionMetadata('video')).toMatchObject({ parents: ['existingFolder01'] });
    expect(result.location).toBe('https://drive.google.com/x');
  });

  it('never uploads into a shared folder, whose sharing a private video would take on', async () => {
    const { publisher, bundle, ctx, fake } = await setup();
    fake.folders.push({
      id: 'sharedFolder01',
      name: 'MergeStory',
      webViewLink: 'https://drive.google.com/s',
      shared: true,
    });
    // A folder whose sharing Drive does not report counts as shared.
    fake.folders.push({
      id: 'unknownFolder1',
      name: 'MergeStory',
      webViewLink: 'https://drive.google.com/u',
    });
    const result = await publisher.publish(bundle, ctx);
    expect(fake.requestsTo('POST', '/drive/v3/files')).toHaveLength(1);
    expect(fake.sessionMetadata('video')).toMatchObject({ parents: [FAKE_FOLDER_ID] });
    expect(result.location).toBe(FOLDER_LINK);
  });

  it('resumes the upload after a broken connection', async () => {
    const { publisher, bundle, ctx, fake, video } = await setup();
    fake.intercept((r) => r.method === 'PUT' && r.path === '/upload/drive/v3/files', {
      kind: 'store-then-drop',
      storeBytes: 1000,
    });
    await publisher.publish(bundle, ctx);
    expect(fake.uploaded('video').equals(video)).toBe(true);
    const asked = fake
      .requestsTo('PUT', '/upload/drive/v3/files')
      .filter((r) => r.headers['content-range'] === `bytes */${VIDEO_BYTES}`);
    expect(asked).toHaveLength(1);
  });

  it('shares a protected video with the organization, not findable in search, with no e-mail parameter', async () => {
    const { publisher, bundle, ctx, fake } = await setup({ visibility: 'protected' });
    const result = await publisher.publish(bundle, ctx);
    expect(result.visibility).toBe('protected');
    expect(fake.requestsTo('GET', '/drive/v3/about')[0]?.query.get('fields')).toBe('user(emailAddress)');
    expect(permissions(fake)).toEqual([
      {
        path: `/drive/v3/files/${FAKE_FILE_ID}/permissions`,
        query: 'fields=id',
        body: { type: 'domain', role: 'reader', domain: 'example.com', allowFileDiscovery: false },
      },
    ]);
  });

  it('allows a protected video of a private repository', async () => {
    const { publisher, bundle, ctx } = await setup({
      visibility: 'protected',
      bundle: { repoIsPrivate: true },
    });
    expect((await publisher.publish(bundle, ctx)).visibility).toBe('protected');
  });

  it('shares a public video with anyone who has the link', async () => {
    const { publisher, bundle, ctx, fake } = await setup({ visibility: 'public' });
    const result = await publisher.publish(bundle, ctx);
    expect(result.visibility).toBe('public');
    expect(permissions(fake)[0]?.body).toEqual({ type: 'anyone', role: 'reader', allowFileDiscovery: false });
    expect(fake.requestsTo('GET', '/drive/v3/about')).toEqual([]);
  });

  for (const email of ['someone@gmail.com', 'someone@GoogleMail.com', null]) {
    it(`refuses a protected link for ${email ?? 'an account without an address'} before uploading`, async () => {
      const { publisher, bundle, ctx, fake } = await setup({ visibility: 'protected', fake: { email } });
      const error = await failure(publisher.publish(bundle, ctx));
      expect(error.code).toBe('CONFIG_INVALID');
      expect(error.hint).toBe('Use --visibility private, or public for public code.');
      if (email) expect(error.message).toBe('Protected links need a Google Workspace account.');
      expect(fake.requestsTo('POST', '/upload/drive/v3/files')).toEqual([]);
    });
  }

  it('keeps the upload and warns when sharing is not allowed', async () => {
    const { publisher, bundle, ctx, fake, events } = await setup({ visibility: 'public' });
    fake.intercept(
      (r) => r.path.endsWith('/permissions'),
      googleError(400, 'invalidSharingRequest', 'ACL change not allowed.'),
    );
    const result = await publisher.publish(bundle, ctx);
    expect(result.visibility).toBe('private');
    expect(result.watchUrl).toBe(FILE_LINK);
    const [warning] = warnings(events);
    expect(warning).toContain('The video is in the MergeStory folder of your Google Drive');
    expect(warning).toContain('could not be shared');
    expect(warning).toContain('invalidSharingRequest');
    expect(warning).toContain('You can share it yourself in Google Drive.');
  });

  it('keeps a protected upload private when the organization forbids link sharing', async () => {
    const { publisher, bundle, ctx, fake, events } = await setup({ visibility: 'protected' });
    fake.intercept(
      (r) => r.path.endsWith('/permissions'),
      googleError(403, 'sharingRateLimitExceeded', 'Sharing is not allowed.'),
    );
    const result = await publisher.publish(bundle, ctx);
    expect(result.visibility).toBe('private');
    expect(warnings(events)[0]).toContain('could not be shared');
  });

  it('stops when Drive answers the folder creation without a usable folder', async () => {
    const { publisher, bundle, ctx, fake } = await setup();
    fake.intercept((r) => r.method === 'POST' && r.path === '/drive/v3/files', {
      kind: 'json',
      status: 200,
      body: {},
    });
    const error = await failure(publisher.publish(bundle, ctx));
    expect(error.code).toBe('PUBLISH_FAILED');
    expect(fake.requestsTo('POST', '/upload/drive/v3/files')).toEqual([]);
  });

  it('blocks a public link for a private or unknown repository before any request', async () => {
    for (const repoIsPrivate of [true, null]) {
      const { publisher, bundle, ctx, fake } = await setup({
        visibility: 'public',
        secrets: {},
        bundle: { repoIsPrivate },
      });
      const error = await failure(publisher.publish(bundle, ctx));
      expect(error.code).toBe('PRIVACY_BLOCKED');
      expect(error.hint).toContain('publish.allowPublicForPrivateRepos');
      expect(await publisher.check(ctx, repoIsPrivate)).toMatchObject({ code: 'PRIVACY_BLOCKED' });
      expect(fake.requests).toEqual([]);
    }
  });

  it('lets publish.allowPublicForPrivateRepos open the guard', async () => {
    const { publisher, bundle, ctx } = await setup({
      visibility: 'public',
      allowPublicForPrivateRepos: true,
      bundle: { repoIsPrivate: true },
    });
    expect((await publisher.publish(bundle, ctx)).visibility).toBe('public');
  });

  it('says how to sign in when there is no sign-in', async () => {
    const { publisher, bundle, ctx, fake } = await setup({ secrets: {} });
    const checked = await publisher.check(ctx, false);
    expect(checked?.message).toBe('No Google Drive sign-in was found.');
    expect(checked?.hint).toContain('mergestory setup drive');
    expect(checked?.hint).toContain('MERGESTORY_DRIVE_REFRESH_TOKEN');
    const error = await failure(publisher.publish(bundle, ctx));
    expect(error.message).toBe('No Google Drive sign-in was found.');
    expect(fake.requests).toEqual([]);
  });

  it('refuses a sign-in that lacks the drive.file permission', async () => {
    const { publisher, bundle, ctx } = await setup({ fake: { scope: UPLOAD_SCOPE } });
    const error = await failure(publisher.publish(bundle, ctx));
    expect(error.hint).toContain('mergestory setup drive');
  });

  it('explains failures in Google Drive words', async () => {
    const { publisher, bundle, ctx, fake } = await setup();
    fake.intercept((r) => r.path === '/drive/v3/files', googleError(403, 'accessNotConfigured', 'off'));
    const error = await failure(publisher.publish(bundle, ctx));
    expect(error.message).toBe('The Google Drive API is not turned on for the Google Cloud project.');
    expect(error.hint).toContain('docs/drive.md');
  });

  it('records every request to Google as egress, and plans the upload for a dry run', async () => {
    const { publisher, bundle, ctx } = await setup({ visibility: 'protected' });
    await publisher.publish(bundle, ctx);
    const records = ctx.egress.list();
    expect(new Set(records.map((r) => r.destination))).toEqual(new Set(['127.0.0.1']));
    expect([...new Set(records.map((r) => r.purpose))]).toEqual([
      'account domain',
      'folder lookup',
      'folder creation',
      'video details',
      'video upload',
      'sharing',
    ]);
    const sent = records.filter((r) => r.purpose === 'video upload').reduce((sum, r) => sum + r.bytes, 0);
    expect(sent).toBe(VIDEO_BYTES);
    expect(records.find((r) => r.purpose === 'video details')?.contains).toEqual(['pr-metadata']);
    expect(publisher.plannedEgress(5)).toEqual([
      { destination: '127.0.0.1', purpose: 'video upload', bytes: 5, contains: [...BUNDLE_CONTAINS] },
    ]);
    expect(new DrivePublisher(ctx.config).plannedEgress(1)[0]?.destination).toBe('www.googleapis.com');
  });

  it('refuses to upload in a dry run', async () => {
    const { publisher, bundle, ctx, fake } = await setup({ dryRun: true });
    expect((await failure(publisher.publish(bundle, ctx))).message).toContain('dry run');
    expect(fake.requests).toEqual([]);
  });

  it('reads the organization domain for doctor, never more', async () => {
    const { publisher, ctx } = await setup({ fake: { email: 'dev@Acme.example' } });
    expect(await publisher.accountDomain(ctx)).toBe('acme.example');
  });
});
