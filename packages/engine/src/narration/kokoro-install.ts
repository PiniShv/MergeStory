/**
 * Installing the Kokoro voice when a run needs it, one install at a time. Runs in one process
 * (the server, the job runner, library callers) share one install. Separate processes take turns
 * through a lock file in the MergeStory home, so two installs never write the plugin folder at once.
 */
import { link, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { RunContext } from '../core/context.ts';
import { abortedError, assertNotAborted, MergeStoryError } from '../core/errors.ts';
import { randomToken } from '../core/ids.ts';
import {
  isKokoroModelCached,
  KOKORO_MODEL_HOST,
  type KokoroDtype,
  kokoroDownloadMb,
  kokoroDtype,
} from './kokoro-model.ts';
import {
  type InstallDeps,
  installKokoro,
  isKokoroInstalled,
  KOKORO_INSTALL_TIMEOUT_MS,
  KOKORO_PACKAGES_HOST,
  KOKORO_PACKAGES_MB,
  kokoroManualInstall,
  kokoroStatus,
  type LocalVoiceStatus,
  pluginsDir,
} from './kokoro-plugin.ts';

export const KOKORO_INSTALL_LOCK = 'kokoro-install.lock';

/** A lock that cannot be read this long after it was written was left by a process that died while writing it. */
const UNREADABLE_LOCK_STALE_MS = 30_000;

/** Time after the install timeout before a lock counts as stale, so the holder's npm has stopped. */
const STALE_MARGIN_MS = 60_000;

interface LockInfo {
  pid: number;
  startedAt: number;
  token: string;
}

export interface InstallLockDeps {
  /** Whether a process is still running (tests). */
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  /** How often a waiting run looks at the lock again. */
  pollMs?: number;
}

export interface EnsureKokoroDeps extends InstallLockDeps {
  /** Replaces the install itself (tests). */
  install?: (ctx: RunContext, deps?: InstallDeps) => Promise<LocalVoiceStatus>;
  platform?: NodeJS.Platform;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function lockPath(ctx: Pick<RunContext, 'home'>): string {
  return join(ctx.home.home, KOKORO_INSTALL_LOCK);
}

function parseLock(text: string): LockInfo | null {
  try {
    const value = JSON.parse(text) as Partial<LockInfo>;
    if (
      Number.isInteger(value.pid) &&
      (value.pid as number) > 0 &&
      typeof value.startedAt === 'number' &&
      typeof value.token === 'string'
    ) {
      return value as LockInfo;
    }
  } catch {
    // not a lock this code wrote, or one that is still being written
  }
  return null;
}

/** A lock whose process has ended, or that is older than the longest install, is stale. */
async function isStale(path: string, text: string, deps: InstallLockDeps): Promise<boolean> {
  const now = (deps.now ?? Date.now)();
  const info = parseLock(text);
  if (!info) {
    try {
      return now - (await stat(path)).mtimeMs > UNREADABLE_LOCK_STALE_MS;
    } catch {
      return true;
    }
  }
  if (now - info.startedAt > KOKORO_INSTALL_TIMEOUT_MS + STALE_MARGIN_MS) return true;
  return !(deps.isAlive ?? processAlive)(info.pid);
}

/**
 * Move a stale lock aside, so a new one can be created. The move is one step, so of two runs that
 * both find the same stale lock only one moves it. If the lock moved aside turns out to be a new
 * one (another run took over in between), it is put back.
 * shortcut: while it is put back, a third run can create its own lock, so in that instant two runs could
 * both hold it; this needs three runs at once on a lock left by a crash. Use an OS file lock if it is seen.
 */
async function takeOver(path: string, staleText: string): Promise<void> {
  const aside = `${path}.${randomToken(4)}.stale`;
  try {
    await rename(path, aside);
  } catch {
    return; // already gone
  }
  try {
    const moved = await readFile(aside, 'utf8').catch(() => '');
    if (moved !== staleText) await link(aside, path).catch(() => undefined);
  } finally {
    await rm(aside, { force: true });
  }
}

async function writeLock(path: string, info: LockInfo): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    // The exclusive flag: creating the file fails when it already exists.
    handle = await open(path, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    await handle.writeFile(JSON.stringify(info));
  } catch (err) {
    await handle.close();
    await rm(path, { force: true });
    throw err;
  }
  await handle.close();
  return true;
}

/** Take the install lock, waiting while a live process holds it. `waited` says whether it had to wait. */
async function acquire(
  ctx: RunContext,
  deps: InstallLockDeps,
): Promise<{ release: () => Promise<void>; waited: boolean }> {
  const path = lockPath(ctx);
  const info: LockInfo = { pid: process.pid, startedAt: (deps.now ?? Date.now)(), token: randomToken(8) };
  let waited = false;
  await mkdir(ctx.home.home, { recursive: true, mode: 0o700 });
  for (;;) {
    assertNotAborted(ctx.signal);
    // The lock's age counts from when it is taken, not from when this run began to wait.
    info.startedAt = (deps.now ?? Date.now)();
    if (await writeLock(path, info)) break;
    const text = await readFile(path, 'utf8').catch(() => null);
    if (text === null) continue; // released in between
    if (await isStale(path, text, deps)) {
      await takeOver(path, text);
      continue;
    }
    if (!waited) {
      ctx.progress({
        stage: 'narrate',
        status: 'start',
        message: 'Another MergeStory run is installing the Kokoro voice. Waiting for it to finish.',
      });
      waited = true;
    }
    try {
      await sleep(deps.pollMs ?? 1000, undefined, { signal: ctx.signal });
    } catch (err) {
      throw ctx.signal.aborted ? abortedError(err) : err;
    }
  }
  return {
    waited,
    release: async () => {
      const current = parseLock((await readFile(path, 'utf8').catch(() => null)) ?? '');
      // Only our own lock: a stale one taken over by another run is no longer ours.
      if (current?.token === info.token) await rm(path, { force: true });
    },
  };
}

/**
 * Run `install` while holding the install lock. After waiting for another process, the install it
 * finished is used, not installed again.
 */
async function underLock(
  ctx: RunContext,
  deps: EnsureKokoroDeps,
  alwaysInstall: boolean,
  before: () => Promise<void>,
): Promise<LocalVoiceStatus> {
  const lock = await acquire(ctx, deps);
  try {
    if ((!alwaysInstall || lock.waited) && (await isKokoroInstalled(ctx))) return kokoroStatus(ctx);
    await before();
    return await (deps.install ?? installKokoro)(ctx, { platform: deps.platform });
  } finally {
    await lock.release();
  }
}

/** `mergestory setup kokoro`: install (or repair) the voice, taking turns with any run that installs it. */
export function setupKokoro(ctx: RunContext, deps: EnsureKokoroDeps = {}): Promise<LocalVoiceStatus> {
  return underLock(ctx, deps, true, async () => undefined);
}

/** The error for a missing voice on Windows, where it cannot install itself yet. */
export function kokoroWindowsError(ctx: Pick<RunContext, 'home'>): MergeStoryError {
  return new MergeStoryError(
    'TTS_FAILED',
    'The Kokoro voice is not installed, and it cannot install itself on Windows yet.',
    { hint: `${kokoroManualInstall(pluginsDir(ctx))} Or choose --tts none for this run.` },
  );
}

function safeDtype(): KokoroDtype {
  try {
    return kokoroDtype();
  } catch {
    // A bad MERGESTORY_KOKORO_DTYPE is reported when the voice is used.
    return kokoroDtype({});
  }
}

/** What the install downloads, in words: the packages, and the voice model unless it is there already. */
async function downloadsInWords(ctx: RunContext): Promise<string> {
  const dtype = safeDtype();
  const packages = `about ${KOKORO_PACKAGES_MB} MB of packages from ${KOKORO_PACKAGES_HOST}`;
  if (await isKokoroModelCached(ctx.home.models, dtype)) return packages;
  return `${packages}, then the voice model (${kokoroDownloadMb(dtype)} MB) from ${KOKORO_MODEL_HOST}`;
}

/**
 * For the dry-run plan: what the first real run does when the Kokoro voice is not installed yet,
 * or null when it is installed.
 */
export async function kokoroInstallNote(ctx: RunContext): Promise<string | null> {
  if (await isKokoroInstalled(ctx)) return null;
  return (
    'The free Kokoro voice is not installed yet. The first real run installs it once: ' +
    `${await downloadsInWords(ctx)}. Nothing from the change is sent.`
  );
}

/** The error a run stops with when the voice could not be installed. Never a silent fallback. */
function installFailed(err: unknown): MergeStoryError {
  const reason = (err instanceof Error ? err.message : String(err))
    .replace(/^Installing the Kokoro voice failed: /, '')
    .slice(0, 300);
  // A failure that says itself what to do (a damaged MergeStory install) keeps its own advice.
  const own = err instanceof MergeStoryError ? err.hint : undefined;
  return new MergeStoryError('TTS_FAILED', `The free Kokoro voice could not be installed: ${reason}`, {
    hint: `${own ?? 'Check the network and that npm works, then run `mergestory setup kokoro` to try again.'} Or choose --tts say (macOS) or --tts none for this run.`,
    cause: err,
  });
}

const inFlight = new Map<string, { promise: Promise<unknown>; signal: AbortSignal }>();

/** Wait for `promise`, but stop waiting when this run is cancelled. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortedError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortedError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Make sure the Kokoro voice is installed, installing it when it is not. Tells the person first
 * what happens and how long it takes. A failure stops the run with TTS_FAILED.
 */
export async function ensureKokoroInstalled(ctx: RunContext, deps: EnsureKokoroDeps = {}): Promise<void> {
  const dir = pluginsDir(ctx);
  const platform = deps.platform ?? process.platform;
  for (;;) {
    if (await isKokoroInstalled(ctx)) return;
    if (platform === 'win32') throw kokoroWindowsError(ctx);
    let entry = inFlight.get(dir);
    if (entry) {
      ctx.progress({
        stage: 'narrate',
        status: 'start',
        message: 'Another run in this process is installing the Kokoro voice. Waiting for it to finish.',
      });
    } else {
      const promise = underLock(ctx, deps, false, async () => {
        ctx.progress({
          stage: 'narrate',
          status: 'start',
          message:
            'The free Kokoro voice is not installed yet, so MergeStory installs it now. This happens once: ' +
            `${await downloadsInWords(ctx)}. It takes a minute or two.`,
        });
      });
      const created = { promise, signal: ctx.signal };
      inFlight.set(dir, created);
      const forget = () => {
        if (inFlight.get(dir) === created) inFlight.delete(dir);
      };
      promise.then(forget, forget);
      entry = created;
    }
    try {
      await untilAborted(entry.promise, ctx.signal);
      return;
    } catch (err) {
      if (ctx.signal.aborted) throw abortedError(err);
      // The run that was installing was cancelled, not this one: install again.
      if (entry.signal !== ctx.signal && entry.signal.aborted) continue;
      throw installFailed(err);
    }
  }
}
