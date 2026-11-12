import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createStyle } from '../cli/style.ts';
import { type Config, type ConfigInput, resolveConfig, type SecretName, Secrets } from '../core/config.ts';
import { MergeStoryError } from '../core/errors.ts';
import { homeLayout } from '../core/paths.ts';
import type { PublishCheckContext } from '../core/providers.ts';
import { Redactor } from '../core/redact.ts';
import { byId, doctor, healthyDeps } from '../testing/doctor.ts';
import { defaultDoctorDeps } from './deps.ts';
import { formatDoctor } from './format.ts';
import { runDoctor } from './index.ts';
import type { YouTubeLoginFile } from './types.ts';

describe('publishing: youtube', () => {
  const youtube = (settings: object = {}): ConfigInput => ({
    publish: { provider: 'youtube', youtube: settings },
  });
  const all = {
    MERGESTORY_YOUTUBE_CLIENT_ID: '1234567890-abc.apps.googleusercontent.com',
    MERGESTORY_YOUTUBE_CLIENT_SECRET: 'GOCSPX-client-secret-value-0123',
    MERGESTORY_YOUTUBE_REFRESH_TOKEN: '1//0refresh-token-value-0123456789',
  };
  const saved = (values: Partial<YouTubeLoginFile> = {}) => ({
    readYouTubeLogin: async (): Promise<YouTubeLoginFile> => ({
      clientId: true,
      clientSecret: true,
      refreshToken: true,
      ...values,
    }),
  });

  it('shows the privacy setting and what it means', async () => {
    const unlisted = byId((await doctor(youtube())).checks, 'publish');
    expect(unlisted).toMatchObject({ status: 'pass' });
    expect(unlisted.detail).toContain('youtube: privacy unlisted (only people with the link can watch it)');
    const priv = byId((await doctor(youtube({ privacyStatus: 'private' }))).checks, 'publish');
    expect(priv.detail).toBe('youtube: privacy private (only you can watch it)');
  });

  it('reminds people of the private-repository guard, unless the video is private', async () => {
    for (const privacyStatus of ['unlisted', 'public'] as const) {
      const check = byId((await doctor(youtube({ privacyStatus }), {}, all)).checks, 'publish');
      expect(check.detail, privacyStatus).toContain('For a private repository, use privacy private');
      expect(check.detail, privacyStatus).toContain('publish.allowPublicForPrivateRepos');
    }
    const priv = byId((await doctor(youtube({ privacyStatus: 'private' }), {}, all)).checks, 'publish');
    expect(priv.detail).not.toContain('private repository');
  });

  it('warns about a public video', async () => {
    const report = await doctor(youtube({ privacyStatus: 'public' }), {}, all);
    const check = byId(report.checks, 'publish');
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('anyone can find and watch it');
    expect(check.fix).toContain('publish.youtube.privacyStatus');
    expect(report.ok).toBe(true);
  });

  it('passes when the three values come from the environment, and does not read the file', async () => {
    const readYouTubeLogin = vi.fn(async () => null);
    const report = await doctor(youtube(), { readYouTubeLogin }, all);
    const check = byId(report.checks, 'publish-credentials');
    expect(check).toMatchObject({
      status: 'pass',
      name: 'YouTube login',
      detail: 'client id: environment, client secret: environment, refresh token: environment',
    });
    // The upload reads the file only when the client id or the refresh token is missing.
    expect(readYouTubeLogin).not.toHaveBeenCalled();
    const text = JSON.stringify(report) + formatDoctor(report, createStyle(false));
    for (const value of Object.values(all)) expect(text).not.toContain(value);
  });

  it('finds the values in the credentials file in the MergeStory home', async () => {
    const asked: string[] = [];
    const report = await doctor(youtube(), {
      readYouTubeLogin: async (path) => {
        asked.push(path);
        return { clientId: true, clientSecret: true, refreshToken: true };
      },
    });
    expect(asked).toEqual([join('/data/mergestory', 'credentials', 'youtube.json')]);
    expect(byId(report.checks, 'publish-credentials')).toMatchObject({
      status: 'pass',
      detail: 'client id: credentials file, client secret: credentials file, refresh token: credentials file',
    });
  });

  it('takes some values from the environment and some from the file', async () => {
    const report = await doctor(youtube(), saved(), {
      MERGESTORY_YOUTUBE_CLIENT_ID: all.MERGESTORY_YOUTUBE_CLIENT_ID,
    });
    expect(byId(report.checks, 'publish-credentials').detail).toBe(
      'client id: environment, client secret: credentials file, refresh token: credentials file',
    );
  });

  it('fails without a refresh token, and says how to sign in', async () => {
    const report = await doctor(youtube(), saved({ refreshToken: false }), {
      MERGESTORY_YOUTUBE_CLIENT_ID: all.MERGESTORY_YOUTUBE_CLIENT_ID,
      MERGESTORY_YOUTUBE_CLIENT_SECRET: all.MERGESTORY_YOUTUBE_CLIENT_SECRET,
    });
    const check = byId(report.checks, 'publish-credentials');
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('refresh token: missing');
    expect(check.fix).toContain('mergestory setup youtube');
    expect(check.fix).toContain('MergeStory/blob/main/docs/youtube.md');
    expect(check.fix).toContain('MERGESTORY_YOUTUBE_REFRESH_TOKEN');
    expect(report.ok).toBe(false);
  });

  it('fails without a client id', async () => {
    const report = await doctor(youtube(), saved({ clientId: false }), {
      MERGESTORY_YOUTUBE_REFRESH_TOKEN: all.MERGESTORY_YOUTUBE_REFRESH_TOKEN,
    });
    expect(byId(report.checks, 'publish-credentials').detail).toContain('client id: missing');
    expect(report.ok).toBe(false);
  });

  it('fails when there is no saved sign-in and nothing in the environment', async () => {
    const report = await doctor(youtube());
    const check = byId(report.checks, 'publish-credentials');
    expect(check.status).toBe('fail');
    expect(check.detail).toBe('client id: missing, client secret: missing, refresh token: missing');
    expect(check.fix).toContain('mergestory setup youtube');
  });

  it('warns when only the client secret is missing', async () => {
    const report = await doctor(youtube(), saved({ clientSecret: false }), {
      MERGESTORY_YOUTUBE_CLIENT_ID: all.MERGESTORY_YOUTUBE_CLIENT_ID,
    });
    const check = byId(report.checks, 'publish-credentials');
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('client secret: missing');
    expect(check.fix).toContain('MERGESTORY_YOUTUBE_CLIENT_SECRET');
    expect(report.ok).toBe(true);
  });

  it('asks the check of the YouTube publisher, with the settings and the secrets, once the values are there', async () => {
    const check = vi.fn(async (_ctx: PublishCheckContext, _repoIsPrivate: boolean | null) => null);
    const publisher = vi.fn(async (_config: Config) => ({ check }));
    await doctor(youtube(), { publisher }, all);
    expect(publisher).toHaveBeenCalledTimes(1);
    expect(publisher.mock.calls[0]?.[0].publish.provider).toBe('youtube');
    expect(check).toHaveBeenCalledTimes(1);
    const [ctx, repoIsPrivate] = check.mock.calls[0] as [PublishCheckContext, boolean | null];
    expect(ctx.secrets.has('MERGESTORY_YOUTUBE_REFRESH_TOKEN')).toBe(true);
    // The repository is not known here, so the privacy rule is left to the run.
    expect(repoIsPrivate).toBe(false);
  });

  it('does not ask the publisher when values are missing, and says which', async () => {
    const check = vi.fn(async () => null);
    const report = await doctor(youtube(), { publisher: async () => ({ check }) });
    expect(byId(report.checks, 'publish-credentials').status).toBe('fail');
    expect(check).not.toHaveBeenCalled();
  });

  it('fails, in the words of the upload, when the upload would refuse the sign-in', async () => {
    const refused = new MergeStoryError(
      'CONFIG_INVALID',
      'MERGESTORY_YOUTUBE_CLIENT_ID is not the client the saved sign-in was made with.',
      {
        hint: 'Unset MERGESTORY_YOUTUBE_CLIENT_ID, or run `mergestory setup youtube` again with that client.',
      },
    );
    const report = await doctor(
      youtube(),
      { ...saved(), publisher: async () => ({ check: async () => refused }) },
      { MERGESTORY_YOUTUBE_CLIENT_ID: all.MERGESTORY_YOUTUBE_CLIENT_ID },
    );
    expect(byId(report.checks, 'publish-credentials')).toMatchObject({
      status: 'fail',
      name: 'YouTube login',
      detail: refused.message,
      fix: refused.hint,
    });
    expect(report.ok).toBe(false);
  });

  it('fails with the reason and the fix of the file reader when the saved sign-in cannot be used', async () => {
    const report = await doctor(youtube(), {
      readYouTubeLogin: async () => {
        throw new MergeStoryError(
          'CONFIG_INVALID',
          'The YouTube credentials file can be read by other users.',
          {
            hint: 'Run: chmod 600 /data/mergestory/credentials/youtube.json',
          },
        );
      },
    });
    expect(byId(report.checks, 'publish-credentials')).toMatchObject({
      status: 'fail',
      detail: 'The YouTube credentials file can be read by other users.',
      fix: 'Run: chmod 600 /data/mergestory/credentials/youtube.json',
    });
    expect(report.ok).toBe(false);
  });

  it('fails, with the sign-in instructions, when the file cannot be read for another reason', async () => {
    const report = await doctor(youtube(), {
      readYouTubeLogin: async () => {
        throw new Error('EIO: something at /secret/path went wrong');
      },
    });
    const check = byId(report.checks, 'publish-credentials');
    expect(check.status).toBe('fail');
    expect(check.detail).toBe('the saved YouTube sign-in could not be read');
    expect(check.fix).toContain('mergestory setup youtube');
    expect(JSON.stringify(report)).not.toContain('/secret/path');
  });

  it('does not check anything about S3 and does not call the network, even with --online', async () => {
    const headBucket = vi.fn();
    const probeAccess = vi.fn();
    const report = await doctor(youtube(), { headBucket, probeAccess }, all, true);
    expect(headBucket).not.toHaveBeenCalled();
    expect(probeAccess).not.toHaveBeenCalled();
    expect(report.checks.map((c) => c.id).filter((id) => id.startsWith('publish'))).toEqual([
      'publish',
      'publish-credentials',
    ]);
  });
});

