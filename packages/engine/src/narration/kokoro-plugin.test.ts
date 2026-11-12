import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MergeStoryError } from '../core/errors.ts';
import type { RunOptions, RunResult } from '../core/process.ts';
import { makeTestContext } from '../testing/narration.ts';
import {
  completionMarker,
  ensureLoaderFile,
  installedKokoroVersion,
  installKokoro,
  KOKORO_INSTALLED_MARKER,
  KOKORO_PLUGIN_LOCKFILE,
  KOKORO_PLUGIN_OVERRIDES,
  KOKORO_PLUGIN_PACKAGES,
  kokoroLockFingerprint,
  kokoroManualInstall,
  kokoroStatus,
  pluginsDir,
  readKokoroLockfile,
} from './kokoro-plugin.ts';

/** The packages as npm leaves them; `complete` also writes the marker that a finished install writes last. */
async function fakeInstall(dir: string, version = '1.2.1', complete = false): Promise<void> {
  await mkdir(join(dir, 'node_modules', 'kokoro-js'), { recursive: true });
  await mkdir(join(dir, 'node_modules', '@huggingface', 'transformers'), { recursive: true });
  await writeFile(
    join(dir, 'node_modules', 'kokoro-js', 'package.json'),
    JSON.stringify({ name: 'kokoro-js', version }),
  );
  await writeFile(
    join(dir, 'node_modules', '@huggingface', 'transformers', 'package.json'),
    JSON.stringify({ name: '@huggingface/transformers', version: '3.8.1' }),
  );
  if (complete) {
    await writeFile(
      join(dir, KOKORO_INSTALLED_MARKER),
      JSON.stringify({ version, lock: kokoroLockFingerprint() }),
    );
  }
}

const emptyResult: RunResult = { code: 0, stdout: '', stderr: '', stdoutBuffer: Buffer.alloc(0) };

describe('kokoroStatus', () => {
  it('reports a missing plugin', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const status = await kokoroStatus(ctx);
    expect(status).toEqual({
      installed: false,
      location: join(ctx.home.home, 'plugins'),
      version: null,
      modelCached: false,
    });
    await cleanup();
  });

  it('reports the installed version', async () => {
    const { ctx, cleanup } = await makeTestContext();
    await fakeInstall(pluginsDir(ctx), '1.2.1', true);
    const status = await kokoroStatus(ctx);
    expect(status.installed).toBe(true);
    expect(status.version).toBe('1.2.1');
    expect(status.modelCached).toBe(false);
    await cleanup();
  });

  it('does not throw for an invalid MERGESTORY_KOKORO_DTYPE', async () => {
    const previous = process.env.MERGESTORY_KOKORO_DTYPE;
    process.env.MERGESTORY_KOKORO_DTYPE = 'q4';
    try {
      const { ctx, cleanup } = await makeTestContext();
      expect((await kokoroStatus(ctx)).installed).toBe(false);
      await cleanup();
    } finally {
      if (previous === undefined) delete process.env.MERGESTORY_KOKORO_DTYPE;
      else process.env.MERGESTORY_KOKORO_DTYPE = previous;
    }
  });

  it('needs both packages to count as installed', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const dir = pluginsDir(ctx);
    await mkdir(join(dir, 'node_modules', 'kokoro-js'), { recursive: true });
    await writeFile(
      join(dir, 'node_modules', 'kokoro-js', 'package.json'),
      JSON.stringify({ version: '1.2.1' }),
    );
    expect(await installedKokoroVersion(dir)).toBeNull();
    await cleanup();
  });
});

