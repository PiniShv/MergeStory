import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../core/config.ts';
import { testConfig } from '../testing/context.ts';
import { type BrowserLookup, locateBrowser } from './browser.ts';
import { resolveBrowserExecutable } from './index.ts';

let root: string;
let home: string;
let n = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'mergestory-browser-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  home = join(root, `home-${n++}`);
  await mkdir(home, { recursive: true });
});

async function executable(path: string, mode = 0o755): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '#!/bin/sh\n');
  await chmod(path, mode);
  return path;
}

/** A search that sees only fake folders: no system browsers, nothing on PATH, nothing from playwright-core. */
function isolated(extra: BrowserLookup = {}): BrowserLookup {
  return {
    env: {},
    platform: 'darwin',
    homeDir: home,
    playwrightChromium: null,
    systemCandidates: [],
    pathNames: [],
    ...extra,
  };
}

const MAC_SHELL = (rev: number) =>
  join(
    'Library',
    'Caches',
    'ms-playwright',
    `chromium_headless_shell-${rev}`,
    'chrome-headless-shell-mac-arm64',
    'chrome-headless-shell',
  );
const MAC_CHROMIUM = (rev: number) =>
  join(
    'Library',
    'Caches',
    'ms-playwright',
    `chromium-${rev}`,
    'chrome-mac-arm64',
    'Google Chrome for Testing.app',
    'Contents',
    'MacOS',
    'Google Chrome for Testing',
  );

const config = (browserPath: string | null = null): Config => testConfig({ render: { browserPath } });

describe('locateBrowser: explicit settings', () => {
  it('uses the configured path first', async () => {
    const configured = await executable(join(home, 'configured', 'chrome'));
    const fromEnv = await executable(join(home, 'env', 'chrome'));
    const found = await locateBrowser(
      config(configured),
      isolated({ env: { MERGESTORY_BROWSER_PATH: fromEnv } }),
    );
    expect(found).toEqual({ path: configured, source: 'config' });
  });

  it('uses MERGESTORY_BROWSER_PATH next', async () => {
    const fromEnv = await executable(join(home, 'env', 'chrome'));
    await executable(join(home, MAC_SHELL(1200)));
    expect(await locateBrowser(config(), isolated({ env: { MERGESTORY_BROWSER_PATH: fromEnv } }))).toEqual({
      path: fromEnv,
      source: 'env',
    });
  });

  it('does not fall back silently when an explicit path is wrong', async () => {
    await executable(join(home, MAC_SHELL(1200)));
    await expect(locateBrowser(config(join(home, 'nope', 'chrome')), isolated())).rejects.toMatchObject({
      code: 'BROWSER_NOT_FOUND',
      message: expect.stringContaining('render.browserPath'),
    });
    await expect(
      locateBrowser(config(), isolated({ env: { MERGESTORY_BROWSER_PATH: join(home, 'nope') } })),
    ).rejects.toMatchObject({
      code: 'BROWSER_NOT_FOUND',
      message: expect.stringContaining('MERGESTORY_BROWSER_PATH'),
    });
  });

  it('does not accept a folder or a file that cannot run', async () => {
    await mkdir(join(home, 'folder'), { recursive: true });
    await expect(locateBrowser(config(join(home, 'folder')), isolated())).rejects.toMatchObject({
      code: 'BROWSER_NOT_FOUND',
    });
    const plain = await executable(join(home, 'plain', 'chrome'), 0o644);
    await expect(locateBrowser(config(plain), isolated())).rejects.toMatchObject({
      code: 'BROWSER_NOT_FOUND',
    });
  });
});

