/**
 * For callers that write the storyboard themselves (a coding agent, or a person): prepare the
 * evidence and the guide, then check what they wrote without rendering anything.
 */
import { writeFile } from 'node:fs/promises';
import { estimateTokens } from '../core/cost.ts';
import { runFolder, writeRunJson } from '../core/run-folder.ts';
import { wordBudget } from '../core/storyboard-facts.ts';
import { storyboardJsonSchema } from '../core/storyboard-schema.ts';
import {
  AUTHORING_GUIDE,
  AUTHORING_VALUES,
  type ValidationResult,
  validateStoryboard,
} from '../storyboard/index.ts';
import { commandLine } from './commands.ts';
import { describeFit } from './fit-duration.ts';
import { type Prepared, packFor, prepare } from './prepare.ts';
import { changeLabel, repoLabel } from './presentation.ts';
import { fitStoryboard } from './storyboard-choice.ts';
import type { AuthoringOptions, AuthoringResult, GenerateHooks, GenerateOptions } from './types.ts';

/** The evidence pack for an author may be larger than the one for a model: nobody pays per token here. */
const AUTHOR_PACK_TOKENS = 40_000;

/** Analyse a change and write everything an agent needs to author a storyboard itself. Free and offline (besides reading the PR). */
export async function prepareAuthoring(
  options: AuthoringOptions,
  hooks: GenerateHooks = {},
): Promise<AuthoringResult> {
  const p = await prepare({ ...options, dryRun: true }, hooks, options.outDir ?? null);
  const { ctx } = p;
  const pack = packFor(p, Math.max(AUTHOR_PACK_TOKENS, p.config.llm.maxInputTokens));
  const folder = runFolder(ctx.runDir);
  const files = {
    analysis: folder.analysis,
    evidence: folder.evidence,
    guide: folder.guide,
    schema: folder.schema,
  };
  await writeFile(files.evidence, pack.markdown, { mode: 0o600 });
  const guide = authoringDocument(p, options.followUp ?? null);
  const schema = storyboardJsonSchema();
  await writeFile(files.guide, guide, { mode: 0o600 });
  await writeRunJson(files.schema, schema);
  // The guide names every field and every allowed value, so the schema is not part of what an agent reads.
  const readTokens = estimateTokens(pack.markdown + guide);
  ctx.progress({
    stage: 'analyze',
    status: 'done',
    message: `Wrote the evidence pack (${pack.includedHunks.length} hunks). The agent reads about ${readTokens} tokens: the evidence pack and the guide.`,
  });
  return {
    runId: ctx.runId,
    runDir: ctx.runDir,
    files,
    summary: {
      title: p.changeSet.pr?.title ?? p.changeSet.commits[0]?.subject ?? changeLabel(p.changeSet),
      changeLabel: `${repoLabel(p.changeSet)} ${changeLabel(p.changeSet)}`,
      size: p.analysis.size,
      files: p.changeSet.stats.files,
      suggestedDurationSec: p.targetSec,
      evidenceItems: p.analysis.evidence.length,
    },
  };
}

/**
 * The text of AUTHORING.md. Steps 3 and 4 show `validate` and `generate` with the source and flags
 * that `analyze` ran with. Task, notes, test results, reproduction, screenshots, recordings and logs are what create the ids
 * TASK, NOTES, T1, REPRO, SS1, RC1 and L1, so a command that leaves them out would remove every line that cites them.
 */
