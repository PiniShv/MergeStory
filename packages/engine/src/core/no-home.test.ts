/**
 * A user with no home folder. Some containers run as a user id that the password file does not
 * list, and with HOME unset the system then cannot name a home folder at all: asking for it throws.
 * MergeStory must still work there once MERGESTORY_HOME is set.
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { locateBrowser } from '../render/browser.ts';
import { testConfig, testContext } from '../testing/context.ts';
import { MergeStoryError } from './errors.ts';
import { adoptHomeFolder, homeLayout, mergestoryHome, usableHome } from './paths.ts';

/** What the system answers when it is asked for the home folder. A test can change it. */
const system = vi.hoisted(() => ({
  home: (): string => {
    throw new Error('A system error occurred: uv_os_homedir returned ENOENT (no such file or directory)');
  },
}));

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => system.home(),
}));

const noHome = system.home;
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'mergestory-no-home-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  system.home = noHome;
});

async function executable(name: string): Promise<string> {
  const path = join(root, name);
  await mkdir(root, { recursive: true });
  await writeFile(path, '#!/bin/sh\n');
  await chmod(path, 0o755);
  return path;
}

describe('the MergeStory home of a user with no home folder', () => {
  it('is the folder of MERGESTORY_HOME, or of the home setting', () => {
    vi.stubEnv('MERGESTORY_HOME', join(root, 'data'));
    expect(mergestoryHome()).toBe(join(root, 'data'));
    expect(homeLayout().runs).toBe(join(root, 'data', 'runs'));
    expect(mergestoryHome(join(root, 'other'))).toBe(join(root, 'other'));
  });

  it('is an error that names the variable to set, when nothing says where it is', () => {
    vi.stubEnv('MERGESTORY_HOME', '');
    let error: unknown;
    try {
      mergestoryHome();
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(MergeStoryError);
    expect(error).toMatchObject({ code: 'CONFIG_INVALID' });
    expect((error as MergeStoryError).message).toContain('no home folder');
    expect((error as MergeStoryError).hint).toContain('MERGESTORY_HOME');
  });
});

describe('the home folder of the process, for a user with none', () => {
  it('becomes the MergeStory home when a run starts, so that what the run loads and starts has one', () => {
    vi.stubEnv('HOME', undefined);
    testContext({ home: join(root, 'data') });
    expect(process.env.HOME).toBe(join(root, 'data'));
    adoptHomeFolder(join(root, 'other'));
    expect(process.env.HOME).toBe(join(root, 'other'));
  });

  it('also when HOME is empty or a relative path, which would lead into the current folder', () => {
    for (const home of ['', 'relative/home', '.']) {
      system.home = () => home;
      vi.stubEnv('HOME', home);
      expect(usableHome(), JSON.stringify(home)).toBeNull();
      adoptHomeFolder(join(root, 'data'));
      expect(process.env.HOME, JSON.stringify(home)).toBe(join(root, 'data'));
      vi.stubEnv('MERGESTORY_HOME', '');
      expect(() => mergestoryHome(), JSON.stringify(home)).toThrow('no home folder');
    }
  });

  it('is left alone when the system names a home folder, also one that does not exist', () => {
    system.home = () => '/nonexistent';
    vi.stubEnv('HOME', '/nonexistent');
    expect(usableHome()).toBe('/nonexistent');
    adoptHomeFolder(join(root, 'data'));
    expect(process.env.HOME).toBe('/nonexistent');
  });
});

describe('finding a browser for a user with no home folder', () => {
  /** Nothing from playwright-core, no system browsers, nothing on PATH: only what a test adds. */
  const nothing = {
    platform: 'linux' as const,
    playwrightChromium: null,
    systemCandidates: [],
    pathNames: [],
  };

  it('uses the browser that MERGESTORY_BROWSER_PATH names', async () => {
    const path = await executable('chrome-from-env');
    const found = await locateBrowser(testConfig(), { ...nothing, env: { MERGESTORY_BROWSER_PATH: path } });
    expect(found).toEqual({ path, source: 'env' });
  });

  it('still searches the folder of PLAYWRIGHT_BROWSERS_PATH and the system', async () => {
    const shell = join('browsers', 'chromium_headless_shell-1200', 'chrome-headless-shell-linux64');
    await mkdir(join(root, shell), { recursive: true });
    const cached = await executable(join(shell, 'chrome-headless-shell'));
    const fromCache = await locateBrowser(testConfig(), {
      ...nothing,
      env: { PLAYWRIGHT_BROWSERS_PATH: join(root, 'browsers') },
    });
    expect(fromCache).toEqual({ path: cached, source: 'playwright-cache' });

    const system = await executable('system-chrome');
    const fromSystem = await locateBrowser(testConfig(), { ...nothing, env: {}, systemCandidates: [system] });
    expect(fromSystem).toEqual({ path: system, source: 'system' });
  });

  it('says that no browser was found, instead of failing on the missing home folder', async () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      await expect(locateBrowser(testConfig(), { ...nothing, platform, env: {} })).rejects.toMatchObject({
        code: 'BROWSER_NOT_FOUND',
      });
    }
  });

  it('goes through its own list of system browsers without a home folder', async () => {
    // The built-in list this time. A browser of this machine may be found, and nothing else may happen.
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const outcome = await locateBrowser(testConfig(), {
        platform,
        env: {},
        playwrightChromium: null,
        pathNames: [],
      }).then(
        (found) => found.source,
        (error: MergeStoryError) => error.code,
      );
      expect(['system', 'BROWSER_NOT_FOUND'], platform).toContain(outcome);
    }
  });

  it('never looks under the current folder when HOME is empty or relative', async () => {
    // A browser planted where a relative home would lead: in the current folder, like a file of a repository.
    const repository = await mkdtemp(join(root, 'repository-'));
    const planted = [
      '.cache',
      'ms-playwright',
      'chromium_headless_shell-1200',
      'chrome-headless-shell-linux64',
    ];
    await mkdir(join(repository, ...planted), { recursive: true });
    const program = join(repository, ...planted, 'chrome-headless-shell');
    await writeFile(program, '#!/bin/sh\n');
    await chmod(program, 0o755);
    const before = process.cwd();
    process.chdir(repository);
    try {
      for (const home of ['', '.', 'relative']) {
        system.home = () => home;
        await expect(
          locateBrowser(testConfig(), { ...nothing, env: {} }),
          JSON.stringify(home),
        ).rejects.toMatchObject({ code: 'BROWSER_NOT_FOUND' });
        // The browser library's own path is not trusted either when it is relative.
        await expect(
          locateBrowser(testConfig(), {
            ...nothing,
            env: {},
            playwrightChromium: join('.cache', 'ms-playwright', 'chromium-1200', 'chrome-linux', 'chrome'),
          }),
          JSON.stringify(home),
        ).rejects.toMatchObject({ code: 'BROWSER_NOT_FOUND' });
      }
    } finally {
      process.chdir(before);
    }
  });
});
