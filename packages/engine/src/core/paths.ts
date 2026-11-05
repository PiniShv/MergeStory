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
 */
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

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