describe('publishing: the real YouTube sign-in file', () => {
  async function withHome<T>(work: (home: string, path: string) => Promise<T>): Promise<T> {
    const home = await mkdtemp(join(tmpdir(), 'mergestory-doctor-yt-'));
    try {
      return await work(home, join(home, 'credentials', 'youtube.json'));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }

  it('reads which values the saved sign-in holds, and nothing else', async () => {
    await withHome(async (_home, path) => {
      const { writeCredentialsFile } = await import('../publish/youtube/credentials.ts');
      await writeCredentialsFile(path, {
        clientId: 'client-id-0123456789',
        clientSecret: null,
        refreshToken: 'refresh-token-0123456789',
        scope: null,
        createdAt: null,
      });
      const real = defaultDoctorDeps({});
      expect(await real.readYouTubeLogin(path)).toEqual({
        clientId: true,
        clientSecret: false,
        refreshToken: true,
      });
    });
  });

  it('says there is no file when there is none', async () => {
    await withHome(async (_home, path) => {
      expect(await defaultDoctorDeps({}).readYouTubeLogin(path)).toBeNull();
    });
  });

  it.skipIf(process.platform === 'win32')('refuses a sign-in file that other users can read', async () => {
    await withHome(async (_home, path) => {
      const { writeCredentialsFile } = await import('../publish/youtube/credentials.ts');
      await writeCredentialsFile(path, {
        clientId: 'client-id-0123456789',
        clientSecret: 'client-secret-0123456789',
        refreshToken: 'refresh-token-0123456789',
        scope: null,
        createdAt: null,
      });
      await chmod(path, 0o644);
      await expect(defaultDoctorDeps({}).readYouTubeLogin(path)).rejects.toMatchObject({
        code: 'CONFIG_INVALID',
        message: expect.stringContaining('other users'),
      });
    });
  });

  it('shows the whole chain in the report, through the real reader', async () => {
    await withHome(async (home, path) => {
      const { writeCredentialsFile } = await import('../publish/youtube/credentials.ts');
      await writeCredentialsFile(path, {
        clientId: 'client-id-0123456789',
        clientSecret: 'client-secret-0123456789',
        refreshToken: 'refresh-token-0123456789',
        scope: null,
        createdAt: null,
      });
      const report = await runDoctor({
        config: resolveConfig({
          skipFile: true,
          env: {},
          overrides: { home, publish: { provider: 'youtube' } },
        }),
        deps: healthyDeps({
          env: {},
          readYouTubeLogin: defaultDoctorDeps({}).readYouTubeLogin,
          publisher: defaultDoctorDeps({}).publisher,
        }),
      });
      const check = byId(report.checks, 'publish-credentials');
      expect(check.status).toBe('pass');
      expect(check.detail).toBe(
        'client id: credentials file, client secret: credentials file, refresh token: credentials file',
      );
      expect(JSON.stringify(report)).not.toContain('0123456789');
    });
  });

  const savedLogin = {
    clientId: 'client-id-0123456789',
    clientSecret: 'client-secret-0123456789',
    refreshToken: 'refresh-token-0123456789',
    scope: null,
    createdAt: null,
  };

  /** The report of a doctor that reads the real sign-in file and applies the real rules of the upload. */
  function reportWithRealSignIn(home: string, env: Partial<Record<SecretName, string>>) {
    const real = defaultDoctorDeps({});
    return runDoctor({
      config: resolveConfig({
        skipFile: true,
        env: {},
        overrides: { home, publish: { provider: 'youtube' } },
      }),
      deps: healthyDeps({
        env,
        readYouTubeLogin: real.readYouTubeLogin,
        publisher: real.publisher,
      }),
    });
  }

  it('fails when the client id in the environment is not the one the saved sign-in was made with', async () => {
    await withHome(async (home, path) => {
      const { writeCredentialsFile } = await import('../publish/youtube/credentials.ts');
      await writeCredentialsFile(path, savedLogin);
      const report = await reportWithRealSignIn(home, {
        MERGESTORY_YOUTUBE_CLIENT_ID: 'another-client-0123456789',
      });
      expect(byId(report.checks, 'publish-credentials')).toMatchObject({
        status: 'fail',
        name: 'YouTube login',
        detail: 'MERGESTORY_YOUTUBE_CLIENT_ID is not the client the saved sign-in was made with.',
        fix: expect.stringContaining('Unset MERGESTORY_YOUTUBE_CLIENT_ID'),
      });
      expect(report.ok).toBe(false);
      expect(JSON.stringify(report)).not.toContain('0123456789');
    });
  });

  it('reaches the same verdict as the upload for every mix of environment and saved sign-in', async () => {
    const { loadCredentials, writeCredentialsFile } = await import('../publish/youtube/credentials.ts');
    const id: Partial<Record<SecretName, string>> = { MERGESTORY_YOUTUBE_CLIENT_ID: savedLogin.clientId };
    const other: Partial<Record<SecretName, string>> = {
      MERGESTORY_YOUTUBE_CLIENT_ID: 'another-client-0123456789',
    };
    const token: Partial<Record<SecretName, string>> = {
      MERGESTORY_YOUTUBE_REFRESH_TOKEN: savedLogin.refreshToken,
    };
    const mixes: [string, Partial<Record<SecretName, string>>, 'none' | 'saved' | 'open'][] = [
      ['nothing at all', {}, 'none'],
      ['the saved sign-in alone', {}, 'saved'],
      ['everything in the environment', { ...id, ...token }, 'none'],
      ['everything in the environment, and another client saved', { ...other, ...token }, 'saved'],
      ['the saved client id again in the environment', id, 'saved'],
      ['another client id in the environment', other, 'saved'],
      ['a client id and nothing else', id, 'none'],
      ['a refresh token and nothing else', token, 'none'],
      ['a refresh token over the saved sign-in', token, 'saved'],
      ['a saved sign-in that other users can read', {}, 'open'],
    ];
    for (const [name, env, file] of mixes) {
      // Windows has no file mode bits to refuse.
      if (file === 'open' && process.platform === 'win32') continue;
      await withHome(async (home, path) => {
        if (file !== 'none') await writeCredentialsFile(path, savedLogin);
        if (file === 'open') await chmod(path, 0o644);
        const upload = await loadCredentials({
          secrets: new Secrets(env, new Redactor()),
          redactor: new Redactor(),
          home: homeLayout(home),
        }).then(
          () => 'usable',
          () => 'refused',
        );
        const report = await reportWithRealSignIn(home, env);
        const doctorVerdict =
          byId(report.checks, 'publish-credentials').status === 'fail' ? 'refused' : 'usable';
        expect(doctorVerdict, name).toBe(upload);
      });
    }
  });
});
