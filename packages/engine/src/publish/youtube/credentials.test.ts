import { chmod, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type SecretName, Secrets } from '../../core/config.ts';
import { MergeStoryError } from '../../core/errors.ts';
import { homeLayout } from '../../core/paths.ts';
import { REDACTED, Redactor } from '../../core/redact.ts';
import { makeTempDir, removeDir } from '../../testing/youtube.ts';
import {
  credentialsDir,
  credentialsPath,
  loadCredentials,
  readCredentialsFile,
  writeCredentialsFile,
} from './credentials.ts';

const CLIENT_ID = 'client-id-1234567890.apps.googleusercontent.com';
const CLIENT_SECRET = 'client-secret-abcdefghij';
const REFRESH = 'refresh-token-abcdefghijklmnop';
const posix = process.platform !== 'win32';

let home: string;

beforeEach(async () => {
  home = await makeTempDir('mergestory-cred-');
});

afterEach(async () => {
  await removeDir(home);
});

function context(secrets: Partial<Record<SecretName, string>> = {}) {
  const redactor = new Redactor();
  return { secrets: new Secrets(secrets, new Redactor()), redactor, home: homeLayout(home) };
}

const stored = {
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  refreshToken: REFRESH,
  scope: 'https://www.googleapis.com/auth/youtube.upload',
  createdAt: '2026-11-04T10:00:00.000Z',
};

const fileMode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

async function expectConfigError(promise: Promise<unknown>): Promise<MergeStoryError> {
  const error = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(MergeStoryError);
  expect((error as MergeStoryError).code).toBe('CONFIG_INVALID');
  return error as MergeStoryError;
}

describe('writeCredentialsFile', () => {
  it('writes the file with mode 0600 in a folder with mode 0700', async () => {
    const path = credentialsPath(home);
    await writeCredentialsFile(path, stored);
    if (posix) {
      expect(await fileMode(path)).toBe(0o600);
      expect(await fileMode(credentialsDir(home))).toBe(0o700);
    }
    const json = JSON.parse(await readFile(path, 'utf8'));
    expect(json).toMatchObject({
      version: 1,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH,
      scope: stored.scope,
      created_at: stored.createdAt,
    });
  });

  it('leaves no temporary file behind and replaces an earlier file', async () => {
    const path = credentialsPath(home);
    await writeCredentialsFile(path, stored);
    await writeCredentialsFile(path, { ...stored, refreshToken: 'second-refresh-token-0001' });
    expect(await readdir(credentialsDir(home))).toEqual(['youtube.json']);
    expect((await readCredentialsFile(path))?.refreshToken).toBe('second-refresh-token-0001');
  });

  it('tightens a folder that is too open', async () => {
    const dir = credentialsDir(home);
    await mkdir(dir, { recursive: true, mode: 0o755 });
    await chmod(dir, 0o755);
    await writeCredentialsFile(credentialsPath(home), stored);
    if (posix) expect(await fileMode(dir)).toBe(0o700);
  });

  it('leaves out a missing client secret', async () => {
    const path = credentialsPath(home);
    await writeCredentialsFile(path, { ...stored, clientSecret: null, scope: null });
    const json = JSON.parse(await readFile(path, 'utf8'));
    expect(json).not.toHaveProperty('client_secret');
    expect(json).not.toHaveProperty('scope');
  });
});

describe('readCredentialsFile', () => {
  it('returns null when there is no file', async () => {
    expect(await readCredentialsFile(credentialsPath(home))).toBeNull();
  });

  it('reads what was written', async () => {
    await writeCredentialsFile(credentialsPath(home), stored);
    expect(await readCredentialsFile(credentialsPath(home))).toEqual(stored);
  });

  it.runIf(posix)('refuses a file that the group or others can read, and says how to fix it', async () => {
    const path = credentialsPath(home);
    await writeCredentialsFile(path, stored);
    for (const mode of [0o640, 0o644, 0o604, 0o666]) {
      await chmod(path, mode);
      const error = await expectConfigError(readCredentialsFile(path));
      expect(error.message).toContain('can be read by other users');
      expect(error.hint).toContain(`chmod 600 ${path}`);
      expect(error.message + (error.hint ?? '')).not.toContain(REFRESH);
    }
    await chmod(path, 0o600);
    expect((await readCredentialsFile(path))?.refreshToken).toBe(REFRESH);
  });

  it.runIf(posix)('accepts a file that only the owner can read, even with mode 0400', async () => {
    const path = credentialsPath(home);
    await writeCredentialsFile(path, stored);
    await chmod(path, 0o400);
    expect((await readCredentialsFile(path))?.clientId).toBe(CLIENT_ID);
  });

  it('skips the mode check on Windows, where there are no mode bits', async () => {
    const path = credentialsPath(home);
    await writeCredentialsFile(path, stored);
    if (posix) await chmod(path, 0o644);
    expect((await readCredentialsFile(path, 'win32'))?.clientId).toBe(CLIENT_ID);
  });

  it('rejects a file that is not valid JSON or has the wrong shape', async () => {
    const path = credentialsPath(home);
    await mkdir(credentialsDir(home), { recursive: true, mode: 0o700 });
    for (const text of ['not json', '{}', '{"client_id":"x"}', '[]', 'null']) {
      await writeFile(path, text, { mode: 0o600 });
      await chmod(path, 0o600);
      const error = await expectConfigError(readCredentialsFile(path));
      expect(error.hint).toContain('mergestory setup youtube');
    }
  });

  it('rejects a folder in place of the file', async () => {
    const path = credentialsPath(home);
    await mkdir(path, { recursive: true });
    await expectConfigError(readCredentialsFile(path));
  });
});

