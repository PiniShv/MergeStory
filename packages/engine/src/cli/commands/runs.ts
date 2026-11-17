/** mergestory runs: list the videos on this machine, and delete one. */
import { existsSync } from 'node:fs';
import { lstat, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command } from 'commander';
import { EXIT_CODES, MergeStoryError } from '../../core/errors.ts';
import { RUN_ID_PATTERN } from '../../core/ids.ts';
import { homeLayout } from '../../core/paths.ts';
import { RUN_FILE, readRunJson, StoredResultSchema } from '../../core/run-folder.ts';
import { terminalSafe } from '../../core/text.ts';
import { isTerminal, type Job } from '../../jobs/model.ts';
import { isValidJobId, JobStore } from '../../jobs/store.ts';
import { formatBytes } from '../files.ts';
import { formatDuration, formatTime } from '../format.ts';
import { numberFlag } from '../options.ts';
import type { CliRuntime } from '../runtime.ts';
import type { Style } from '../style.ts';
import { loadConfig } from './shared.ts';

interface RunSummary {
  runId: string;
  runDir: string;
  createdAt: string;
  title: string;
  durationSec: number;
  video: string;
  publish: { provider: string; watchUrl: string | null; expiresAt: string | null } | null;
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** The time in a run id ("20261103-214501-a3f9"), or null for any other name. */
function idTime(id: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(id);
  if (!m || !RUN_ID_PATTERN.test(id)) return null;
  const date = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The time in a run id, or the folder's modification time for any other name. */
async function createdAt(id: string, dir: string): Promise<string> {
  return (idTime(id) ?? (await stat(dir)).mtime).toISOString();
}

/** The jobs on this machine, by the run each one makes. Damaged job files are left out. */
async function jobsByRun(store: JobStore): Promise<Map<string, Job[]>> {
  const byRun = new Map<string, Job[]>();
  for (const id of (await readdir(store.root).catch(() => [])).filter(isValidJobId)) {
    const job = await store.get(id).catch(() => null);
    if (!job) continue;
    const runId = job.options.runId ?? job.id;
    byRun.set(runId, [...(byRun.get(runId) ?? []), job]);
  }
  return byRun;
}

/** Run ids, from run folders and jobs, whose id says they were made more than `days` days ago. */
async function idsOlderThan(runsDir: string, jobs: Map<string, Job[]>, days: number): Promise<string[]> {
  const cutoff = Date.now() - days * 86_400_000;
  const names = await readdir(runsDir).catch(() => []);
  return [...new Set([...names, ...jobs.keys()])]
    .filter((id) => (idTime(id)?.getTime() ?? cutoff) < cutoff)
    .sort();
}

/** The run folders that hold a readable result.json; the rest are left out. */
async function listRuns(runsDir: string): Promise<RunSummary[]> {
  const entries = await readdir(runsDir, { withFileTypes: true }).catch(() => []);
  const runs: RunSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runDir = join(runsDir, entry.name);
    const result = await readRunJson(
      join(runDir, RUN_FILE.result),
      StoredResultSchema,
      RUN_FILE.result,
    ).catch(() => null);
    if (!result) continue;
    const published = result.publish as {
      provider?: unknown;
      watchUrl?: unknown;
      expiresAt?: unknown;
    } | null;
    runs.push({
      runId: entry.name,
      runDir,
      createdAt: await createdAt(entry.name, runDir),
      title: str(result.title) ?? '',
      durationSec: typeof result.durationSec === 'number' ? result.durationSec : 0,
      video: join(runDir, RUN_FILE.video),
      publish: published
        ? {
            provider: str(published.provider) ?? 'unknown',
            watchUrl: str(published.watchUrl),
            expiresAt: str(published.expiresAt),
          }
        : null,
    });
  }
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.runId.localeCompare(a.runId));
}

function formatRunList(runs: RunSummary[], style: Style): string {
  if (runs.length === 0) return 'No videos in the runs folder yet. Make one with: mergestory generate\n';
  const rows = runs.map((r) => [
    r.runId,
    formatTime(r.createdAt)?.replace(' UTC', '') ?? '',
    terminalSafe(r.title).replace(/\s+/g, ' ').slice(0, 60),
    formatDuration(r.durationSec),
    !r.publish || r.publish.provider === 'local' ? 'this machine' : terminalSafe(r.publish.provider),
    r.publish?.watchUrl ? terminalSafe(r.publish.watchUrl) : '',
  ]);
  const header = ['RUN', 'DATE', 'TITLE', 'LENGTH', 'WENT TO', 'LINK'];
  const width = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]): string =>
    cells
      .map((c, i) => c.padEnd(width[i]!))
      .join('  ')
      .trimEnd();
  return `${[style.dim(line(header)), ...rows.map(line)].join('\n')}\n`;
}

