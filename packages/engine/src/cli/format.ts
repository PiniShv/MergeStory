/**
 * Human-readable output. Every function takes data that is already redacted and returns text; the
 * commands decide where to print it. No function here reads the environment or the file system.
 * Text from the data is cleaned of control characters first (see terminalSafe): titles, messages and
 * paths can come from a pull request or a repository.
 */

import { shellQuote, terminalSafe } from '../core/text.ts';
import type { CostReport, EgressRecord, GenerateResult, PlanResult } from '../core/types.ts';
import type { JobSummary, PublicJob } from '../jobs/view.ts';
import type { AuthoringResult } from '../pipeline/index.ts';
import type { ValidationResult } from '../storyboard/index.ts';
import { formatBytes } from './files.ts';
import type { Style } from './style.ts';

/** A copy of `value` in which every string is safe to print to a terminal. */
function clean<T>(value: T): T {
  return cleanValue(value) as T;
}

function cleanValue(value: unknown): unknown {
  if (typeof value === 'string') return terminalSafe(value);
  if (Array.isArray(value)) return value.map(cleanValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cleanValue(item)]));
  }
  return value;
}

/** "1m 32s", or "45s" under a minute. */
export function formatElapsed(totalSec: number): string {
  const seconds = Math.max(0, Math.round(totalSec));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** "1:23", or "1:02:05" from one hour on. */
export function formatDuration(totalSec: number): string {
  const seconds = Math.max(0, Math.round(totalSec));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const two = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** Dollar amount with a fixed number of decimals. */
export function formatUsd(amount: number, digits = 4): string {
  return `$${amount.toFixed(digits)}`;
}

/** "$0.0042 (LLM $0.0040, speech $0.0002), budget $0.25" */
export function formatCost(cost: CostReport): string {
  const sum = (kind: string): number =>
    cost.records.filter((r) => r.kind === kind).reduce((total, r) => total + r.costUsd, 0);
  const parts = [`LLM ${formatUsd(sum('llm'))}`, `speech ${formatUsd(sum('tts'))}`];
  const other = sum('storage') + sum('other');
  if (other > 0) parts.push(`other ${formatUsd(other)}`);
  let text = `${formatUsd(cost.totalUsd)} (${parts.join(', ')})`;
  if (cost.totalUsd > 0 && cost.records.some((r) => r.estimated)) text += ', estimated from list prices';
  return `${text}, budget ${formatUsd(cost.budgetUsd, 2)}`;
}

/** One outbound transfer: where, why, how much and what was in it. */
export function formatEgress(raw: EgressRecord): string {
  const record = clean(raw);
  const what = record.contains.length > 0 ? ` (${record.contains.join(', ')})` : '';
  return `${record.destination}: ${record.purpose}, ${formatBytes(record.bytes)}${what}`;
}

type Row = [label: string, value: string | string[] | null | undefined];

/** Aligned "label  value" lines. Rows without a value are skipped; list values continue on indented lines. */
export function formatRows(rows: Row[], style: Style, indent = '  '): string[] {
  const shown = rows.filter((row): row is [string, string | string[]] => {
    const value = row[1];
    return (
      value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0)
    );
  });
  const width = Math.max(0, ...shown.map(([label]) => label.length));
  const lines: string[] = [];
  for (const [label, value] of shown) {
    const values = Array.isArray(value) ? value : [value];
    values.forEach((text, i) => {
      const left = i === 0 ? style.dim(label.padEnd(width)) : ' '.repeat(width);
      lines.push(`${indent}${left}  ${terminalSafe(text)}`);
    });
  }
  return lines;
}

function sentLines(egress: EgressRecord[], dryRun: boolean): string[] {
  if (egress.length === 0) return [dryRun ? 'nothing would leave this machine' : 'nothing left this machine'];
  return egress.map(formatEgress);
}

function chapterLines(chapters: { title: string; startSec: number }[]): string[] {
  return chapters.map((c) => `${formatDuration(c.startSec).padStart(5)}  ${c.title}`);
}

/** The label and the text of the row that says where the video went. A link to a file is no sharing. */
function publishedRow(publish: NonNullable<GenerateResult['publish']>): [string, string] {
  const link = publish.watchUrl ?? publish.videoUrl;
  if (publish.provider === 'local') return ['Saved', `${link}  (saved on this machine)`];
  return ['Shared', sharedLine(publish)];
}

function sharedLine(publish: NonNullable<GenerateResult['publish']>): string {
  const link = publish.watchUrl ?? publish.videoUrl;
  const expiry = publish.expiresAt ? `, link expires ${publish.expiresAt}` : '';
  return `${link}  (${publish.visibility}${expiry})`;
}

function notifyLine(notify: NonNullable<GenerateResult['notify']>): string | null {
  const parts: string[] = [];
  if (notify.commentUrl) parts.push(`comment ${notify.commentUrl}`);
  if (notify.descriptionUpdated) parts.push('description updated');
  return parts.length > 0 ? parts.join(', ') : null;
}

/** The block printed when a video is ready. */
export function formatGenerateResult(raw: GenerateResult, style: Style): string {
  const result = clean(raw);
  const grounding = result.grounding;
  const fixes =
    grounding.fixes.length > 0
      ? `, ${grounding.fixes.length} automatic fix${grounding.fixes.length === 1 ? '' : 'es'}`
      : '';
  const lines = [
    `${style.green('Video ready')}: ${result.title}`,
    '',
    ...formatRows(
      [
        ['Video', result.files.video],
        ['Watch page', result.files.watchPage],
        ...(result.publish ? [publishedRow(result.publish)] : []),
        ['Pull request', result.notify ? notifyLine(result.notify) : null],
        ['Length', formatDuration(result.durationSec)],
        [
          'Storyboard',
          `${result.storyboardSource}, ${grounding.groundedClaims} narration line${grounding.groundedClaims === 1 ? '' : 's'} cite evidence${fixes}`,
        ],
        ['Run folder', result.runDir],
        ['Made in', result.elapsedSec === undefined ? null : formatElapsed(result.elapsedSec)],
        ['Cost', formatCost(result.cost)],
        ['Sent', sentLines(result.egress, false)],
      ],
      style,
    ),
  ];
  if (result.chapters.length > 0)
    lines.push('', style.bold('Chapters'), ...chapterLines(result.chapters).map((l) => `  ${l}`));
  if (result.warnings.length > 0)
    lines.push('', style.yellow('Warnings'), ...result.warnings.map((w) => `  - ${w}`));
  return `${lines.join('\n')}\n`;
}

/** The block printed for a dry run. */
export function formatPlanResult(raw: PlanResult, style: Style): string {
  const plan = clean(raw);
  const lines = [
    `${style.cyan('Dry run')}: ${plan.title}`,
    style.dim('Nothing was sent, rendered or published.'),
    '',
    ...formatRows(
      [
        ['Storyboard', plan.storyboardSource],
        ['Length', `about ${formatDuration(plan.estimatedDurationSec)}`],
        [
          'Providers',
          `LLM ${plan.providers.llm}, speech ${plan.providers.tts}, publish ${plan.providers.publish}`,
        ],
        ['Est. cost', formatCost(plan.estimatedCost)],
        ['Would send', sentLines(plan.plannedEgress, true)],
        ['Run folder', plan.runDir],
      ],
      style,
    ),
  ];
  if (plan.scenes.length > 0) {
    lines.push('', style.bold(`Scenes (${plan.scenes.length})`));
    for (const [i, scene] of plan.scenes.entries()) {
      lines.push(
        `  ${String(i + 1).padStart(2)}. ${scene.title}  ${style.dim(`${scene.role}, ${scene.visual}`)}`,
      );
    }
  }
  if (plan.warnings.length > 0)
    lines.push('', style.yellow('Warnings'), ...plan.warnings.map((w) => `  - ${w}`));
  lines.push('', style.dim('Run again without --dry-run to make the video.'));
  return `${lines.join('\n')}\n`;
}

/** What the follow-up commands after `analyze` need to repeat. */
export interface AuthoringContext {
  /** The source as typed, for the follow-up commands. */
  source: string;
  base?: string | undefined;
  head?: string | undefined;
}

/** The block printed by `analyze`: the files and the next steps. */
export function formatAuthoring(
  rawResult: AuthoringResult,
  rawContext: AuthoringContext,
  style: Style,
): string {
  const result = clean(rawResult);
  const context = clean(rawContext);
  const { summary } = result;
  const storyboardPath = `${result.runDir.replace(/[\\/]+$/, '')}/storyboard.json`;
  const refs = `${context.base ? ` --base ${shellQuote(context.base)}` : ''}${context.head ? ` --head ${shellQuote(context.head)}` : ''}`;
  const source = shellQuote(context.source);
  const lines = [
    `${style.green('Analysis ready')}: ${summary.title}`,
    '',
    ...formatRows(
      [
        [
          'Change',
          `${summary.changeLabel} (size ${summary.size}, ${summary.files} file${summary.files === 1 ? '' : 's'})`,
        ],
        ['Length', `suggested about ${formatDuration(summary.suggestedDurationSec)}`],
        ['Evidence', `${summary.evidenceItems} items the storyboard may cite`],
      ],
      style,
    ),
    '',
    style.bold('Files'),
    ...formatRows(
      [
        ['analysis.json', result.files.analysis],
        ['evidence.md', result.files.evidence],
        ['AUTHORING.md', result.files.guide],
        ['storyboard.schema.json', result.files.schema],
      ],
      style,
    ),
    '',
    style.bold('Next steps'),
    '  1. Read AUTHORING.md and evidence.md.',
    `  2. Write ${storyboardPath} so that it follows storyboard.schema.json.`,
    `  3. Check it: mergestory validate ${shellQuote(storyboardPath)} ${source}${refs}`,
    `  4. Make the video: mergestory generate ${source}${refs} --storyboard ${shellQuote(storyboardPath)}`,
  ];
  return `${lines.join('\n')}\n`;
}

/** The block printed by `validate`. */
export function formatValidation(raw: ValidationResult, style: Style): string {
  const result = clean(raw);
  const issueLine = (kind: 'error' | 'warn', i: { path: string; code: string; message: string }): string =>
    `  ${kind === 'error' ? style.red('error') : style.yellow('warn ')}  ${i.path || '(storyboard)'}  [${i.code}]  ${i.message}`;
  const lines: string[] = [];
  if (result.errors.length === 0) {
    lines.push(
      `${style.green('Storyboard is valid')}: ${result.groundedClaims} narration line${result.groundedClaims === 1 ? '' : 's'} cite evidence.`,
    );
  } else {
    lines.push(
      `${style.red('Storyboard has errors')}: ${result.errors.length} to fix before it can be rendered.`,
    );
  }
  if (result.errors.length > 0) lines.push('', ...result.errors.map((i) => issueLine('error', i)));
  if (result.warnings.length > 0) lines.push('', ...result.warnings.map((i) => issueLine('warn', i)));
  if (result.fixes.length > 0) {
    lines.push('', style.bold('Fixed automatically when rendering'), ...result.fixes.map((f) => `  - ${f}`));
  }
  return `${lines.join('\n')}\n`;
}

/** ISO time as "2026-11-03 21:45:01 UTC". */
export function formatTime(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : `${date.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

function statusColor(status: string, style: Style): string {
  if (status === 'succeeded') return style.green(status);
  if (status === 'failed') return style.red(status);
  if (status === 'running') return style.cyan(status);
  return status;
}

/** "render 45%", or just the stage when no percentage is known. */
export function formatProgress(job: Pick<PublicJob, 'progress'>): string {
  const { stage, progress } = job.progress;
  return progress === null ? stage : `${stage} ${Math.round(progress * 100)}%`;
}

/** One job, with its result or error. */
export function formatJob(raw: PublicJob, style: Style): string {
  const job = clean(raw);
  const lines = [
    `Job ${job.id}: ${statusColor(job.status, style)}`,
    ...formatRows(
      [
        ['Stage', job.status === 'queued' || job.status === 'running' ? formatProgress(job) : null],
        ['Message', job.status === 'queued' || job.status === 'running' ? job.progress.message : null],
        ['Created', formatTime(job.createdAt)],
        ['Started', formatTime(job.startedAt)],
        ['Finished', formatTime(job.finishedAt)],
        ['Error', job.error ? `[${job.error.code}] ${job.error.message}` : null],
        ['Hint', job.error?.hint ?? null],
      ],
      style,
    ),
  ];
  if (job.result) {
    const result = job.result;
    lines.push(
      '',
      'dryRun' in result && result.dryRun === true
        ? formatPlanResult(result, style).trimEnd()
        : formatGenerateResult(result as GenerateResult, style).trimEnd(),
    );
  }
  return `${lines.join('\n')}\n`;
}

/** One job, with its result or error. */
export function formatJobList(raw: JobSummary[], style: Style): string {
  const jobs = clean(raw);
  if (jobs.length === 0) return `No jobs yet. Start one with: mergestory generate --async\n`;
  const rows = jobs.map((job) => ({
    id: job.id,
    status: job.status,
    stage: job.status === 'succeeded' || job.status === 'failed' ? '' : formatProgress(job),
    created: formatTime(job.createdAt)?.replace(' UTC', '') ?? '',
    what: job.error ? `[${job.error.code}] ${job.error.message}` : (job.title ?? ''),
  }));
  const width = (pick: (r: (typeof rows)[number]) => string, min: number): number =>
    Math.max(min, ...rows.map((r) => pick(r).length));
  const w = {
    id: width((r) => r.id, 2),
    status: width((r) => r.status, 6),
    stage: width((r) => r.stage, 5),
    created: width((r) => r.created, 7),
  };
  const header = `${'ID'.padEnd(w.id)}  ${'STATUS'.padEnd(w.status)}  ${'STAGE'.padEnd(w.stage)}  ${'CREATED'.padEnd(w.created)}  TITLE OR ERROR`;
  const lines = rows.map((r) => {
    const status = r.status.padEnd(w.status).replace(r.status, statusColor(r.status, style));
    const what = r.what.length > 70 ? `${r.what.slice(0, 69)}...` : r.what;
    return `${r.id.padEnd(w.id)}  ${status}  ${r.stage.padEnd(w.stage)}  ${r.created.padEnd(w.created)}  ${what}`;
  });
  return `${[style.dim(header), ...lines].join('\n')}\n`;
}

/** An error as it is shown to people. */
export interface ErrorView {
  code: string;
  message: string;
  hint: string | null;
  exitCode: number;
}

/** "error [CODE]: message" and a hint line. */
export function formatError(raw: ErrorView, style: Style): string {
  const error = clean(raw);
  const lines = [`${style.red(`error [${error.code}]`)}: ${error.message}`];
  if (error.hint) lines.push(`${style.cyan('hint')}: ${error.hint}`);
  return `${lines.join('\n')}\n`;
}