describe('locateBrowser: Playwright browsers', () => {
  it('prefers the headless shell that matches playwright-core', async () => {
    const browsers = join(home, 'pw');
    const shell = await executable(
      join(
        browsers,
        'chromium_headless_shell-1248',
        'chrome-headless-shell-mac-arm64',
        'chrome-headless-shell',
      ),
    );
    await executable(join(home, MAC_SHELL(9999))); // a newer one in the default cache must not win
    const own = join(
      browsers,
      'chromium-1248',
      'chrome-mac-arm64',
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing',
    );
    expect(await locateBrowser(config(), isolated({ playwrightChromium: own }))).toEqual({
      path: shell,
      source: 'playwright-cache',
    });
  });

  it('scans the cache: headless shells before full builds, newest first', async () => {
    await executable(join(home, MAC_SHELL(1100)));
    const newest = await executable(join(home, MAC_SHELL(1200)));
    await executable(join(home, MAC_CHROMIUM(1300)));
    expect(await locateBrowser(config(), isolated())).toEqual({ path: newest, source: 'playwright-cache' });
  });

  it('compares revisions as numbers', async () => {
    await executable(join(home, MAC_SHELL(999)));
    const newest = await executable(join(home, MAC_SHELL(1010)));
    expect((await locateBrowser(config(), isolated())).path).toBe(newest);
  });

  it('falls back to a full Chromium when no headless shell is installed', async () => {
    const full = await executable(join(home, MAC_CHROMIUM(1200)));
    expect(await locateBrowser(config(), isolated())).toEqual({ path: full, source: 'playwright-cache' });
  });

  it('finds the Linux cache location', async () => {
    const shell = await executable(
      join(
        home,
        '.cache',
        'ms-playwright',
        'chromium_headless_shell-1200',
        'chrome-headless-shell-linux64',
        'chrome-headless-shell',
      ),
    );
    expect(await locateBrowser(config(), isolated({ platform: 'linux' }))).toEqual({
      path: shell,
      source: 'playwright-cache',
    });
  });

  it('finds the Windows cache location', async () => {
    const local = join(home, 'AppData', 'Local');
    const shell = await executable(
      join(
        local,
        'ms-playwright',
        'chromium_headless_shell-1200',
        'chrome-headless-shell-win64',
        'chrome-headless-shell.exe',
      ),
    );
    expect(
      await locateBrowser(config(), isolated({ platform: 'win32', env: { LOCALAPPDATA: local } })),
    ).toEqual({
      path: shell,
      source: 'playwright-cache',
    });
  });

  it('searches PLAYWRIGHT_BROWSERS_PATH first', async () => {
    await executable(join(home, MAC_SHELL(1200)));
    const custom = await executable(
      join(
        home,
        'custom',
        'chromium_headless_shell-10',
        'chrome-headless-shell-mac-x64',
        'chrome-headless-shell',
      ),
    );
    expect(
      (await locateBrowser(config(), isolated({ env: { PLAYWRIGHT_BROWSERS_PATH: join(home, 'custom') } })))
        .path,
    ).toBe(custom);
  });

  it('skips folders that look like a browser but are not', async () => {
    await mkdir(join(home, MAC_SHELL(1300)), { recursive: true }); // a folder where the executable should be
    const good = await executable(join(home, MAC_SHELL(1200)));
    await executable(
      join(home, 'Library', 'Caches', 'ms-playwright', 'chromium_tip_of_tree-1400', 'chrome-mac', 'chrome'),
    );
    expect((await locateBrowser(config(), isolated())).path).toBe(good);
  });
});

describe('locateBrowser: system browsers', () => {
  it('uses an installed browser when Playwright has none', async () => {
    const system = await executable(join(home, 'apps', 'Google Chrome'));
    expect(
      await locateBrowser(config(), isolated({ systemCandidates: [join(home, 'apps', 'missing'), system] })),
    ).toEqual({
      path: system,
      source: 'system',
    });
  });

  it('lets Playwright browsers win over system browsers', async () => {
    const system = await executable(join(home, 'apps', 'Google Chrome'));
    const shell = await executable(join(home, MAC_SHELL(1200)));
    const found = await locateBrowser(config(), isolated({ systemCandidates: [system] }));
    expect(found.path).toBe(shell);
  });

  it('explains how to install a browser when none is found', async () => {
    const error = await locateBrowser(config(), isolated()).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'BROWSER_NOT_FOUND' });
    const hint = (error as { hint?: string }).hint ?? '';
    expect(hint).toContain('npx playwright install chromium-headless-shell');
    expect(hint).toContain('MERGESTORY_BROWSER_PATH');
  });
});

describe('resolveBrowserExecutable', () => {
  it('delegates to the search with the real machine', async () => {
    const own = await executable(join(home, 'mine', 'chrome'));
    expect(await resolveBrowserExecutable(config(own))).toEqual({ path: own, source: 'config' });
  });
});
