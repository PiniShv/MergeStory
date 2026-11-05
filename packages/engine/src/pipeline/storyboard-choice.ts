/**
 * The storyboard stage: use the one the caller wrote, ask the model, or build the offline one.
 * Whatever the source, the result has passed the grounding validator.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MergeStoryError, toMergeStoryError } from '../core/errors.ts';
import type { LlmProvider } from '../core/providers.ts';
import { RUN_FILE } from '../core/run-folder.ts';
import { BACKING_EVIDENCE_KINDS } from '../core/storyboard-facts.ts';
import { type Storyboard, storyboardJsonSchemaForLlm } from '../core/storyboard-schema.ts';
import type { Analysis } from '../core/types.ts';
import { createLlmProvider } from '../llm/index.ts';
import {
  buildSystemPrompt,
  estimateStoryboardCost,
  generateStoryboard,
  heuristicStoryboard,
  type ValidationDeps,
  type ValidationResult,
  validateStoryboard,
} from '../storyboard/index.ts';
import { type FitResult, fitToMaxDuration } from './fit-duration.ts';
import { type Prepared, packFor } from './prepare.ts';

/** What a dry run works out about the model call that it does not make. */
export interface PlannedLlm {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  promptBytes: number;
}

/** The storyboard and where it came from. Only a model storyboard has a provider. */
export type StoryboardChoice = {
  storyboard: Storyboard;
  validation: ValidationResult;
} & (
  | { source: 'agent' }
  | { source: 'heuristic' }
  | {
      source: 'llm';
      provider: LlmProvider;
      /** Set in dry runs: the model was not called; the offline storyboard stands in for planning. */
      plannedLlm: PlannedLlm | null;
    }
);

function validationDeps(p: Prepared): ValidationDeps {
  return {
    changeSet: p.changeSet,
    analysis: p.analysis,
    inputs: p.inputs,
    reader: p.reader,
    config: p.config,
  };
}

async function offlineStoryboard(
  p: Prepared,
): Promise<{ storyboard: Storyboard; validation: ValidationResult }> {
  const draft = heuristicStoryboard(p.changeSet, p.analysis, p.inputs, p.config, p.targetSec);
  const validation = await validateStoryboard(draft, { ...validationDeps(p), offline: true });
  if (!validation.storyboard) {
    throw new MergeStoryError('INTERNAL', 'The offline storyboard did not pass validation.', {
      details: { errors: validation.errors.slice(0, 10) },
    });
  }
  return { storyboard: validation.storyboard, validation };
}

/** The storyboard that the caller wrote, checked. */
async function suppliedStoryboard(p: Prepared, supplied: unknown): Promise<StoryboardChoice> {
  const validation = await validateStoryboard(supplied, validationDeps(p));
  if (!validation.storyboard) {
    throw new MergeStoryError(
      'GROUNDING_FAILED',
      `The supplied storyboard has ${validation.errors.length} problem(s) that block rendering.`,
      {
        hint: 'Fix the listed problems and run again. `mergestory validate <storyboard.json> <source>` checks without rendering.',
        details: { errors: validation.errors.slice(0, 40), warnings: validation.warnings.slice(0, 20) },
      },
    );
  }
  p.ctx.progress({ stage: 'storyboard', status: 'done', message: 'Using the supplied storyboard' });
  return { storyboard: validation.storyboard, validation, source: 'agent' };
}

/** A model storyboard, or (in a dry run) the plan for one. Falls back to the offline storyboard when the model fails. */
async function modelStoryboard(p: Prepared, provider: LlmProvider): Promise<StoryboardChoice> {
  const { ctx } = p;
  const pack = packFor(p, p.config.llm.maxInputTokens);
  await writeFile(join(ctx.runDir, RUN_FILE.evidence), pack.markdown, { mode: 0o600 });
  if (ctx.dryRun) {
    const estimate = estimateStoryboardCost(provider, pack, p.config, ctx);
    const out = await offlineStoryboard(p);
    ctx.progress({
      stage: 'storyboard',
      status: 'skip',
      message: `Dry run: ${provider.id} would be called (${provider.model})`,
    });
    return {
      ...out,
      source: 'llm',
      provider,
      plannedLlm: {
        ...estimate,
        // The model receives the system prompt and the schema as well as the evidence pack.
        promptBytes:
          Buffer.byteLength(pack.markdown) +
          Buffer.byteLength(buildSystemPrompt(p.config)) +
          Buffer.byteLength(JSON.stringify(storyboardJsonSchemaForLlm())),
      },
    };
  }
  try {
    const result = await generateStoryboard(
      { provider, pack, deps: validationDeps(p), targetSec: p.targetSec },
      ctx,
    );
    ctx.progress({
      stage: 'storyboard',
      status: 'done',
      message: `Storyboard from ${provider.model}${result.cached ? ' (cached)' : ''}, ${result.attempts} attempt(s)`,
    });
    return {
      storyboard: result.storyboard,
      validation: result.validation,
      source: 'llm',
      provider,
      plannedLlm: null,
    };
  } catch (err) {
    const error = toMergeStoryError(err, 'LLM_FAILED');
    if (error.code === 'BUDGET_EXCEEDED' || error.code === 'ABORTED' || error.code === 'CONFIG_INVALID')
      throw error;
    ctx.progress({
      stage: 'storyboard',
      status: 'warn',
      message: `LLM storyboard failed (${error.message}); using the offline storyboard instead`,
    });
    return { ...(await offlineStoryboard(p)), source: 'heuristic' };
  }
}

/** Get the storyboard for this run. `supplied` is a storyboard that the caller wrote, if any. */
export async function chooseStoryboard(p: Prepared, supplied: unknown): Promise<StoryboardChoice> {
  const { ctx } = p;
  ctx.progress({ stage: 'storyboard', status: 'start', message: 'Building the storyboard' });
  if (supplied !== undefined) return suppliedStoryboard(p, supplied);
  const provider = createLlmProvider(p.config, ctx.secrets);
  if (provider) return modelStoryboard(p, provider);
  const out = await offlineStoryboard(p);
  ctx.progress({
    stage: 'storyboard',
    status: 'done',
    message: 'Built an offline storyboard (no LLM configured)',
  });
  return { ...out, source: 'heuristic' };
}

/** Ids of the changed files, hunks and symbols: what shows that simulated behaviour exists in the change. */
function backingEvidence(analysis: Analysis): Set<string> {
  return new Set(
    analysis.evidence.filter((item) => BACKING_EVIDENCE_KINDS.includes(item.kind)).map((item) => item.id),
  );
}

/** Trim the storyboard to the maximum length (see fit-duration.ts for what that does and guarantees). */
export function fitStoryboard(p: Prepared, storyboard: Storyboard): FitResult {
  return fitToMaxDuration(storyboard, {
    maxSec: p.config.maxDurationSec,
    language: p.config.language,
    maskEmails: p.config.privacy.maskEmails,
    backingEvidence: backingEvidence(p.analysis),
  });
}
