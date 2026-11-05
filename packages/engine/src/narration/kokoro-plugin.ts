/**
 * The Kokoro voice plugin. It is not a dependency of the engine (it adds about 400 MB of
 * packages): the first English run, or `mergestory setup kokoro`, installs a locked package tree
 * into $MERGESTORY_HOME/plugins.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECRET_ENV_VARS } from '../core/config.ts';
import type { RunContext } from '../core/context.ts';
import { MergeStoryError } from '../core/errors.ts';
import { randomToken } from '../core/ids.ts';
import { runCommand } from '../core/process.ts';
import { isKokoroModelCached, type KokoroDtype, kokoroDtype } from './kokoro-model.ts';

export interface LocalVoiceStatus {
  installed: boolean;
  /** Plugin directory under $MERGESTORY_HOME. */
  location: string;
  version: string | null;
  modelCached: boolean;
}

/**
 * Exact versions of the plugin packages. The packages they depend on are pinned by the lockfile
 * that ships with MergeStory (KOKORO_PLUGIN_LOCKFILE), which `npm ci` installs exactly, with an
 * integrity hash for every package.
 */
export const KOKORO_PLUGIN_PACKAGES = {
  '@huggingface/transformers': '3.8.1',
  'kokoro-js': '1.2.1',
  phonemizer: '1.2.1',
} as const;

/** The plugin's package-lock.json, in the assets folder of the MergeStory package. */
export const KOKORO_PLUGIN_LOCKFILE = fileURLToPath(
  new URL('../../assets/kokoro-plugin/package-lock.json', import.meta.url),
);

const LOADER_FILE = 'mergestory-kokoro-loader.mjs';

/**
 * Written last by an install. A plugin folder without it, or with another version in it, is an
 * install that was cut off (killed, crashed, disk full) or is out of date, so it counts as missing.
 */
export const KOKORO_INSTALLED_MARKER = 'mergestory-kokoro-installed.json';

/** Where the plugin packages are downloaded from (the hosts in the shipped lockfile). */
export const KOKORO_PACKAGES_HOST = 'registry.npmjs.org';

/** Rough size of the plugin packages, in megabytes. */
export const KOKORO_PACKAGES_MB = 400;

/** The longest an install may take. A lock older than this belongs to an install that hung. */
export const KOKORO_INSTALL_TIMEOUT_MS = 15 * 60_000;

/**
 * Small module that loads both packages from the plugin folder. Importing them through one
 * file makes Node resolve them the same way kokoro-js does, so the settings applied to
 * transformers.js reach the copy that kokoro-js actually uses.
 */
const LOADER_SOURCE = `// Written by MergeStory. Loads the optional Kokoro voice from this folder.
export { KokoroTTS } from 'kokoro-js';
export { env } from '@huggingface/transformers';
`;

export function pluginsDir(ctx: Pick<RunContext, 'home'>): string {
  return join(ctx.home.home, 'plugins');
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Version of kokoro-js in the plugin folder, or null when it (or transformers.js) is missing. */
async function packagesVersion(dir: string): Promise<string | null> {
  const kokoro = await readJson(join(dir, 'node_modules', 'kokoro-js', 'package.json'));
  const transformers = await readJson(
    join(dir, 'node_modules', '@huggingface', 'transformers', 'package.json'),
  );
  if (!kokoro || !transformers) return null;
  return typeof kokoro.version === 'string' ? kokoro.version : null;
}

/**
 * Version of the installed plugin, or null when it is not installed: the packages are missing,
 * the completion marker is missing, or either one is not the pinned version.
 */
export async function installedKokoroVersion(dir: string): Promise<string | null> {
  const pinned = KOKORO_PLUGIN_PACKAGES['kokoro-js'];
  const marker = await readJson(join(dir, KOKORO_INSTALLED_MARKER));
  if (marker?.version !== pinned) return null;
  return (await packagesVersion(dir)) === pinned ? pinned : null;
}

/** Whether the Kokoro voice is installed and complete. */
export async function isKokoroInstalled(ctx: Pick<RunContext, 'home'>): Promise<boolean> {
  return (await installedKokoroVersion(pluginsDir(ctx))) !== null;
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const temp = `${path}.${randomToken(4)}.tmp`;
  await writeFile(temp, text, { mode: 0o600 });
  await rename(temp, path);
}

/** Write the loader module if it is missing or out of date. Returns its path. */
export async function ensureLoaderFile(dir: string): Promise<string> {
  const path = join(dir, LOADER_FILE);
  let current: string | null = null;
  try {
    current = await readFile(path, 'utf8');
  } catch {
    // not written yet
  }
  if (current !== LOADER_SOURCE) await writeAtomic(path, LOADER_SOURCE);
  return path;
}

export async function kokoroStatus(ctx: RunContext): Promise<LocalVoiceStatus> {
  const location = pluginsDir(ctx);
  const version = await installedKokoroVersion(location);
  let dtype: KokoroDtype;
  try {
    dtype = kokoroDtype();
  } catch {
    // A bad MERGESTORY_KOKORO_DTYPE is reported when the voice is used, not by a status check.
    dtype = kokoroDtype({});
  }
  return {
    installed: version !== null,
    location,
    version,
    modelCached: await isKokoroModelCached(ctx.home.models, dtype),
  };
}

/** The environment for npm: ours, without any API keys or tokens. */
function npmEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of SECRET_ENV_VARS) delete env[name];
  env.npm_config_update_notifier = 'false';
  env.npm_config_fund = 'false';
  env.npm_config_audit = 'false';
  // Only matters for scripts, which are skipped, but keeps a CUDA download from ever starting.
  env.ONNXRUNTIME_NODE_INSTALL_CUDA = 'skip';
  return env;
}

