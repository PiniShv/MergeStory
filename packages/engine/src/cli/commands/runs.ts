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

/** The time in a run id ("20261103-214501-a3f9"), or the folder's modification time for any other name. */
async function createdAt(id: string, dir: string): Promise<string> {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(id);
  if (m && RUN_ID_PATTERN.test(id)) {
    const date = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return (await stat(dir)).mtime.toISOString();
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
  if (runs.length === 0) return 'No videos on this machine yet. Make one with: mergestory generate\n';
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
  if (!existsSync(join(dir, RUN_FILE.result)) && !existsSync(join(dir, RUN_FILE.publishInput))) {
    throw new MergeStoryError(
      'SOURCE_INVALID',
      `${id} holds no ${RUN_FILE.result} or ${RUN_FILE.publishInput}, so it was kept.`,
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
    .description('Delete run folders (the video, its files and its result) from this machine')
    .argument('<run-id...>', 'run id, as listed by `mergestory runs`')
    .action(async (ids: string[], _options: unknown, cmd: Command) => {
      const env = rt.env(cmd);
      const { runs: runsDir } = homeLayout((await loadConfig(env)).home);
      const deleted: string[] = [];
      const errors: { runId: string; message: string }[] = [];
      let freedBytes = 0;
      for (const id of new Set(ids)) {
        try {
          const dir = await deletableRun(runsDir, id);
          const bytes = await folderBytes(dir);
          await rm(dir, { recursive: true, force: true });
          deleted.push(id);
          freedBytes += bytes;
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