function authoringDocument(p: Prepared, followUp: AuthoringOptions['followUp'] | null): string {
  const storyboard = runFolder(p.ctx.runDir).storyboard;
  const agent = followUp?.agent === true;
  const validate = !followUp
    ? 'mergestory validate storyboard.json <source>'
    : agent
      ? commandLine(['mergestory', 'agent', 'validate', followUp.source, ...followUp.args])
      : commandLine(['mergestory', 'validate', storyboard, followUp.source, ...followUp.args]);
  const generate = !followUp
    ? 'mergestory generate <source> --storyboard storyboard.json'
    : agent
      ? commandLine(['mergestory', 'agent', 'render', followUp.source, ...followUp.args])
      : commandLine([
          'mergestory',
          'generate',
          followUp.source,
          ...followUp.args,
          '--storyboard',
          storyboard,
        ]);
  return [
    '# Writing the storyboard',
    '',
    `Target length: about ${p.targetSec} seconds (about ${wordBudget(p.targetSec)} words of narration in total). This is a guide, not a limit: narration over it is kept as it is.`,
    `Longest video: ${p.config.maxDurationSec} seconds. When a storyboard is estimated to be longer, \`validate\` warns (over-length) and \`generate\` leaves out the least important scenes and lines (never the mission or the review scene).`,
    `Style: ${p.config.style}. Narration language: ${p.config.language}.`,
    '',
    '1. Read `evidence.md` in this folder. It lists every fact you may use, each with an id.',
    '2. Write `storyboard.json`, following the rules below. They show every field and list every allowed value, so you do not need to read `storyboard.schema.json`. Open that file only when the check reports a schema error that its message does not explain.',
    `3. Check it: \`${validate}\` (fix every error it reports).`,
    `4. Render it: \`${generate}\`.`,
    ...(followUp
      ? []
      : [
          '',
          'Give both commands the same source and the same `--base`, `--head`, `--task-file`, `--notes-file`, `--tests-file`,',
          '`--repro-file`, `--screenshot`, `--screenshots-dir`, `--recording`, `--redact` and `--log` flags as the analysis. They create the ids TASK, NOTES, T1, REPRO, SS1, RC1 and L1. Without them those ids do not',
          'exist, and lines that cite only them are removed.',
        ]),
    '',
    'You know why the change was made. Put that in the narration, but only claim what the evidence shows.',
    `Decisions and context that are not in the diff belong in the task or notes (${agent ? '`task.md`, `notes.md` in this folder' : '`--task-file`, `--notes-file`'}),`,
    'so they become citable evidence (TASK, NOTES).',
    ...(agent
      ? [
          'Real screenshots (PNG or JPEG) go in the `screenshots/` folder here. They become SS1, SS2 and so on.',
          'Screen recordings (MP4, QuickTime, WebM or Matroska) go in the `recordings/` folder here. They become RC1, RC2 and so on.',
          'The steps that show the bug go in `repro.json` here. They become REPRO, REPRO.1, REPRO.2 and so on.',
          'Parts of a screenshot or recording that must not show go in `redact.json` here: {"SS1": [{"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.05}]}, fractions of the picture. A region of a recording is hidden for the whole clip.',
          'Logs (UTF-8 text) go in the `logs/` folder here, as `.log` or `.txt` files. They become L1, L2 and so on. `evidence.md` shows only an excerpt of each: the full files are in `logs/`.',
        ]
      : []),
    '',
    AUTHORING_GUIDE,
    AUTHORING_VALUES,
  ].join('\n');
}

/** "Storyboard has errors: 3 (schema 2, uncited-line 1)". Numbers and codes only, so it quotes no narration or code. */
function errorSummary(errors: ValidationResult['errors']): string {
  const counts = new Map<string, number>();
  for (const error of errors) counts.set(error.code, (counts.get(error.code) ?? 0) + 1);
  const codes = [...counts]
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([code, count]) => `${code} ${count}`);
  return `Storyboard has errors: ${errors.length} (${codes.join(', ')})`;
}

/** Validate a storyboard against a change without rendering (mergestory validate). */
export async function checkStoryboard(
  options: Omit<GenerateOptions, 'dryRun'> & { storyboard: unknown },
  hooks: GenerateHooks = {},
): Promise<ValidationResult> {
  // Nothing here reads analysis.json, so no run folder is made.
  const p = await prepare({ ...options, dryRun: true }, hooks, undefined, { writeAnalysis: false });
  const result = await validateStoryboard(options.storyboard, {
    changeSet: p.changeSet,
    analysis: p.analysis,
    inputs: p.inputs,
    reader: p.reader,
    config: p.config,
    authored: true,
  });
  // The caller gets the errors as data. This line is for whoever reads the log.
  if (result.errors.length > 0) {
    p.ctx.progress({ stage: 'validate', status: 'warn', message: errorSummary(result.errors) });
  }
  if (!result.storyboard) return result;
  // Say what rendering would do when the storyboard is over the maximum length.
  const messages = describeFit(fitStoryboard(p, result.storyboard), p.config.maxDurationSec, 'would');
  if (messages.length === 0) return result;
  return {
    ...result,
    warnings: [
      ...result.warnings,
      ...messages.map((message) => ({ path: 'scenes', code: 'over-length' as const, message })),
    ],
  };
}
