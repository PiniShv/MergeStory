import { mkdir, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RunContext } from '../core/context.ts';
import { MergeStoryError } from '../core/errors.ts';
import { makeTestContext, writeFakeKokoroInstall } from '../testing/narration.ts';
import {
  ensureKokoroInstalled,
  KOKORO_INSTALL_LOCK,
  kokoroInstallNote,
  setupKokoro,
} from './kokoro-install.ts';
import { kokoroDtype, kokoroModelDir, kokoroModelFiles } from './kokoro-model.ts';
import { isKokoroInstalled, kokoroStatus, pluginsDir } from './kokoro-plugin.ts';

/** An install that only writes what a finished install leaves behind. It never runs npm. */
function fakeInstaller(options: { delayMs?: number; fail?: Error } = {}) {
  const install = vi.fn(async (ctx: RunContext) => {
    await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 0));
    if (ctx.signal.aborted) throw new Error('npm was stopped');
    if (options.fail) throw options.fail;
    await writeFakeKokoroInstall(pluginsDir(ctx));
    return kokoroStatus(ctx);
  });
  return install;
}

const lockFile = (ctx: RunContext) => join(ctx.home.home, KOKORO_INSTALL_LOCK);

async function holdLock(ctx: RunContext, lock: { pid: number; startedAt: number }): Promise<void> {
  await mkdir(ctx.home.home, { recursive: true });
  await writeFile(lockFile(ctx), JSON.stringify({ ...lock, token: 'other-process' }));
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

describe('ensureKokoroInstalled', () => {
  it('installs once, tells the person first, and releases the lock', async () => {
    const { ctx, events, cleanup } = await makeTestContext();
    const install = fakeInstaller();
    await ensureKokoroInstalled(ctx, { install, platform: 'darwin' });
    expect(install).toHaveBeenCalledTimes(1);
    expect(await isKokoroInstalled(ctx)).toBe(true);
    const notice = events.find((e) => e.message.includes('not installed yet'));
    expect(notice?.stage).toBe('narrate');
    expect(notice?.message).toContain('about 400 MB of packages');
    expect(notice?.message).toMatch(/voice model \((326|92) MB\)/);
    expect(notice?.message).toContain('a minute or two');
    expect(await exists(lockFile(ctx))).toBe(false);
    // Installed: nothing more happens.
    await ensureKokoroInstalled(ctx, { install, platform: 'darwin' });
    expect(install).toHaveBeenCalledTimes(1);
    await cleanup();
  });

  it('holds a lock with the pid and the start time while it installs', async () => {
    const { ctx, cleanup } = await makeTestContext();
    let seen: Record<string, unknown> | null = null;
    const install = vi.fn(async (c: RunContext) => {
      seen = JSON.parse(await readFile(lockFile(c), 'utf8'));
      await writeFakeKokoroInstall(pluginsDir(c));
      return kokoroStatus(c);
    });
    await ensureKokoroInstalled(ctx, { install, platform: 'linux', now: () => 1234 });
    expect(seen).toMatchObject({ pid: process.pid, startedAt: 1234 });
    await cleanup();
  });

  it('writes the time it takes the lock, not the time it began to wait', async () => {
    const { ctx, cleanup } = await makeTestContext();
    await holdLock(ctx, { pid: 999_999, startedAt: 0 });
    let clock = 0;
    let seen: Record<string, unknown> | null = null;
    const install = vi.fn(async (c: RunContext) => {
      seen = JSON.parse(await readFile(lockFile(c), 'utf8'));
      await writeFakeKokoroInstall(pluginsDir(c));
      return kokoroStatus(c);
    });
    const options = {
      install,
      platform: 'linux' as const,
      isAlive: () => true,
      now: () => clock,
      pollMs: 10,
    };
    const waiting = ensureKokoroInstalled(ctx, options);
    await new Promise((resolve) => setTimeout(resolve, 40));
    // The other install ends 14 minutes later. A lock dated from the start of the wait would look stale soon.
    clock = 14 * 60_000;
    await rm(lockFile(ctx));
    await waiting;
    expect(seen).toMatchObject({ pid: process.pid, startedAt: 14 * 60_000 });
    await cleanup();
  });

  it('tells a second run in the same process that it waits for the install', async () => {
    const first = await makeTestContext();
    const second = await makeTestContext({ config: { home: first.ctx.home.home } });
    // The install waits for the test, so the second run is sure to find it still going.
    let finish = () => {};
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const install = vi.fn(async (ctx: RunContext) => {
      await gate;
      await writeFakeKokoroInstall(pluginsDir(ctx));
      return kokoroStatus(ctx);
    });
    const one = ensureKokoroInstalled(first.ctx, { install, platform: 'linux' });
    await vi.waitFor(() => expect(install).toHaveBeenCalled());
    const two = ensureKokoroInstalled(second.ctx, { install, platform: 'linux' });
    const waiting = (e: { message: string }) => e.message.includes('Another run in this process');
    await vi.waitFor(() => expect(second.events.some(waiting)).toBe(true));
    finish();
    await Promise.all([one, two]);
    expect(install).toHaveBeenCalledTimes(1);
    await Promise.all([first.cleanup(), second.cleanup()]);
  });

  it('names only the packages when the voice model is downloaded already', async () => {
    const { ctx, events, cleanup } = await makeTestContext();
    // The cache check compares sizes, so empty files of the right size stand in for the model.
    for (const file of kokoroModelFiles(kokoroDtype())) {
      const path = join(kokoroModelDir(ctx.home.models), file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, '');
      await truncate(path, file.bytes);
    }
    const note = await kokoroInstallNote(ctx);
    expect(note).toContain('about 400 MB of packages');
    expect(note).not.toContain('voice model');
    await ensureKokoroInstalled(ctx, { install: fakeInstaller(), platform: 'linux' });
    const notice = events.find((e) => e.message.includes('not installed yet'));
    expect(notice?.message).toContain('about 400 MB of packages');
    expect(notice?.message).not.toContain('voice model');
    await cleanup();
  });

  it('keeps the advice of a failure that says itself what to do', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const broken = new MergeStoryError('TTS_FAILED', 'The lockfile of the Kokoro voice is missing.', {
      hint: 'Reinstall MergeStory.',
    });
    const install = fakeInstaller({ fail: broken });
    const err = (await ensureKokoroInstalled(ctx, { install, platform: 'linux' }).catch(
      (e: unknown) => e,
    )) as MergeStoryError;
    expect(err.code).toBe('TTS_FAILED');
    expect(err.hint).toContain('Reinstall MergeStory.');
    expect(err.hint).toContain('--tts none');
    expect(err.hint).not.toContain('Check the network');
    await cleanup();
  });

  it('shares one install between runs in the same process', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const other = await makeTestContext({ config: { home: ctx.home.home } });
    const install = fakeInstaller({ delayMs: 30 });
    await Promise.all([
      ensureKokoroInstalled(ctx, { install, platform: 'linux' }),
      ensureKokoroInstalled(other.ctx, { install, platform: 'linux' }),
      ensureKokoroInstalled(ctx, { install, platform: 'linux' }),
    ]);
    expect(install).toHaveBeenCalledTimes(1);
    expect(await isKokoroInstalled(other.ctx)).toBe(true);
    await Promise.all([cleanup(), other.cleanup()]);
  });

  it('waits while another process holds the lock, then uses what it installed', async () => {
    const { ctx, events, cleanup } = await makeTestContext();
    await holdLock(ctx, { pid: 999_999, startedAt: Date.now() });
    const install = fakeInstaller();
    const waiting = ensureKokoroInstalled(ctx, {
      install,
      platform: 'linux',
      isAlive: () => true,
      pollMs: 10,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events.some((e) => e.message.includes('Another MergeStory run is installing'))).toBe(true);
    // The other process finishes and releases its lock.
    await writeFakeKokoroInstall(pluginsDir(ctx));
    await rm(lockFile(ctx));
    await waiting;
    expect(install).not.toHaveBeenCalled();
    await cleanup();
  });

  it('installs after waiting when the other process stopped without finishing', async () => {
    const { ctx, cleanup } = await makeTestContext();
    await holdLock(ctx, { pid: 999_999, startedAt: Date.now() });
    const install = fakeInstaller();
    const waiting = ensureKokoroInstalled(ctx, {
      install,
      platform: 'linux',
      isAlive: () => true,
      pollMs: 10,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await rm(lockFile(ctx));
    await waiting;
    expect(install).toHaveBeenCalledTimes(1);
    await cleanup();
  });

  it('takes over a lock whose process has ended', async () => {
    const { ctx, cleanup } = await makeTestContext();
    await holdLock(ctx, { pid: 999_999, startedAt: Date.now() });
    const install = fakeInstaller();
    await ensureKokoroInstalled(ctx, { install, platform: 'linux', isAlive: () => false, pollMs: 10 });
    expect(install).toHaveBeenCalledTimes(1);
    expect(await exists(lockFile(ctx))).toBe(false);
    await cleanup();
  });

  it('takes over a lock older than the install timeout, even from a live process', async () => {
    const { ctx, cleanup } = await makeTestContext();
    await holdLock(ctx, { pid: process.pid, startedAt: Date.now() - 16 * 60_000 });
    const install = fakeInstaller();
    await ensureKokoroInstalled(ctx, { install, platform: 'linux', isAlive: () => true, pollMs: 10 });
    expect(install).toHaveBeenCalledTimes(1);
    await cleanup();
  });

  it('takes over a lock that cannot be read once it is no longer being written', async () => {
    const { ctx, cleanup } = await makeTestContext();
    await mkdir(ctx.home.home, { recursive: true });
    await writeFile(lockFile(ctx), '');
    const install = fakeInstaller();
    const later = () => Date.now() + 60_000;
    await ensureKokoroInstalled(ctx, { install, platform: 'linux', now: later, pollMs: 10 });
    expect(install).toHaveBeenCalledTimes(1);
    await cleanup();
  });

  it('checks a real process: a lock of this live process is waited for', async () => {
    const { ctx, cleanup } = await makeTestContext();
    await holdLock(ctx, { pid: process.pid, startedAt: Date.now() });
    const controller = new AbortController();
    const waiter = await makeTestContext({ config: { home: ctx.home.home }, signal: controller.signal });
    const install = fakeInstaller();
    const waiting = ensureKokoroInstalled(waiter.ctx, { install, platform: 'linux', pollMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    controller.abort();
    expect(((await waiting.catch((e: unknown) => e)) as MergeStoryError).code).toBe('ABORTED');
    expect(install).not.toHaveBeenCalled();
    await Promise.all([cleanup(), waiter.cleanup()]);
  });

  it('stops with TTS_FAILED and says how to go on when the install fails', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const install = fakeInstaller({
      fail: new Error('Installing the Kokoro voice failed: npm exited with code 1: ENOSPC'),
    });
    const error = (await ensureKokoroInstalled(ctx, { install, platform: 'linux' }).catch(
      (e: unknown) => e,
    )) as MergeStoryError;
    expect(error.code).toBe('TTS_FAILED');
    expect(error.message).toBe(
      'The free Kokoro voice could not be installed: npm exited with code 1: ENOSPC',
    );
    expect(error.hint).toContain('Check the network and that npm works');
    expect(error.hint).toContain('mergestory setup kokoro');
    expect(error.hint).toContain('--tts say');
    expect(error.hint).toContain('--tts none');
    expect(await exists(lockFile(ctx))).toBe(false);
    expect(await isKokoroInstalled(ctx)).toBe(false);
    await cleanup();
  });

  it('installs again for the others when the run that was installing is cancelled', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const controller = new AbortController();
    const first = await makeTestContext({ config: { home: ctx.home.home }, signal: controller.signal });
    const install = fakeInstaller({ delayMs: 100 });
    const cancelled = ensureKokoroInstalled(first.ctx, { install, platform: 'linux' });
    await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(1), { interval: 1 });
    const other = ensureKokoroInstalled(ctx, { install, platform: 'linux' });
    controller.abort();
    expect(((await cancelled.catch((e: unknown) => e)) as MergeStoryError).code).toBe('ABORTED');
    await other;
    expect(await isKokoroInstalled(ctx)).toBe(true);
    expect(install).toHaveBeenCalledTimes(2);
    await Promise.all([cleanup(), first.cleanup()]);
  });

  it('does not install on Windows, and names the manual install', async () => {
    const { ctx, cleanup } = await makeTestContext();
    const install = fakeInstaller();
    const error = (await ensureKokoroInstalled(ctx, { install, platform: 'win32' }).catch(
      (e: unknown) => e,
    )) as MergeStoryError;
    expect(error.code).toBe('TTS_FAILED');
    expect(error.message).toContain('Windows');
    expect(error.hint).toContain('npm ci --ignore-scripts');
    expect(install).not.toHaveBeenCalled();
    await cleanup();
  });
});

describe('setupKokoro', () => {
  it('installs even when the voice is there (a repair), under the same lock', async () => {
    const { ctx, cleanup } = await makeTestContext();
    await writeFakeKokoroInstall(pluginsDir(ctx));
    const install = fakeInstaller();
    expect((await setupKokoro(ctx, { install })).installed).toBe(true);
    expect(install).toHaveBeenCalledTimes(1);
    expect(await exists(lockFile(ctx))).toBe(false);
    await cleanup();
  });

  it('waits for an install in another process and uses it', async () => {
    const { ctx, cleanup } = await makeTestContext();
    await holdLock(ctx, { pid: 999_999, startedAt: Date.now() });
    const install = fakeInstaller();
    const waiting = setupKokoro(ctx, { install, isAlive: () => true, pollMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await writeFakeKokoroInstall(pluginsDir(ctx));
    await rm(lockFile(ctx));
    expect((await waiting).installed).toBe(true);
    expect(install).not.toHaveBeenCalled();
    await cleanup();
  });
});
