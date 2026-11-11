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
import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
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
  const refuse = (): never => {
    throw new MergeStoryError(
      'USAGE',
      'The work folder holds a symbolic link. MergeStory does not read or write through links.',
      { hint: `Remove the link from ${dir}, or choose another folder.` },
    );
  };
  if (info.isSymbolicLink()) refuse();
  if (!recursive || !info.isDirectory()) return;
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  if (entries.some((entry) => entry.isSymbolicLink())) refuse();
}

/** Refuse a run folder inside the work folders: an agent writes there without asking, and publish trusts a run folder. */
export async function assertNotWorkFolder(dir: string, homeOverride?: string | null): Promise<void> {
  const work = homeLayout(homeOverride).work;
  const real = async (path: string): Promise<string> => realpath(path).catch(() => resolve(path));
  const [target, root] = await Promise.all([real(dir), real(work)]);
  if (isInside(resolve(work), resolve(dir)) || isInside(root, target)) {
    throw new MergeStoryError('USAGE', 'The work folder holds drafts. It cannot be a run folder.', {
      hint: 'Choose a folder outside the work folder of the MergeStory home.',
    });
  }
}
