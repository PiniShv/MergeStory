/**
 * For callers that write the storyboard themselves (a coding agent, or a person): prepare the
 * evidence and the guide, then check what they wrote without rendering anything.
 */
import { writeFile } from 'node:fs/promises';
import { estimateTokens } from '../core/cost.ts';
import { runFolder, writeRunJson } from '../core/run-folder.ts';
import { wordBudget } from '../core/storyboard-facts.ts';
import { storyboardJsonSchema } from '../core/storyboard-schema.ts';
import { AUTHORING_GUIDE, type ValidationResult, validateStoryboard } from '../storyboard/index.ts';
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
  await writeFile(files.guide, authoringDocument(p, options.followUp ?? null), { mode: 0o600 });
  await writeRunJson(files.schema, storyboardJsonSchema());
  ctx.progress({
    stage: 'analyze',
    status: 'done',
    message: `Wrote the evidence pack (${pack.includedHunks.length} hunks, about ${estimateTokens(pack.markdown)} tokens)`,
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
 * that `analyze` ran with. Task, notes, test results and screenshots are what create the ids TASK,
 * NOTES, T1 and SS1, so a command that leaves them out would remove every line that cites them.
 */
function authoringDocument(p: Prepared, followUp: AuthoringOptions['followUp'] | null): string {
  const storyboard = runFolder(p.ctx.runDir).storyboard;
  const validate = followUp
    ? commandLine(['mergestory', 'validate', storyboard, followUp.source, ...followUp.args])
    : 'mergestory validate storyboard.json <source>';
  const generate = followUp
    ? commandLine(['mergestory', 'generate', followUp.source, ...followUp.args, '--storyboard', storyboard])
    : 'mergestory generate <source> --storyboard storyboard.json';
  return [
    '# Writing the storyboard',
    '',
    `Target length: about ${p.targetSec} seconds (about ${wordBudget(p.targetSec)} words of narration in total).`,
    `Longest video: ${p.config.maxDurationSec} seconds. When a storyboard is estimated to be longer, \`generate\` leaves out the least important scenes and lines (never the mission or the review scene).`,
    `Style: ${p.config.style}. Narration language: ${p.config.language}.`,
    '',
    '1. Read `evidence.md` in this folder. It lists every fact you may use, each with an id.',
    '2. Write `storyboard.json` that matches `storyboard.schema.json`, following the rules below.',
    `3. Check it: \`${validate}\` (fix every error it reports).`,
    `4. Render it: \`${generate}\`.`,
    ...(followUp
      ? []
      : [
          '',
          'Give both commands the same source and the same `--base`, `--head`, `--task-file`, `--notes-file`, `--tests-file`',
          'and `--screenshot` flags as the analysis. They create the ids TASK, NOTES, T1 and SS1. Without them those ids do not',
          'exist, and lines that cite only them are removed.',
        ]),
    '',
    'You know why the change was made. Put that in the narration, but only claim what the evidence shows.',
    'Decisions and context that are not in the diff belong in the task or notes (`--task-file`, `--notes-file`),',
    'so they become citable evidence (TASK, NOTES).',
    '',
    AUTHORING_GUIDE,
  ].join('\n');
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
  });
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
