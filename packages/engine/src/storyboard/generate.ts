/**
 * Asking a model for a storyboard. The answer is never trusted: it goes through the grounding
 * validator, and problems are sent back for repair while the attempts and the budget allow.
 * Nothing leaves the machine before the budget check, and a repeated request is answered from
 * the cache at no cost.
 */
import type { EvidencePack } from '../analyzer/index.ts';
import type { Config } from '../core/config.ts';
import type { RunContext } from '../core/context.ts';
import { estimateTokens } from '../core/cost.ts';
import { isMergeStoryError, MergeStoryError } from '../core/errors.ts';
import { hashKey } from '../core/ids.ts';
import { isLoopbackHost } from '../core/net.ts';
import type { LlmProvider, LlmRequest, LlmResponse } from '../core/providers.ts';
import { storyboardJsonSchemaForLlm } from '../core/storyboard-schema.ts';
import type { EgressRecord } from '../core/types.ts';
import { buildSystemPrompt, buildUserPrompt } from './prompts.ts';
import type {
  GenerateStoryboardInput,
  GenerateStoryboardOutput,
  ValidationIssue,
  ValidationResult,
} from './types.ts';
import { failedResult, validateStoryboard } from './validate.ts';

/**
 * What one model call sends, or null when the model runs on this machine. The real call and the
 * dry-run plan both take it from here, so they cannot disagree about what leaves the machine.
 */
export function modelEgress(
  config: Pick<Config, 'privacy'>,
  host: string,
  bytes: number,
): EgressRecord | null {
  if (isLoopbackHost(host)) return null;
  return {
    destination: host,
    purpose: 'storyboard generation',
    bytes,
    contains:
      config.privacy.llmContext === 'minimal' ? ['pr-metadata'] : ['diff', 'code-context', 'pr-metadata'],
  };
}

const MAX_LISTED_ERRORS = 25;
/** The previous answer is sent back for repair, cut to this length so one bad answer cannot cost a lot. */
const MAX_ECHOED_ANSWER_CHARS = 60_000;

/** Estimated cost of generateStoryboard before it runs (first attempt only). */
export function estimateStoryboardCost(
  provider: LlmProvider,
  pack: EvidencePack,
  config: Config,
  ctx: RunContext,
): { inputTokens: number; outputTokens: number; costUsd: number | null } {
  const system = buildSystemPrompt(config);
  const prompt = buildUserPrompt(pack, config.targetDurationSec ?? config.maxDurationSec, config);
  const inputTokens = estimateTokens(system + prompt);
  // The answer may be as long as the limit, so the estimate is an upper bound.
  const outputTokens = config.llm.maxOutputTokens;
  return { inputTokens, outputTokens, costUsd: provider.estimateCostUsd(inputTokens, outputTokens, ctx) };
}

function historyText(request: LlmRequest): string {
  return (request.history ?? []).map((turn) => turn.content).join('');
}

async function readCache(ctx: RunContext, key: string): Promise<LlmResponse | null> {
  const raw = await ctx.cache.get('llm', key).catch(() => null);
  if (!raw) return null;
  try {
    const entry = JSON.parse(raw.toString('utf8')) as Partial<LlmResponse>;
    if (typeof entry.text !== 'string' || typeof entry.model !== 'string' || !entry.usage) return null;
    return {
      text: entry.text,
      json: entry.json,
      model: entry.model,
      usage: entry.usage,
      stopReason: entry.stopReason ?? null,
    };
  } catch {
    return null;
  }
}

function invalidJson(): ValidationResult {
  return failedResult([
    {
      path: 'storyboard',
      code: 'invalid-json',
      message: 'the answer is not a JSON object; return one JSON object that matches the schema',
    },
  ]);
}

/** The numbered list sent back to the model. Short messages: they name the field and say what to do. */
function repairMessage(errors: readonly ValidationIssue[]): string {
  const shown = errors.slice(0, MAX_LISTED_ERRORS);
  const list = shown.map((error, index) => `${index + 1}. ${error.path}: ${error.message}`).join('\n');
  const more = errors.length > shown.length ? `\n...and ${errors.length - shown.length} more.` : '';
  return `The storyboard has problems that block rendering. Fix every item below. Keep what is already correct. Return the full corrected storyboard as one JSON object (all scenes, not only the changed ones).\n\n${list}${more}`;
}

interface Attempt {
  response: LlmResponse;
  cached: boolean;
}

