import { stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig, type SecretName, Secrets } from '../../core/config.ts';
import { MergeStoryError } from '../../core/errors.ts';
import { homeLayout } from '../../core/paths.ts';
import { Redactor } from '../../core/redact.ts';
import {
  DRIVE_SCOPE,
  FAKE_CLIENT_ID,
  FAKE_CLIENT_SECRET,
  type FakeGoogle,
  makeTempDir,
  removeDir,
  startFakeGoogle,
  UPLOAD_SCOPE,
} from '../../testing/youtube.ts';
import { credentialsPath, readCredentialsFile } from '../google/credentials.ts';
import type { SignInOptions } from '../google/sign-in.ts';
import { runYouTubeSignIn } from '../youtube/sign-in.ts';
import { DRIVE, runDriveSignIn } from './provider.ts';

let home: string;
let fake: FakeGoogle;

beforeEach(async () => {
  home = await makeTempDir('mergestory-drive-signin-');
  // Grants both services' scopes, so one fake serves both sign-ins.
  fake = await startFakeGoogle({ scope: `${DRIVE_SCOPE} ${UPLOAD_SCOPE}` });
});

afterEach(async () => {
  await fake.stop();
  await removeDir(home);
});

function get(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        agent: false,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve());
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const BOTH = {
  MERGESTORY_DRIVE_CLIENT_ID: FAKE_CLIENT_ID,
  MERGESTORY_DRIVE_CLIENT_SECRET: FAKE_CLIENT_SECRET,
};

/** A sign-in where the browser finishes at once. `interactive` and `ci` describe the terminal and CI. */
function options(
  secrets: Partial<Record<SecretName, string>>,
  io: { interactive: boolean; ci?: boolean },
): { options: SignInOptions; said: string[]; asked: string[]; scopes: string[] } {
  const said: string[] = [];
  const scopes: string[] = [];
  const asked: string[] = [];
  return {
    said,
    asked,
    scopes,
    options: {
      ctx: {
        config: resolveConfig({ skipFile: true, env: {}, overrides: { home } }),
        secrets: new Secrets(secrets, new Redactor()),
        redactor: new Redactor(),
        home: homeLayout(home),
        signal: new AbortController().signal,
      },
      io: {
        ...io,
        say: (text) => void said.push(text),
        askHidden: async (question) => {
          asked.push(question);
          return question.includes('secret') ? FAKE_CLIENT_SECRET : FAKE_CLIENT_ID;
        },
        openBrowser: async (url) => {
          const params = new URL(url).searchParams;
          scopes.push(params.get('scope') ?? '');
          const redirect = params.get('redirect_uri') ?? '';
          fake.expectAuthCode('code-1', params.get('code_challenge') ?? '', redirect);
          await get(`${redirect}?code=code-1&state=${params.get('state')}`);
          return true;
        },
      },
      endpoints: {
        apiBase: fake.url,
        tokenUrl: `${fake.url}/token`,
        authUrl: 'https://accounts.google.test/auth',
      },
      timing: { maxRetries: 2, minDelayMs: 1, maxDelayMs: 5, requestTimeoutMs: 5_000 },
    },
  };
}

describe('mergestory setup drive', () => {
  it('asks for drive.file only, and saves the sign-in in drive.json that only the user can read', async () => {
    const run = options({}, { interactive: true });
    const result = await runDriveSignIn(run.options);
    expect(run.scopes).toEqual([DRIVE_SCOPE]);
    expect(result.scopes).toContain(DRIVE_SCOPE);
    const file = credentialsPath(home, DRIVE);
    expect(result.credentialsFile).toBe(file);
    expect(file.endsWith('credentials/drive.json')).toBe(true);
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await readCredentialsFile(file, DRIVE))?.scope).toContain(DRIVE_SCOPE);
    const text = run.said.join('\n');
    expect(text).toContain('Sign in to Google Drive');
    expect(text).toContain('drive.file: only the files and the folder that MergeStory creates');
    expect(text).toContain('MERGESTORY_DRIVE_REFRESH_TOKEN');
    expect(run.asked).toEqual(['OAuth client id: ', 'OAuth client secret (Enter to skip): ']);
    expect(text).toContain(
      'In this environment: MERGESTORY_DRIVE_CLIENT_ID is not set, MERGESTORY_DRIVE_CLIENT_SECRET is not set.',
    );
  });
});

describe('the sign-in without a terminal', () => {
  const services = [
    { name: 'drive', signIn: runDriveSignIn, prefix: 'MERGESTORY_DRIVE' },
    { name: 'youtube', signIn: runYouTubeSignIn, prefix: 'MERGESTORY_YOUTUBE' },
  ] as const;

  for (const { name, signIn, prefix } of services) {
    const both = { [`${prefix}_CLIENT_ID`]: FAKE_CLIENT_ID, [`${prefix}_CLIENT_SECRET`]: FAKE_CLIENT_SECRET };

    it(`${name}: runs when the client id and secret both come from the environment and CI is not set`, async () => {
      const run = options(both, { interactive: false, ci: false });
      const result = await signIn(run.options);
      expect(run.asked).toEqual([]);
      expect(run.said.join('\n')).toContain('Open this address in your browser to sign in:');
      expect(result.credentialsFile.endsWith(`${name}.json`)).toBe(true);
    });

    for (const [why, secrets, ci] of [
      ['only the client id is in the environment', { [`${prefix}_CLIENT_ID`]: FAKE_CLIENT_ID }, false],
      ['nothing is in the environment', {}, false],
      ['CI is set', both, true],
      ['nobody says whether CI is set', both, undefined],
    ] as const) {
      it(`${name}: refuses when ${why}`, async () => {
        const run = options(secrets, { interactive: false, ...(ci === undefined ? {} : { ci }) });
        const error = await signIn(run.options).catch((err: unknown) => err);
        expect(error).toBeInstanceOf(MergeStoryError);
        expect((error as MergeStoryError).message).toContain('needs a person at a terminal');
        expect((error as MergeStoryError).hint).toContain(`${prefix}_REFRESH_TOKEN`);
        expect((error as MergeStoryError).hint).toContain(`docs/${name}.md`);
        const id = `${prefix}_CLIENT_ID` in secrets ? 'set' : 'not set';
        expect((error as MergeStoryError).hint).toContain(`${prefix}_CLIENT_ID is ${id}`);
        // Names only: the hint never carries a value.
        expect((error as MergeStoryError).hint).not.toContain(FAKE_CLIENT_ID);
        expect(fake.requests).toEqual([]);
      });
    }
  }

  it('reads the drive variables, not the YouTube ones', async () => {
    const run = options(BOTH, { interactive: false, ci: false });
    await expect(runYouTubeSignIn(run.options)).rejects.toThrow('needs a person at a terminal');
  });
});