describe('the completion marker', () => {
  it('counts a folder without the marker as not installed, so the next run installs again', async () => {
    const { ctx, cleanup } = await makeTestContext();
    await fakeInstall(pluginsDir(ctx), '1.2.1', false);
    expect(await installedKokoroVersion(pluginsDir(ctx))).toBeNull();
    expect((await kokoroStatus(ctx)).installed).toBe(false);
    await cleanup();
  });

  it('counts a marker or packages of another version as not installed', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const dir = pluginsDir(ctx);
    await fakeInstall(dir, '1.2.1', true);
    await writeFile(join(dir, KOKORO_INSTALLED_MARKER), JSON.stringify({ version: '1.2.0' }));
    expect(await installedKokoroVersion(dir)).toBeNull();
    await fakeInstall(dir, '1.2.0', true);
    expect(await installedKokoroVersion(dir)).toBeNull();
    await writeFile(join(dir, KOKORO_INSTALLED_MARKER), 'not json');
    expect(await installedKokoroVersion(dir)).toBeNull();
    await cleanup();
  });

  it('counts an install made from an older lockfile as not installed, so it is installed again', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const dir = pluginsDir(ctx);
    await fakeInstall(dir, '1.2.1', true);
    expect(await installedKokoroVersion(dir)).toBe('1.2.1');
    // A marker from before the lockfile changed: the right version, another lockfile.
    await writeFile(
      join(dir, KOKORO_INSTALLED_MARKER),
      JSON.stringify({ version: '1.2.1', lock: 'an-older-lock' }),
    );
    expect(await installedKokoroVersion(dir)).toBeNull();
    // A marker from before the marker held the lockfile at all.
    await writeFile(join(dir, KOKORO_INSTALLED_MARKER), JSON.stringify({ version: '1.2.1' }));
    expect(await installedKokoroVersion(dir)).toBeNull();
    await cleanup();
  });

  it('is removed before npm runs and written only after a complete install', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const dir = pluginsDir(ctx);
    await fakeInstall(dir, '1.2.1', true);
    let markerDuringInstall: boolean | null = null;
    const cutOff = async (): Promise<RunResult> => {
      markerDuringInstall = (await installedKokoroVersion(dir)) !== null;
      throw new Error('npm was killed');
    };
    await expect(installKokoro(ctx, { run: cutOff, platform: 'linux' })).rejects.toMatchObject({
      code: 'TTS_FAILED',
    });
    expect(markerDuringInstall).toBe(false);
    // The packages from before are still on disk, but the install did not finish.
    expect((await kokoroStatus(ctx)).installed).toBe(false);
    const status = await installKokoro(ctx, { run: async () => emptyResult, platform: 'linux' });
    expect(status.installed).toBe(true);
    expect(JSON.parse(await readFile(join(dir, KOKORO_INSTALLED_MARKER), 'utf8'))).toEqual({
      version: '1.2.1',
      lock: kokoroLockFingerprint(),
    });
    await cleanup();
  });

  it('is part of the manual install, with the overrides', () => {
    const steps = kokoroManualInstall('/x/plugins');
    expect(steps).toContain(KOKORO_INSTALLED_MARKER);
    expect(steps).toContain(JSON.stringify(completionMarker()));
    expect(steps).toContain(JSON.stringify(KOKORO_PLUGIN_OVERRIDES));
  });
});

describe('the shipped lockfile', () => {
  it('holds every overridden package, and each of its prebuilt parts, at the pinned version', async () => {
    const lock = JSON.parse(await readFile(KOKORO_PLUGIN_LOCKFILE, 'utf8')) as {
      packages: Record<string, { version?: string }>;
    };
    for (const [name, version] of Object.entries(KOKORO_PLUGIN_OVERRIDES)) {
      expect(lock.packages[`node_modules/${name}`]?.version).toBe(version);
    }
    // sharp ships its native code as @img/sharp-<platform> packages, which must match it.
    const parts = Object.entries(lock.packages).filter(([path]) =>
      /^node_modules\/@img\/sharp-(?!libvips)/.test(path),
    );
    expect(parts.length).toBeGreaterThan(0);
    for (const [, entry] of parts) expect(entry.version).toBe(KOKORO_PLUGIN_OVERRIDES.sharp);
  });
});

