import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigInput, SecretName } from '../core/config.ts';
import { testContext } from '../testing/context.ts';
import { SECRETS as S3_SECRETS } from '../testing/s3.ts';
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FAKE_REFRESH_TOKEN } from '../testing/youtube.ts';
import { createPublisher } from './index.ts';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'mergestory-privacy-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

interface Case {
  publish: NonNullable<ConfigInput['publish']>;
  secrets: Partial<Record<SecretName, string>>;
  message: string;
}

/** Settings of each uploading publisher whose link anyone can open, complete apart from the privacy rule. */
const CASES: Case[] = [
  {
    publish: {
      provider: 's3',
      visibility: 'public',
      s3: { bucket: 'media', region: 'us-east-1', publicBaseUrl: 'https://cdn.example.com/media' },
    },
    secrets: S3_SECRETS,
    message: 'This repository is private, so public video links are blocked.',
  },
  {
    publish: { provider: 'youtube', youtube: { privacyStatus: 'unlisted' } },
    secrets: {
      MERGESTORY_YOUTUBE_CLIENT_ID: FAKE_CLIENT_ID,
      MERGESTORY_YOUTUBE_CLIENT_SECRET: FAKE_CLIENT_SECRET,
      MERGESTORY_YOUTUBE_REFRESH_TOKEN: FAKE_REFRESH_TOKEN,
    },
    message: 'This repository is private, so a YouTube video that others can open is blocked.',
  },
];

describe('the private-repository rule of the publishers that upload', () => {
  it('blocks a link anyone can open for a private repository until the settings allow it', async () => {
    for (const { publish, secrets, message } of CASES) {
      for (const allowPublicForPrivateRepos of [false, true]) {
        const { ctx } = testContext({
          home,
          config: { publish: { ...publish, allowPublicForPrivateRepos } },
          secrets,
        });
        const publisher = createPublisher(ctx.config);
        const problem = await publisher?.check(ctx, true);
        if (allowPublicForPrivateRepos) {
          expect(problem, `${publish.provider} with the setting on`).toBeNull();
        } else {
          expect(problem, `${publish.provider} with the setting off`).toMatchObject({
            code: 'PRIVACY_BLOCKED',
            message,
            hint: expect.stringContaining('publish.allowPublicForPrivateRepos'),
          });
        }
      }
    }
  });
});