describe('loadCredentials', () => {
  const allEnv: Partial<Record<SecretName, string>> = {
    MERGESTORY_YOUTUBE_CLIENT_ID: CLIENT_ID,
    MERGESTORY_YOUTUBE_CLIENT_SECRET: CLIENT_SECRET,
    MERGESTORY_YOUTUBE_REFRESH_TOKEN: REFRESH,
  };

  it('uses the environment when it holds everything', async () => {
    const credentials = await loadCredentials(context(allEnv));
    expect(credentials).toEqual({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      refreshToken: REFRESH,
      scope: null,
    });
  });

  it.runIf(posix)('does not read the file when the environment holds everything', async () => {
    const path = credentialsPath(home);
    await writeCredentialsFile(path, stored);
    await chmod(path, 0o644); // would be refused if it were read
    expect((await loadCredentials(context(allEnv))).refreshToken).toBe(REFRESH);
  });

  it('falls back to the credentials file', async () => {
    await writeCredentialsFile(credentialsPath(home), stored);
    expect(await loadCredentials(context())).toEqual({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      refreshToken: REFRESH,
      scope: stored.scope,
    });
  });

  it('lets the environment override single values of the file', async () => {
    await writeCredentialsFile(credentialsPath(home), stored);
    const credentials = await loadCredentials(
      context({ MERGESTORY_YOUTUBE_CLIENT_SECRET: 'rotated-client-secret-99' }),
    );
    expect(credentials.clientSecret).toBe('rotated-client-secret-99');
    expect(credentials.refreshToken).toBe(REFRESH);
  });

  it('takes the refresh token from the environment and the client from the file', async () => {
    await writeCredentialsFile(credentialsPath(home), stored);
    const credentials = await loadCredentials(
      context({ MERGESTORY_YOUTUBE_REFRESH_TOKEN: 'env-refresh-token-0123456' }),
    );
    expect(credentials.refreshToken).toBe('env-refresh-token-0123456');
    expect(credentials.clientId).toBe(CLIENT_ID);
    // The file's scopes belong to the file's token.
    expect(credentials.scope).toBeNull();
  });

  it('refuses a client id that differs from the one the saved token was issued to', async () => {
    await writeCredentialsFile(credentialsPath(home), stored);
    const error = await expectConfigError(
      loadCredentials(context({ MERGESTORY_YOUTUBE_CLIENT_ID: 'other.apps.googleusercontent.com' })),
    );
    expect(error.message).toContain('not the client');
  });

  it('works without a client secret', async () => {
    const credentials = await loadCredentials(
      context({ MERGESTORY_YOUTUBE_CLIENT_ID: CLIENT_ID, MERGESTORY_YOUTUBE_REFRESH_TOKEN: REFRESH }),
    );
    expect(credentials.clientSecret).toBeNull();
  });

  it('says what is missing and where to get it', async () => {
    const error = await expectConfigError(
      loadCredentials(context({ MERGESTORY_YOUTUBE_REFRESH_TOKEN: REFRESH })),
    );
    expect(error.message).toBe('No YouTube sign-in was found.');
    expect(error.hint).toContain('mergestory setup youtube');
    expect(error.hint).toContain('MERGESTORY_YOUTUBE_CLIENT_ID');
    const none = await expectConfigError(loadCredentials(context()));
    expect(none.hint).toContain('MERGESTORY_YOUTUBE_REFRESH_TOKEN');
  });

  it('registers every value with the redactor', async () => {
    const ctx = context(allEnv);
    await loadCredentials(ctx);
    for (const value of [CLIENT_ID, CLIENT_SECRET, REFRESH]) {
      expect(ctx.redactor.redact(`value=${value}`)).toBe(`value=${REDACTED}`);
    }
  });

  it('registers values read from the file too', async () => {
    await writeCredentialsFile(credentialsPath(home), stored);
    const ctx = context();
    await loadCredentials(ctx);
    expect(ctx.redactor.redact(`token ${REFRESH} secret ${CLIENT_SECRET}`)).toBe(
      `token ${REDACTED} secret ${REDACTED}`,
    );
  });

  it.runIf(posix)('refuses a readable file when it is needed', async () => {
    const path = credentialsPath(home);
    await writeCredentialsFile(path, stored);
    await chmod(path, 0o644);
    const error = await expectConfigError(loadCredentials(context()));
    expect(error.hint).toContain('chmod 600');
  });
});