async function ask(
  request: LlmRequest,
  provider: LlmProvider,
  ctx: RunContext,
  first: boolean,
): Promise<Attempt> {
  const key = hashKey({
    provider: provider.id,
    model: provider.model,
    system: request.system,
    prompt: request.prompt,
    schema: request.jsonSchema,
    history: request.history,
  });

  const hit = await readCache(ctx, key);
  if (hit) {
    ctx.cost.record({
      provider: provider.id,
      kind: 'llm',
      model: hit.model,
      inputTokens: hit.usage.inputTokens,
      outputTokens: hit.usage.outputTokens,
      costUsd: 0,
      estimated: false,
      cached: true,
    });
    ctx.logger.debug('Storyboard answer taken from the cache', { model: hit.model });
    return { response: hit, cached: true };
  }

  if (ctx.dryRun) {
    throw new MergeStoryError('INTERNAL', 'The model was about to be called during a dry run.', {
      hint: 'A dry run makes no paid calls. This is a bug in the caller.',
    });
  }

  // Nothing leaves the machine, and nothing is spent, before this check passes.
  const estimatedIn = estimateTokens(request.system + request.prompt + historyText(request));
  const estimatedCost = provider.estimateCostUsd(estimatedIn, request.maxOutputTokens, ctx);
  ctx.cost.assertWithinBudget(
    estimatedCost ?? 0,
    first ? 'Writing the storyboard' : 'Repairing the storyboard',
  );

  const sent = modelEgress(
    ctx.config,
    provider.endpointHost,
    Buffer.byteLength(request.system) +
      Buffer.byteLength(request.prompt) +
      Buffer.byteLength(historyText(request)) +
      Buffer.byteLength(JSON.stringify(request.jsonSchema)),
  );
  if (sent) ctx.egress.record(sent.destination, sent.purpose, sent.bytes, sent.contains);

  const response = await provider.generateJson(request, ctx);

  const cost = provider.estimateCostUsd(response.usage.inputTokens, response.usage.outputTokens, ctx);
  ctx.cost.record({
    provider: provider.id,
    kind: 'llm',
    model: response.model || provider.model,
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    costUsd: cost ?? 0,
    estimated: true,
    cached: false,
  });

  // A cache that cannot be written must never fail the run.
  await ctx.cache.put('llm', key, JSON.stringify(response)).catch(() => undefined);
  return { response, cached: false };
}

/** Ask the LLM for a storyboard, validate it, and send errors back for repair when needed. */
export async function generateStoryboard(
  input: GenerateStoryboardInput,
  ctx: RunContext,
): Promise<GenerateStoryboardOutput> {
  const { provider, pack, deps, targetSec } = input;
  const config = ctx.config;
  const system = buildSystemPrompt(config);
  const prompt = buildUserPrompt(pack, targetSec, config);
  const jsonSchema = storyboardJsonSchemaForLlm();
  const maxAttempts = 1 + config.llm.repairAttempts;
  const history: { role: 'user' | 'assistant'; content: string }[] = [];

  let attempts = 0;
  let allCached = true;
  let lastErrors: ValidationIssue[] = [];
  let stoppedBy: string | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    ctx.signal.throwIfAborted();
    const request: LlmRequest = {
      system,
      prompt,
      schemaName: 'storyboard',
      jsonSchema,
      maxOutputTokens: config.llm.maxOutputTokens,
      ...(history.length > 0 ? { history: [...history] } : {}),
    };
    ctx.progress({
      stage: 'storyboard',
      status: 'progress',
      message:
        attempt === 1
          ? 'Asking the model for a storyboard'
          : `Asking the model to fix the storyboard (attempt ${attempt} of ${maxAttempts})`,
    });

    let answer: Attempt;
    try {
      answer = await ask(request, provider, ctx, attempt === 1);
    } catch (err) {
      // Running out of budget while repairing is not a failure of the run: the offline storyboard takes over.
      if (attempt > 1 && isMergeStoryError(err) && err.code === 'BUDGET_EXCEEDED') {
        stoppedBy = 'the budget did not allow another attempt';
        break;
      }
      throw err;
    }
    attempts = attempt;
    allCached &&= answer.cached;

    const validation =
      answer.response.json === undefined
        ? invalidJson()
        : await validateStoryboard(answer.response.json, deps);
    if (validation.storyboard) {
      return { storyboard: validation.storyboard, validation, attempts, cached: allCached };
    }
    lastErrors = validation.errors;
    ctx.logger.debug('Storyboard failed validation', { attempt, errors: validation.errors.length });
    if (attempt === maxAttempts) break;
    history.push(
      { role: 'assistant', content: answer.response.text.slice(0, MAX_ECHOED_ANSWER_CHARS) },
      { role: 'user', content: repairMessage(validation.errors) },
    );
  }

  const count = lastErrors.length;
  const shown = lastErrors
    .slice(0, 3)
    .map((error) => `${error.path}: ${error.message}`)
    .join('; ');
  throw new MergeStoryError(
    'STORYBOARD_INVALID',
    `The model's storyboard still has ${count} problem${count === 1 ? '' : 's'} after ${attempts} attempt${attempts === 1 ? '' : 's'}${stoppedBy ? ` (${stoppedBy})` : ''}: ${shown}${count > 3 ? `; and ${count - 3} more` : ''}.`,
    {
      hint: 'The offline storyboard can be used instead. For a better result, pick a stronger model with llm.model or write the storyboard yourself and pass it with --storyboard.',
      details: { errors: lastErrors.slice(0, MAX_LISTED_ERRORS) },
    },
  );
}
