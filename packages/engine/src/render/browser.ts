/**
 * Finding a Chromium-family browser to render with.
 *
 * Order: configured path, MERGESTORY_BROWSER_PATH, the headless shell that matches playwright-core,
 * any Playwright browser cache (headless shells first, newest first), then Chrome, Chromium or Edge
 * installed on the system.
 */
import { constants } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Config } from '../core/config.ts';
import { MergeStoryError } from '../core/errors.ts';
import { which } from '../core/process.ts';
import { loadPlaywright } from './playwright.ts';

export interface BrowserExecutable {
  path: string;
  /** Where it was found: "config", "env", "playwright-cache", "system". */
  source: string;
}

/** Everything the search reads from the machine. Tests replace these to search fake folders. */
export interface BrowserLookup {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
  /** Where playwright-core expects its own Chromium build. Default: ask playwright-core. */
  playwrightChromium?: string | null;
  /** Replaces the built-in list of system browser locations. */
  systemCandidates?: string[];
  /** Replaces the browser names searched on PATH. */
  pathNames?: string[];
}

async function isFile(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    if (platform !== 'win32') await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function listDir(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort();
  } catch {
    return [];
  }
}

async function ownChromiumPath(): Promise<string | null> {
  try {
    return (await loadPlaywright()).chromium.executablePath();
  } catch {
    return null;
  }
}

/** The executable inside one Playwright "chromium_headless_shell-<rev>" folder. */
async function headlessShellIn(revisionDir: string, platform: NodeJS.Platform): Promise<string | null> {
  const exe = platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell';
  for (const entry of await listDir(revisionDir)) {
    if (!entry.startsWith('chrome-headless-shell')) continue;
    const candidate = join(revisionDir, entry, exe);
    if (await isFile(candidate, platform)) return candidate;
  }
  return null;
}

/** The executable inside one Playwright "chromium-<rev>" folder (the full browser). */
async function chromiumIn(revisionDir: string, platform: NodeJS.Platform): Promise<string | null> {
  const relative =
    platform === 'win32'
      ? ['chrome.exe']
      : platform === 'darwin'
        ? [
            join('Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
            join('Chromium.app', 'Contents', 'MacOS', 'Chromium'),
          ]
        : ['chrome'];
  for (const entry of await listDir(revisionDir)) {
    if (!entry.startsWith('chrome-')) continue;
    for (const tail of relative) {
      const candidate = join(revisionDir, entry, tail);
      if (await isFile(candidate, platform)) return candidate;
    }
  }
  return null;
}

function revisionOf(name: string, prefix: string): number | null {
  if (!name.startsWith(prefix)) return null;
  const revision = Number(name.slice(prefix.length));
  return Number.isInteger(revision) ? revision : null;
}

/** Playwright browser folders, in the order they are searched. */
function playwrightCacheDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string[] {
  const custom = env.PLAYWRIGHT_BROWSERS_PATH;
  const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
  const defaults = {
    darwin: join(home, 'Library', 'Caches', 'ms-playwright'),
    linux: join(home, '.cache', 'ms-playwright'),
    win32: join(local, 'ms-playwright'),
  };
  const own =
    platform === 'darwin' ? defaults.darwin : platform === 'win32' ? defaults.win32 : defaults.linux;
  const dirs = [own, defaults.darwin, defaults.linux, defaults.win32];
  if (custom && custom !== '0') dirs.unshift(custom);
  return [...new Set(dirs)];
}

/** Search the cache folders in order. In each folder, headless shells come before full builds, newest first. */
async function searchPlaywrightCaches(dirs: string[], platform: NodeJS.Platform): Promise<string | null> {
  for (const root of dirs) {
    const found: Array<{ dir: string; revision: number; shell: boolean }> = [];
    for (const name of await listDir(root)) {
      const shell = revisionOf(name, 'chromium_headless_shell-');
      const full = revisionOf(name, 'chromium-');
      if (shell !== null) found.push({ dir: join(root, name), revision: shell, shell: true });
      else if (full !== null) found.push({ dir: join(root, name), revision: full, shell: false });
    }
    found.sort((a, b) => Number(b.shell) - Number(a.shell) || b.revision - a.revision);
    for (const entry of found) {
      const exe = entry.shell
        ? await headlessShellIn(entry.dir, platform)
        : await chromiumIn(entry.dir, platform);
      if (exe) return exe;
    }
  }
  return null;
}

/** The headless shell that belongs to the installed playwright-core, if it has been downloaded. */
async function ownHeadlessShell(
  playwrightChromium: string | null,
  platform: NodeJS.Platform,
): Promise<string | null> {
  if (!playwrightChromium) return null;
  let dir = dirname(playwrightChromium);
  for (let depth = 0; depth < 8 && dir !== dirname(dir); depth++, dir = dirname(dir)) {
    const revision = revisionOf(basename(dir), 'chromium-');
    if (revision === null) continue;
    return headlessShellIn(join(dirname(dir), `chromium_headless_shell-${revision}`), platform);
  }
  return null;
}

function systemBrowsers(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string[] {
  if (platform === 'darwin') {
    const apps = [
      ['Google Chrome.app', 'Google Chrome'],
      ['Chromium.app', 'Chromium'],
      ['Microsoft Edge.app', 'Microsoft Edge'],
      ['Brave Browser.app', 'Brave Browser'],
    ] as const;
    return [join('/Applications'), join(home, 'Applications')].flatMap((root) =>
      apps.map(([app, exe]) => join(root, app, 'Contents', 'MacOS', exe)),
    );
  }
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter((v): v is string =>
      Boolean(v),
    );
    return roots.flatMap((root) => [
      join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(root, 'Chromium', 'Application', 'chrome.exe'),
    ]);
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
  ];
}

const PATH_NAMES = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'microsoft-edge',
  'microsoft-edge-stable',
];