async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? await folderBytes(path) : (await lstat(path)).size;
  }
  return total;
}

/** The folder of a run that may be deleted, or the reason why not. Nothing outside the runs folder qualifies. */
async function deletableRun(runsDir: string, id: string): Promise<string> {
  if (!RUN_ID_PATTERN.test(id)) {
    throw new MergeStoryError('SOURCE_INVALID', `"${terminalSafe(id)}" is not a run id.`, {
      hint: 'A run id looks like 20261103-214501-a3f9. List them with `mergestory runs`.',
    });
  }
  const dir = join(runsDir, id);
  const info = await lstat(dir).catch(() => null);
  if (!info) throw new MergeStoryError('SOURCE_NOT_FOUND', `No run ${id} on this machine.`);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new MergeStoryError(
      'SOURCE_INVALID',
      `${id} is not a run folder (it is a link or a file), so it was kept.`,
    );
  }
  // A dry run leaves only the analysis, so that file also marks a folder MergeStory made.
  const made = [RUN_FILE.result, RUN_FILE.publishInput, RUN_FILE.analysis];
  if (!made.some((name) => existsSync(join(dir, name)))) {
    throw new MergeStoryError(
      'SOURCE_INVALID',
      `${id} holds none of the files of a run (${made.join(', ')}), so it was kept.`,
    );
  }
  return dir;
}

/** Add the `runs` command. */
export function registerRuns(program: Command, rt: CliRuntime): void {
  const runs = program
    .command('runs')
    .description('List the videos on this machine, or delete one')
    .option(
      '--limit <n>',
      'how many runs to show (1-500)',
      numberFlag({ integer: true, min: 1, max: 500 }),
      20,
    )
    .action(async (flags: { limit: number }, cmd: Command) => {
      const env = rt.env(cmd);
      const { runs: runsDir } = homeLayout((await loadConfig(env)).home);
      const list = (await listRuns(runsDir)).slice(0, flags.limit);
      if (env.json) env.emitJson({ ok: true, runs: list });
      else env.say(formatRunList(list, env.style));
    });

  runs
    .command('delete')
    .description('Delete run folders (the video, its files and its result) and their jobs from this machine')
    .argument('[run-id...]', 'run id, as listed by `mergestory runs`')
    .option(
      '--older-than <days>',
      'delete every run and finished job made more than this many days ago (1-3650)',
      numberFlag({ integer: true, min: 1, max: 3650 }),
    )
    .action(async (ids: string[], flags: { olderThan?: number }, cmd: Command) => {
      const env = rt.env(cmd);
      if (ids.length > 0 === (flags.olderThan !== undefined)) {
        throw new MergeStoryError('USAGE', 'Give run ids or --older-than, one of the two.', {
          hint: 'For example: mergestory runs delete --older-than 30',
        });
      }
      const layout = homeLayout((await loadConfig(env)).home);
      const runsDir = layout.runs;
      const store = new JobStore(layout.jobs);
      const jobs = await jobsByRun(store);
      const targets =
        flags.olderThan === undefined ? new Set(ids) : await idsOlderThan(runsDir, jobs, flags.olderThan);
      const deleted: string[] = [];
      const errors: { runId: string; message: string }[] = [];
      let freedBytes = 0;
      for (const id of targets) {
        try {
          const own = jobs.get(id) ?? [];
          // A run that a job is still making is kept whole: its folder and its job.
          if (own.some((job) => !isTerminal(job.status))) {
            throw new MergeStoryError('SOURCE_INVALID', `${id} is still being made, so it was kept.`);
          }
          // A job whose run folder is gone (a failed job, or a run deleted before) leaves only its job.
          const onlyJobs = own.length > 0 && !(await lstat(join(runsDir, id)).catch(() => null));
          const dir = onlyJobs ? null : await deletableRun(runsDir, id);
          for (const job of own) {
            freedBytes += await folderBytes(store.jobDir(job.id));
            await store.remove(job.id);
          }
          if (dir) {
            freedBytes += await folderBytes(dir);
            await rm(dir, { recursive: true, force: true });
          }
          deleted.push(id);
        } catch (err) {
          if (!(err instanceof MergeStoryError)) throw err;
          errors.push({ runId: terminalSafe(id), message: err.message });
        }
      }
      if (errors.length > 0) env.setExitCode(EXIT_CODES.SOURCE_INVALID);
      if (env.json) {
        env.emitJson({
          ok: errors.length === 0,
          deleted,
          freedBytes,
          ...(errors.length > 0 ? { errors } : {}),
        });
        return;
      }
      for (const e of errors) env.logger.error(e.message);
      if (deleted.length > 0) env.say(`Deleted ${deleted.join(', ')} (freed ${formatBytes(freedBytes)}).`);
    });
}
