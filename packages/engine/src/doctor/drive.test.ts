import { describe, expect, it } from 'vitest';
import type { ConfigInput } from '../core/config.ts';
import { MergeStoryError } from '../core/errors.ts';
import { DRIVE } from '../publish/drive/provider.ts';
import { credentialsPath, writeCredentialsFile } from '../publish/google/credentials.ts';
import { createPublisher } from '../publish/index.ts';
import { byId, doctor } from '../testing/doctor.ts';
import { DRIVE_SCOPE, makeTempDir, removeDir } from '../testing/youtube.ts';

const ENV = {
  MERGESTORY_DRIVE_CLIENT_ID: '123-abc.apps.googleusercontent.com',
  MERGESTORY_DRIVE_CLIENT_SECRET: 'client-secret-value-0123',
  MERGESTORY_DRIVE_REFRESH_TOKEN: 'refresh-token-value-0123456789',
};
const drive = (visibility: 'private' | 'protected' | 'public' = 'protected', home?: string): ConfigInput => ({
  ...(home ? { home } : {}),
  publish: { provider: 'drive', visibility },
});
const publisher = async (config: Parameters<typeof createPublisher>[0]) => createPublisher(config);

describe('publishing: drive', () => {
  it('says "not signed in" and how to sign in', async () => {
    const report = await doctor(drive(), { publisher });
    const check = byId(report.checks, 'publish');
    expect(check.status).toBe('fail');
    expect(check.detail).toBe('Google Drive: not signed in. Run: mergestory setup drive');
    expect(check.fix).toContain('MERGESTORY_DRIVE_CLIENT_ID');
    expect(report.ok).toBe(false);
  });

  it('says it is signed in, and with which permission, from the saved sign-in', async () => {
    const home = await makeTempDir('mergestory-doctor-drive-');
    try {
      await writeCredentialsFile(credentialsPath(home, DRIVE), DRIVE, {
        clientId: ENV.MERGESTORY_DRIVE_CLIENT_ID,
        clientSecret: ENV.MERGESTORY_DRIVE_CLIENT_SECRET,
        refreshToken: ENV.MERGESTORY_DRIVE_REFRESH_TOKEN,
        scope: DRIVE_SCOPE,
        createdAt: null,
      });
      const report = await doctor(drive('protected', home), { publisher });
      expect(byId(report.checks, 'publish')).toMatchObject({
        status: 'pass',
        detail: 'Google Drive (signed in)',
      });
      expect(byId(report.checks, 'publish-credentials').detail).toBe(
        'permission: drive.file; visibility protected: people in your Google Workspace organization can open the link',
      );
      // Offline: Google is not asked.
      expect(report.checks.some((c) => c.id === 'publish-account')).toBe(false);
    } finally {
      await removeDir(home);
    }
  });

  it('says when the permission is not recorded, for a sign-in from the environment', async () => {
    const report = await doctor(drive('private'), { publisher }, ENV);
    expect(byId(report.checks, 'publish-credentials').detail).toContain('permission: not recorded');
  });

  it('shows the organization domain with --online, never the e-mail address', async () => {
    const report = await doctor(drive(), { publisher, driveDomain: async () => 'acme.example' }, ENV, true);
    expect(byId(report.checks, 'publish-account')).toMatchObject({
      status: 'pass',
      detail: 'organization: acme.example',
    });
    expect(JSON.stringify(report)).not.toContain('@');
  });

  it('fails --online for a personal account when links are protected, and passes otherwise', async () => {
    const personal = { publisher, driveDomain: async () => 'gmail.com' };
    const failed = byId((await doctor(drive('protected'), personal, ENV, true)).checks, 'publish-account');
    expect(failed.status).toBe('fail');
    expect(failed.fix).toContain('Protected links need a Google Workspace account');
    expect(byId((await doctor(drive('private'), personal, ENV, true)).checks, 'publish-account').status).toBe(
      'pass',
    );
  });

  it('reports a failed --online call with its hint', async () => {
    const driveDomain = async () => {
      throw new MergeStoryError(
        'CONFIG_INVALID',
        'Google no longer accepts the saved Google Drive sign-in.',
        {
          hint: 'Run `mergestory setup drive` to sign in again.',
        },
      );
    };
    const check = byId(
      (await doctor(drive(), { publisher, driveDomain }, ENV, true)).checks,
      'publish-account',
    );
    expect(check).toMatchObject({ status: 'fail', fix: 'Run `mergestory setup drive` to sign in again.' });
  });
});