function notFound(): MergeStoryError {
  return new MergeStoryError(
    'BROWSER_NOT_FOUND',
    'No Chromium-based browser was found to render the video.',
    {
      hint:
        'Run "npx playwright install chromium-headless-shell", or set MERGESTORY_BROWSER_PATH ' +
        '(or render.browserPath in the config) to a Chrome, Chromium or Edge executable.',
    },
  );
}

function configuredMissing(source: string, path: string): MergeStoryError {
  return new MergeStoryError('BROWSER_NOT_FOUND', `The browser set by ${source} was not found: ${path}`, {
    hint: 'Fix the path, or unset it to let MergeStory look for a browser itself.',
  });
}

/**
 * Locate a browser. An explicitly configured path is never replaced silently: when it does not
 * exist the search stops with an error instead of falling through to another browser.
 */
export async function locateBrowser(
  config: Pick<Config, 'render'>,
  lookup: BrowserLookup = {},
): Promise<BrowserExecutable> {
  const env = lookup.env ?? process.env;
  const platform = lookup.platform ?? process.platform;
  const home = lookup.homeDir ?? homedir();

  const configured = config.render.browserPath?.trim();
  if (configured) {
    if (await isFile(configured, platform)) return { path: configured, source: 'config' };
    throw configuredMissing('render.browserPath', configured);
  }
  const fromEnv = env.MERGESTORY_BROWSER_PATH?.trim();
  if (fromEnv) {
    if (await isFile(fromEnv, platform)) return { path: fromEnv, source: 'env' };
    throw configuredMissing('MERGESTORY_BROWSER_PATH', fromEnv);
  }

  const own = await ownHeadlessShell(
    lookup.playwrightChromium === undefined ? await ownChromiumPath() : lookup.playwrightChromium,
    platform,
  );
  if (own) return { path: own, source: 'playwright-cache' };

  const cached = await searchPlaywrightCaches(playwrightCacheDirs(env, platform, home), platform);
  if (cached) return { path: cached, source: 'playwright-cache' };

  for (const candidate of lookup.systemCandidates ?? systemBrowsers(platform, env, home)) {
    if (await isFile(candidate, platform)) return { path: candidate, source: 'system' };
  }
  if (platform !== 'win32') {
    for (const name of lookup.pathNames ?? PATH_NAMES) {
      const found = await which(name);
      if (found) return { path: found, source: 'system' };
    }
  }
  throw notFound();
}
