import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MergeStoryError } from '../../core/errors.ts';
import type { SignInOptions, SignInResult } from '../../publish/youtube/sign-in.ts';
import { createIo } from '../io.ts';
import { runCli } from '../program.ts';
import { CliRuntime } from '../runtime.ts';
import { registerSetup, type SetupDeps } from './setup.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mergestory-setup-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

async function runReal(argv: string[], env: Record<string, string> = {}) {
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

/** Run the setup command with replaced terminal, browser and sign-in. */
async function runWith(argv: string[], deps: SetupDeps, env: Record<string, string> = {}) {
  let stdout = '';
  let stderr = '';
  const io = createIo({
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
  const rt = new CliRuntime(io, new AbortController().signal);
  const program = new Command('mergestory').exitOverride().option('--json');
  registerSetup(program, rt, deps);
  await program.parseAsync(argv, { from: 'user' });
  return { stdout, stderr };
}

const result: SignInResult = {
  credentialsFile: '/somewhere/credentials/youtube.json',
  scopes: ['https://www.googleapis.com/auth/youtube.upload'],
};

describe('mergestory setup', () => {
  it('lists YouTube next to Kokoro, with Kokoro first', async () => {
    const { code, stdout } = await runReal(['setup']);
    expect(code).toBe(0);
    expect(stdout).toContain('mergestory setup kokoro');
    expect(stdout).toContain('mergestory setup youtube');
    expect(stdout).toContain('sign in to YouTube');
    const json = await runReal(['setup', '--json']);
    expect(JSON.parse(json.stdout).targets.map((t: { name: string }) => t.name)).toEqual([
      'kokoro',
      'youtube',
    ]);
  });

  it('still rejects an unknown target', async () => {
    const { code, stderr } = await runReal(['setup', 'whisper']);
    expect(code).toBe(2);
    expect(stderr).toContain('whisper');
    expect(stderr).toContain('kokoro, youtube');
  });
});

describe('mergestory setup youtube', () => {
  it('refuses to run without a person at a terminal, and says what to do', async () => {
    // Whatever the terminal running the tests is, this run has no person typing.
    const before = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    let outcome: Awaited<ReturnType<typeof runReal>>;
    try {
      outcome = await runReal(['setup', 'youtube']);
    } finally {
      if (before) Object.defineProperty(process.stdin, 'isTTY', before);
      else Reflect.deleteProperty(process.stdin, 'isTTY');
    }
    const { code, stderr, stdout } = outcome;
    expect(code).toBe(2);
    expect(stderr).toContain('needs a person at a terminal');
    expect(stderr).toContain('MERGESTORY_YOUTUBE_REFRESH_TOKEN');
    expect(stderr).toContain('docs/youtube.md in the MergeStory repository');
    expect(stdout).toBe('');
  });

  it('gives the sign-in the configuration, the home folder, the environment and the terminal', async () => {
    const signIn = vi.fn(async (options: SignInOptions) => {
      options.io.say('Sign in to YouTube');
      expect(await options.io.askHidden('Client id: ')).toBe('typed-value');
      expect(await options.io.openBrowser('https://accounts.google.com/x')).toBe(true);
      return result;
    });
    const asked: string[] = [];
    const opened: string[] = [];
    const { stdout } = await runWith(
      ['setup', 'youtube'],
      {
        terminal: () => ({
          interactive: true,
          askHidden: async (question) => {
            asked.push(question);
            return 'typed-value';
          },
        }),
        openBrowser: async (url) => {
          opened.push(url);
          return true;
        },
        signIn,
      },
      { MERGESTORY_YOUTUBE_CLIENT_ID: 'client-from-env.apps.googleusercontent.com' },
    );
    const [options] = signIn.mock.calls[0] ?? [];
    expect(options?.ctx.home.home).toBe(join(dir, 'home'));
    expect(options?.ctx.config.publish.youtube.privacyStatus).toBe('unlisted');
    expect(options?.ctx.secrets.get('MERGESTORY_YOUTUBE_CLIENT_ID')).toBe(
      'client-from-env.apps.googleusercontent.com',
    );
    expect(options?.ctx.signal).toBeInstanceOf(AbortSignal);
    expect(options?.io.interactive).toBe(true);
    expect(asked).toEqual(['Client id: ']);
    expect(opened).toEqual(['https://accounts.google.com/x']);
    expect(stdout).toBe('Sign in to YouTube\n');
  });

  it('reads the settings that decide which permissions to ask for', async () => {
    const signIn = vi.fn(async (_options: SignInOptions) => result);
    await runWith(
      ['setup', 'youtube'],
      { terminal: () => ({ interactive: true, askHidden: async () => '' }), signIn },
      { MERGESTORY_YOUTUBE_PLAYLIST_ID: 'PLabcdefghijklmn' },
    );
    expect(signIn.mock.calls[0]?.[0].ctx.config.publish.youtube.playlistId).toBe('PLabcdefghijklmn');
  });

  it('prints one JSON document with the file and the scopes, and nothing else', async () => {
    const { stdout } = await runWith(['--json', 'setup', 'youtube'], {
      terminal: () => ({ interactive: true, askHidden: async () => '' }),
      signIn: async (options) => {
        options.io.say('This is dropped in JSON mode.');
        return result;
      },
    });
    expect(JSON.parse(stdout)).toEqual({ ok: true, youtube: result });
    expect(stdout).not.toContain('refresh');
    expect(stdout).not.toContain('token');
  });

  it('passes a failure on with its code and hint', async () => {
    const error = new MergeStoryError('CONFIG_INVALID', 'The sign-in timed out.', { hint: 'Run it again.' });
    const promise = runWith(['setup', 'youtube'], {
      terminal: () => ({ interactive: true, askHidden: async () => '' }),
      signIn: async () => {
        throw error;
      },
    });
    await expect(promise).rejects.toBe(error);
  });

  it('does not touch the Kokoro installer', async () => {
    const signIn = vi.fn(async () => result);
    const { stdout } = await runWith(['setup', 'youtube'], {
      terminal: () => ({ interactive: true, askHidden: async () => '' }),
      signIn,
    });
    expect(stdout).not.toContain('Kokoro');
  });
});