/** How to install the plugin by hand, where the automatic install is not available. */
export function kokoroManualInstall(dir: string): string {
  return `Install by hand: create ${dir}/package.json with these exact dependencies: ${JSON.stringify(KOKORO_PLUGIN_PACKAGES)}, copy ${KOKORO_PLUGIN_LOCKFILE} next to it, run "npm ci --ignore-scripts" there, then create ${join(dir, KOKORO_INSTALLED_MARKER)} containing ${JSON.stringify({ version: KOKORO_PLUGIN_PACKAGES['kokoro-js'] })}.`;
}

export interface InstallDeps {
  run?: typeof runCommand;
  platform?: NodeJS.Platform;
}

/** The shipped lockfile, after checking that it locks exactly the pinned packages. */
export async function readKokoroLockfile(path = KOKORO_PLUGIN_LOCKFILE): Promise<string> {
  let text: string | null = null;
  let locked: Record<string, unknown> = {};
  try {
    text = await readFile(path, 'utf8');
    const lock = JSON.parse(text) as {
      packages?: Record<string, { dependencies?: Record<string, unknown> }>;
    };
    locked = lock.packages?.['']?.dependencies ?? {};
  } catch {
    text = null;
  }
  const pinned = Object.entries(KOKORO_PLUGIN_PACKAGES);
  const matches =
    Object.keys(locked).length === pinned.length &&
    pinned.every(([name, version]) => locked[name] === version);
  if (text === null || !matches) {
    throw new MergeStoryError('TTS_FAILED', 'The lockfile of the Kokoro voice is missing or out of date.', {
      hint: `Reinstall MergeStory. The file belongs at ${path}.`,
    });
  }
  return text;
}

/**
 * Install the locked Kokoro packages into the plugin folder with `npm ci`, which installs exactly
 * the package tree of the shipped lockfile and checks every download against its hash. Install
 * scripts are skipped: the ONNX runtime ships its CPU binaries inside the package (its script only
 * fetches optional GPU libraries), and the image library is not used for speech.
 */
export async function installKokoro(ctx: RunContext, deps: InstallDeps = {}): Promise<LocalVoiceStatus> {
  const run = deps.run ?? runCommand;
  const platform = deps.platform ?? process.platform;
  const dir = pluginsDir(ctx);
  const manual = kokoroManualInstall(dir);
  if (platform === 'win32') {
    throw new MergeStoryError(
      'TTS_FAILED',
      'Automatic install of the Kokoro voice is not supported on Windows yet.',
      {
        hint: manual,
      },
    );
  }
  const lockfile = await readKokoroLockfile();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // From here until the marker is written again, the folder does not count as installed.
  await rm(join(dir, KOKORO_INSTALLED_MARKER), { force: true });
  const manifest = {
    name: 'mergestory-plugins',
    private: true,
    description: 'Optional MergeStory plugins. Managed by `mergestory setup`.',
    type: 'module',
    dependencies: KOKORO_PLUGIN_PACKAGES,
  };
  await writeAtomic(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeAtomic(join(dir, 'package-lock.json'), lockfile);
  ctx.logger.info('Installing the Kokoro voice packages (about 400 MB)');
  // Nothing of the user's is sent, but the connection is part of the run's record.
  ctx.egress.record(KOKORO_PACKAGES_HOST, 'voice package download', 0, []);
  try {
    await run(
      'npm',
      [
        'ci',
        '--prefix',
        dir,
        '--no-audit',
        '--no-fund',
        '--ignore-scripts',
        '--include=optional',
        '--loglevel=error',
      ],
      { cwd: dir, env: npmEnvironment(), timeoutMs: KOKORO_INSTALL_TIMEOUT_MS, signal: ctx.signal },
    );
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    throw new MergeStoryError('TTS_FAILED', `Installing the Kokoro voice failed: ${(err as Error).message}`, {
      hint: `Check that npm works and the network is reachable, then run \`mergestory setup kokoro\` again. ${manual}`,
      cause: err,
    });
  }
  const version = await packagesVersion(dir);
  if (version !== KOKORO_PLUGIN_PACKAGES['kokoro-js']) {
    throw new MergeStoryError('TTS_FAILED', 'The Kokoro voice packages were not installed as expected.', {
      hint: `Delete ${dir} and run \`mergestory setup kokoro\` again.`,
    });
  }
  await ensureLoaderFile(dir);
  await writeAtomic(join(dir, KOKORO_INSTALLED_MARKER), `${JSON.stringify({ version })}\n`);
  return kokoroStatus(ctx);
}
