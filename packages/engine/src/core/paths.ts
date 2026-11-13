/**
 * Where MergeStory keeps its files. Nothing is ever written inside the repository being explained.
 *
 *   $MERGESTORY_HOME (default ~/.mergestory)
 *     runs/<runId>/   one directory per run: analysis, storyboard, audio, video, watch page
 *     cache/<ns>/     content-addressed cache (speech clips, LLM responses, file contents)
 *     jobs/<jobId>/   state of asynchronous jobs
 *     models/         downloaded local models (for example Kokoro speech)
 *     plugins/        optional providers installed with `mergestory setup`
 *     credentials/    sign-in data from `mergestory setup youtube`
 *     work/<name>/    drafts of the `mergestory agent` commands (never a run folder)
 */
import { lstat, mkdir, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { MergeStoryError } from './errors.ts';
import { isInside } from './posix.ts';

export function mergestoryHome(override?: string | null): string {
  const value = override ?? process.env.MERGESTORY_HOME;
  if (value?.trim()) return resolve(value);
  return join(homedir(), '.mergestory');
}

export interface HomeLayout {
  home: string;
  runs: string;
  cache: string;
  jobs: string;
  models: string;
  /** Optional heavy providers installed on request (for example the Kokoro voice). */
  plugins: string;
  /** Sign-in data written by `mergestory setup` (for example YouTube). Folder 0700, files 0600. */
  credentials: string;
  /** Work folders of `mergestory agent`: drafts an agent may write without asking. */
  work: string;
  /** Themes the user made: themes/<name>/theme.json. */
  themes: string;
  /** Contact sheets of `mergestory theme preview`. */
  previews: string;
}

export function homeLayout(override?: string | null): HomeLayout {
  const home = mergestoryHome(override);
  return {
    home,
    runs: join(home, 'runs'),
    cache: join(home, 'cache'),
    jobs: join(home, 'jobs'),
    models: join(home, 'models'),
    plugins: join(home, 'plugins'),
    credentials: join(home, 'credentials'),
    work: join(home, 'work'),
    themes: join(home, 'themes'),
    previews: join(home, 'previews'),
  };
}

export async function ensureDir(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  return path;
}

/** Resolve a run directory: an explicit --out, or $MERGESTORY_HOME/runs/<runId>. */
export function runDirFor(
  runId: string,
  outDir: string | null | undefined,
  homeOverride?: string | null,
): string {
  if (outDir) return isAbsolute(outDir) ? outDir : resolve(process.cwd(), outDir);
  return join(homeLayout(homeOverride).runs, runId);
}

/** Normalise a repo-relative path to POSIX form and reject anything that escapes the repo. */
export function safeRepoPath(path: string): string | null {
  const posix = path.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!posix || posix.startsWith('/') || /^[a-zA-Z]:/.test(posix)) return null;
  const parts = posix.split('/');
  if (parts.some((p) => p === '..' || p === '')) return null;
  return posix;
}

/**
 * Refuse a folder that is a symbolic link or holds one at any depth, so that writing (or reading)
 * there cannot reach a file elsewhere. A folder that does not exist yet passes. With `recursive`
 * false only the folder itself is checked.
 */
export async function assertNoLinks(dir: string, recursive = true): Promise<void> {
  const info = await lstat(dir).catch(() => null);
  if (!info) return;
  const refuse = (link: string): never => {
    throw new MergeStoryError(
      'USAGE',
      `The folder ${dir} is a symbolic link or holds one. MergeStory does not read or write through links.`,
      { hint: `Remove ${link}, or choose another folder.` },
    );
  };
  if (info.isSymbolicLink()) refuse(dir);
  if (!recursive || !info.isDirectory()) return;
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const link = entries.find((entry) => entry.isSymbolicLink());
  if (link) refuse(join(link.parentPath, link.name));
}

/**
 * A path with its links resolved, and with the letter case the disk has. The part that does not
 * exist yet is kept as it is.
 */
export async function resolvedLocation(path: string): Promise<string> {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(await realpath(current), ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      missing.push(basename(current));
      current = parent;
    }
  }
}

/**
 * What a file or folder is on disk, whatever it is called. Null when it does not exist, or when
 * the file system gives no number for it (some report 0 for every file).
 */
export const diskIdentity = async (path: string): Promise<string | null> =>
  stat(path, { bigint: true }).then(
    (info) => (info.ino === 0n ? null : `${info.dev}:${info.ino}`),
    () => null,
  );

/**
 * Whether two paths are the same file or folder on disk. One folder can have several names. Where
 * the disk gives no identity, the real paths are compared instead.
 */
export async function sameOnDisk(a: string, b: string, identity = diskIdentity): Promise<boolean> {
  const [first, second] = await Promise.all([identity(a), identity(b)]);
  if (first !== null && second !== null) return first === second;
  const [realA, realB] = await Promise.all([a, b].map((path) => realpath(path).catch(() => null)));
  return realA !== null && realA === realB;
}

/**
 * Whether `path` is the work folder `work` or lies in it. A path that does not exist yet is judged
 * by its nearest existing parent, so a link on the way there does not hide it. Letter case is
 * ignored on every system, which is stricter than a disk that keeps case apart: on a disk that
 * ignores case, WORK and work are one folder, and the two cannot be told apart from here.
 */
export async function isInWorkFolder(path: string, work: string, identity = diskIdentity): Promise<boolean> {
  const [target, root] = await Promise.all([resolvedLocation(path), resolvedLocation(work)]);
  const inside = (a: string, b: string): boolean => isInside(a.toLowerCase(), b.toLowerCase());
  if (inside(resolve(work), resolve(path)) || inside(root, target)) return true;
  // A folder can have a second name that no path shows (another mount point, for example), so the
  // part of the path that exists is also compared by what it is on disk.
  // shortcut: some mount setups that only an administrator can create are not recognised. Upgrade
  // if such a setup has to be covered.
  const workIdentity = await identity(work);
  if (workIdentity === null) return false;
  for (let dir = target; ; dir = dirname(dir)) {
    if ((await identity(dir)) === workIdentity) return true;
    if (dirname(dir) === dir) return false;
  }
}

/** Refuse a run folder inside the work folders: an agent writes there without asking, and publish trusts a run folder. */
export async function assertNotWorkFolder(dir: string, homeOverride?: string | null): Promise<void> {
  if (await isInWorkFolder(dir, homeLayout(homeOverride).work)) {
    throw new MergeStoryError('USAGE', 'The work folder holds drafts. It cannot be a run folder.', {
      hint: 'Choose a folder outside the work folder of the MergeStory home.',
    });
  }
}