describe('installKokoro', () => {
  const original = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  afterEach(() => {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('writes a manifest and the lockfile, and installs the locked tree without running scripts', async () => {
    process.env.OPENAI_API_KEY = 'sk-should-not-reach-npm-0123456789';
    process.env.GITHUB_TOKEN = 'ghp_should_not_reach_npm_0123456789012345';
    const { ctx, cleanup } = await makeTestContext();
    const dir = pluginsDir(ctx);
    const calls: { command: string; args: string[]; options?: RunOptions }[] = [];
    const run = async (command: string, args: string[], options?: RunOptions): Promise<RunResult> => {
      calls.push({ command, args, options });
      await fakeInstall(dir);
      return emptyResult;
    };
    const status = await installKokoro(ctx, { run, platform: 'darwin' });

    expect(status).toMatchObject({ installed: true, version: '1.2.1', location: dir });
    // The download is in the run's record, with nothing of the change in it.
    expect(ctx.egress.list()).toEqual([
      { destination: 'registry.npmjs.org', purpose: 'voice package download', bytes: 0, contains: [] },
    ]);
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    expect(manifest.private).toBe(true);
    expect(manifest.dependencies).toEqual({
      '@huggingface/transformers': '3.8.1',
      'kokoro-js': '1.2.1',
      phonemizer: '1.2.1',
    });
    expect(Object.values(manifest.dependencies).every((v) => /^\d+\.\d+\.\d+$/.test(v as string))).toBe(true);

    expect(calls).toHaveLength(1);
    // npm is started by its full path, never by a bare name that the current folder could supply.
    expect(isAbsolute(calls[0]!.command)).toBe(true);
    expect(basename(calls[0]!.command)).toMatch(/^npm(\.cmd)?$/i);
    expect(await readFile(join(dir, 'package-lock.json'), 'utf8')).toBe(
      await readFile(KOKORO_PLUGIN_LOCKFILE, 'utf8'),
    );
    expect(calls[0]?.args).toEqual([
      'ci',
      '--prefix',
      dir,
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      '--include=optional',
      '--loglevel=error',
    ]);
    expect(calls[0]?.options?.cwd).toBe(dir);
    const env = calls[0]?.options?.env ?? {};
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.ONNXRUNTIME_NODE_INSTALL_CUDA).toBe('skip');
    expect(env.PATH).toBe(process.env.PATH);
    expect(await readFile(join(dir, 'mergestory-kokoro-loader.mjs'), 'utf8')).toContain(
      "export { env } from '@huggingface/transformers';",
    );
    await cleanup();
  });

  it('turns an npm failure into an error with the manual steps', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const run = async (): Promise<RunResult> => {
      throw new Error('npm exited with code 1: ENOTFOUND registry.npmjs.org');
    };
    const error = (await installKokoro(ctx, { run, platform: 'linux' }).catch(
      (e: unknown) => e,
    )) as MergeStoryError;
    expect(error.code).toBe('TTS_FAILED');
    expect(error.message).toContain('ENOTFOUND');
    expect(error.hint).toContain('mergestory setup kokoro');
    expect(error.hint).toContain('--ignore-scripts');
    expect(error.hint).toContain('"kokoro-js":"1.2.1"');
    await cleanup();
  });

  it('fails when the packages are not there after npm says it is done', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const error = (await installKokoro(ctx, { run: async () => emptyResult, platform: 'linux' }).catch(
      (e: unknown) => e,
    )) as MergeStoryError;
    expect(error.code).toBe('TTS_FAILED');
    expect(error.message).toContain('not installed as expected');
    await cleanup();
  });

  it('fails when a different version ended up installed', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const run = async (): Promise<RunResult> => {
      await fakeInstall(pluginsDir(ctx), '9.9.9');
      return emptyResult;
    };
    await expect(installKokoro(ctx, { run, platform: 'linux' })).rejects.toThrow(/not installed as expected/);
    await cleanup();
  });

  it('is not automatic on Windows', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const error = (await installKokoro(ctx, { run: async () => emptyResult, platform: 'win32' }).catch(
      (e: unknown) => e,
    )) as MergeStoryError;
    expect(error.code).toBe('TTS_FAILED');
    expect(error.message).toContain('Windows');
    expect(error.hint).toContain('npm ci --ignore-scripts');
    expect(error.hint).toContain(KOKORO_PLUGIN_LOCKFILE);
    await cleanup();
  });

  it('pins the packages', () => {
    expect(KOKORO_PLUGIN_PACKAGES).toEqual({
      '@huggingface/transformers': '3.8.1',
      'kokoro-js': '1.2.1',
      phonemizer: '1.2.1',
    });
  });
});

describe('the plugin lockfile', () => {
  interface LockEntry {
    version?: string;
    resolved?: string;
    integrity?: string;
    dependencies?: Record<string, string>;
  }

  it('locks the pinned packages and everything they depend on, with a hash for each', async () => {
    const lock = JSON.parse(await readKokoroLockfile()) as {
      lockfileVersion: number;
      packages: Record<string, LockEntry>;
    };
    expect(lock.lockfileVersion).toBe(3);
    expect(lock.packages['']?.dependencies).toEqual(KOKORO_PLUGIN_PACKAGES);
    for (const [name, version] of Object.entries(KOKORO_PLUGIN_PACKAGES)) {
      expect(lock.packages[`node_modules/${name}`]?.version, name).toBe(version);
    }
    const entries = Object.entries(lock.packages).filter(([path]) => path !== '');
    expect(entries.length).toBeGreaterThan(3);
    for (const [path, entry] of entries) {
      expect(entry.version, path).toMatch(/^\d+\.\d+\.\d+/);
      expect(entry.resolved, path).toMatch(/^https:\/\/registry\.npmjs\.org\//);
      expect(entry.integrity, path).toMatch(/^sha512-/);
    }
  });

  it('ships with the package', async () => {
    // The lockfile is in assets/, so the published package must include that folder.
    const packageJson = join(dirname(KOKORO_PLUGIN_LOCKFILE), '..', '..', 'package.json');
    expect(JSON.parse(await readFile(packageJson, 'utf8')).files).toContain('assets');
  });

  it('is refused when it is missing or does not match the pinned packages', async () => {
    const { dir, cleanup } = await makeTestContext();
    const stale = join(dir, 'stale-lock.json');
    const dependencies = { ...KOKORO_PLUGIN_PACKAGES, 'kokoro-js': '1.2.0' };
    await writeFile(stale, JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies } } }));
    for (const path of [stale, join(dir, 'missing.json')]) {
      await expect(readKokoroLockfile(path)).rejects.toMatchObject({ code: 'TTS_FAILED' });
    }
    await cleanup();
  });
});

describe('ensureLoaderFile', () => {
  it('writes the loader and repairs an outdated one', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const dir = pluginsDir(ctx);
    await mkdir(dir, { recursive: true });
    const path = await ensureLoaderFile(dir);
    const text = await readFile(path, 'utf8');
    expect(text).toContain("export { KokoroTTS } from 'kokoro-js';");
    await writeFile(path, 'outdated');
    expect(await ensureLoaderFile(dir)).toBe(path);
    expect(await readFile(path, 'utf8')).toBe(text);
    await cleanup();
  });
});
