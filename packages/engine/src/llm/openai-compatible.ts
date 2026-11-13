/**
 * OpenAI and OpenAI-compatible provider over plain HTTPS (Chat Completions), so one adapter
 * serves OpenAI, Ollama, OpenRouter, vLLM, LM Studio and Groq.
 *
 * The request asks for a strict JSON schema. Servers differ in what they accept, so a 400 that
 * names an unsupported field makes the adapter adjust that one field and try again (at most once
 * per field). A sampling parameter is never sent: current reasoning models reject them.
 */

import type { Config, SecretName, Secrets } from '../core/config.ts';
import type { RunContext } from '../core/context.ts';
import { estimateTokens } from '../core/cost.ts';
import { abortedError, MergeStoryError, TimedOutError, toMergeStoryError } from '../core/errors.ts';
import { asNumber, isRecord } from '../core/json.ts';
import { isPrivateHostname } from '../core/net.ts';
import type { LlmProvider, LlmRequest, LlmResponse } from '../core/providers.ts';
import { defaultIsRetryable, fetchWithRetry, HttpError } from '../core/retry.ts';
import { budgetLlmCostUsd, llmPriceNote } from './prices.ts';
import {
  buildMessages,
  markMayBeBilled,
  parseEndpointUrl,
  parseJsonLoose,
  readBodyLimited,
  recordBilledFailure,
  safeSnippet,
} from './shared.ts';

export type OpenAiFlavor = 'openai' | 'openai-compatible';

export interface OpenAiProviderOptions {
  id: OpenAiFlavor;
  model: string;
  /** Base URL that ends before "/chat/completions", for example https://api.openai.com/v1. */
  baseUrl: URL;
  keyName: Extract<SecretName, 'OPENAI_API_KEY' | 'MERGESTORY_LLM_API_KEY'>;
  /** Local servers such as Ollama need no key. */
  keyRequired: boolean;
  effort: Config['llm']['effort'];
  timeoutMs: number;
}

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
/** A storyboard answer is a few hundred kilobytes; a much larger one comes from a broken server. */
const MAX_ANSWER_BYTES = 32 * 1_048_576;

interface Dialect {
  jsonMode: 'json_schema' | 'json_object';
  tokenField: 'max_completion_tokens' | 'max_tokens';
  reasoningEffort: boolean;
  /** OpenAI only: ask the service not to store the request. Never adjusted automatically. */
  store: boolean;
  /** OpenAI only: no implicit cache writes, which cost extra on a one-shot prompt. */
  cacheOptions: boolean;
}

function initialDialect(flavor: OpenAiFlavor): Dialect {
  if (flavor === 'openai') {
    return {
      jsonMode: 'json_schema',
      tokenField: 'max_completion_tokens',
      reasoningEffort: true,
      store: true,
      cacheOptions: true,
    };
  }
  // max_tokens is the name every compatible server accepts.
  return {
    jsonMode: 'json_schema',
    tokenField: 'max_tokens',
    reasoningEffort: false,
    store: false,
    cacheOptions: false,
  };
}

function buildBody(
  request: LlmRequest,
  model: string,
  dialect: Dialect,
  effort: Config['llm']['effort'],
): Record<string, unknown> {
  const system =
    dialect.jsonMode === 'json_object'
      ? `${request.system}\n\nReturn one JSON object and nothing else. It must match this JSON Schema exactly:\n${JSON.stringify(request.jsonSchema)}`
      : request.system;
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: 'system', content: system }, ...buildMessages(request)],
    [dialect.tokenField]: request.maxOutputTokens,
    response_format:
      dialect.jsonMode === 'json_schema'
        ? {
            type: 'json_schema',
            json_schema: {
              name: request.schemaName.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'schema',
              strict: true,
              schema: request.jsonSchema,
            },
          }
        : { type: 'json_object' },
  };
  if (dialect.store) body.store = false;
  if (dialect.reasoningEffort) body.reasoning_effort = effort;
  if (dialect.cacheOptions) body.prompt_cache_options = { mode: 'explicit' };
  return body;
}

/** Change one field of the request after a 400 that names it. Returns a short note, or null when nothing applies. */
function adaptDialect(dialect: Dialect, applied: Set<string>, errorText: string): string | null {
  const text = errorText.toLowerCase();
  const once = (key: string, change: () => void, note: string): string | null => {
    if (applied.has(key)) return null;
    applied.add(key);
    change();
    return note;
  };
  if (dialect.jsonMode === 'json_schema' && /response_format|json_schema/.test(text)) {
    return once(
      'json',
      () => {
        dialect.jsonMode = 'json_object';
      },
      'JSON mode with the schema in the prompt',
    );
  }
  if (dialect.cacheOptions && text.includes('prompt_cache_options')) {
    return once(
      'cache',
      () => {
        dialect.cacheOptions = false;
      },
      'without prompt_cache_options',
    );
  }
  if (dialect.reasoningEffort && text.includes('reasoning_effort')) {
    return once(
      'effort',
      () => {
        dialect.reasoningEffort = false;
      },
      'without reasoning_effort',
    );
  }
  if (text.includes(dialect.tokenField)) {
    return once(
      'tokens',
      () => {
        dialect.tokenField = dialect.tokenField === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens';
      },
      'with the other output limit field',
    );
  }
  return null;
}

const NON_RETRYABLE_429 = /insufficient_quota|credit_balance|spend_limit|usage_limit|quota_exceeded|billing/i;

/**
 * A 429 that reports a spending or quota limit will not clear by waiting, so it is not retried.
 * Neither is a timeout: the model may still finish and bill that answer, and the next try would
 * most likely time out as well.
 */
function isRetryable(err: unknown): boolean {
  if (err instanceof TimedOutError) return false;
  if (err instanceof HttpError) {
    if (err.status === 429 && NON_RETRYABLE_429.test(err.bodySnippet)) return false;
    return err.retryable;
  }
  return defaultIsRetryable(err);
}

/** The message inside an error body. The body may be an object, a plain string or cut off. */
function errorMessageOf(snippet: string): string {
  try {
    const parsed: unknown = JSON.parse(snippet);
    if (typeof parsed === 'string') return parsed;
    if (isRecord(parsed)) {
      const error = parsed.error;
      if (typeof error === 'string') return error;
      if (isRecord(error) && typeof error.message === 'string') return error.message;
      if (typeof parsed.message === 'string') return parsed.message;
    }
  } catch {
    // Not JSON, or longer than the stored snippet: use the raw text.
  }
  return snippet;
}

function missingKeyError(flavor: OpenAiFlavor, keyName: string): MergeStoryError {
  return new MergeStoryError('CONFIG_INVALID', `No API key was found for the ${flavor} provider.`, {
    hint: `Set ${keyName}, or choose another provider with MERGESTORY_LLM_PROVIDER.`,
  });
}

function mapFailure(
  err: unknown,
  ctx: RunContext,
  options: OpenAiProviderOptions,
  host: string,
): MergeStoryError {
  if (ctx.signal.aborted) return abortedError(err);
  if (err instanceof HttpError) {
    const detail = safeSnippet(ctx, errorMessageOf(err.bodySnippet));
    const status = err.status;
    const details = { status };
    if (status === 401) {
      return new MergeStoryError('CONFIG_INVALID', `${host} rejected the API key.`, {
        cause: err,
        hint: `Set ${options.keyName} to a valid key.`,
        details,
      });
    }
    if (status === 429) {
      if (NON_RETRYABLE_429.test(err.bodySnippet)) {
        return new MergeStoryError('LLM_FAILED', `${host} reports a quota or spending limit: ${detail}`, {
          cause: err,
          hint: 'Check the plan, billing and spend limits of this key.',
          details,
        });
      }
      return new MergeStoryError('RATE_LIMITED', `${host} is rate limiting this key.`, {
        cause: err,
        retryable: true,
        hint: 'Wait a minute and run again, or pick another model.',
        details,
      });
    }
    let hint = 'Check llm.model and llm.baseUrl.';
    if (status === 402) hint = 'The account is out of credit. Add credit or pick another provider.';
    else if (status === 403) hint = 'The key has no access to this model or region.';
    else if (status === 404)
      hint = 'Check that llm.baseUrl ends with /v1 and that llm.model exists on the server.';
    else if (status === 413) hint = 'The request is too large. Lower llm.maxInputTokens.';
    else if (status === 400 && /context|too long|maximum/i.test(err.bodySnippet)) {
      hint =
        'The request may be longer than the model context. Lower llm.maxInputTokens or use privacy.llmContext "minimal".';
    }
    return new MergeStoryError('LLM_FAILED', `${host} returned an error (HTTP ${status}): ${detail}`, {
      cause: err,
      hint,
      retryable: err.retryable,
      details,
    });
  }
  if (err instanceof MergeStoryError) {
    if (err.code !== 'INTERNAL') return err;
    const timedOut = err instanceof TimedOutError;
    return new MergeStoryError(
      'LLM_FAILED',
      timedOut
        ? `The model did not answer within ${Math.round(options.timeoutMs / 1000)} seconds.`
        : `Could not reach ${host}: ${safeSnippet(ctx, err.message, 160)}`,
      {
        cause: err,
        retryable: true,
        hint: timedOut
          ? 'Raise llm.timeoutMs or shorten the change.'
          : 'Check your network connection and llm.baseUrl. A local server must be running.',
        // A timed-out request reached the server, which may still finish and bill it; a failed connection did not.
        ...(timedOut ? { details: { mayBeBilled: true } } : {}),
      },
    );
  }
  return toMergeStoryError(err, 'LLM_FAILED');
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : '')).join('');
}

function readCompletion(
  body: unknown,
  request: LlmRequest,
  ctx: RunContext,
  options: OpenAiProviderOptions,
  host: string,
): LlmResponse {
  const local = isPrivateHostname(new URL(`http://${host}`).hostname);
  const parsed = isRecord(body) ? body : {};
  const choices = Array.isArray(parsed.choices) ? (parsed.choices as unknown[]) : [];
  const first = isRecord(choices[0]) ? choices[0] : null;
  if (!first) {
    // Some gateways report a failure inside an HTTP 200 answer.
    const failure =
      isRecord(parsed.error) || typeof parsed.error === 'string'
        ? errorMessageOf(JSON.stringify(parsed.error))
        : '';
    throw new MergeStoryError(
      'LLM_FAILED',
      failure ? `${host} returned an error: ${safeSnippet(ctx, failure)}` : `${host} returned no answer.`,
      // An error reported inside the answer is not billed; an answer with nothing in it may be.
      { hint: 'Check llm.model and llm.baseUrl.', ...(failure ? {} : { details: { mayBeBilled: true } }) },
    );
  }
  const message = isRecord(first.message) ? first.message : {};
  const finish = typeof first.finish_reason === 'string' ? first.finish_reason : null;
  const text = contentText(message.content);
  const usage = isRecord(parsed.usage) ? parsed.usage : null;
  const promptDetails = usage && isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : null;
  const inputTokens =
    asNumber(usage?.prompt_tokens) ??
    asNumber(usage?.input_tokens) ??
    estimateTokens(
      request.system + request.prompt + (request.history ?? []).map((turn) => turn.content).join(''),
    );
  const outputTokens =
    asNumber(usage?.completion_tokens) ?? asNumber(usage?.output_tokens) ?? estimateTokens(text);
  const model = typeof parsed.model === 'string' && parsed.model ? parsed.model : options.model;

  if (typeof message.refusal === 'string' && message.refusal.trim()) {
    recordBilledFailure(ctx, options.id, options.model, inputTokens, outputTokens, local);
    throw new MergeStoryError(
      'LLM_REFUSED',
      `The model declined to write the storyboard: ${safeSnippet(ctx, message.refusal, 200)}`,
      {
        hint: 'Try another model, or set llm.provider to "none" for the offline storyboard.',
      },
    );
  }
  if (finish === 'content_filter') {
    recordBilledFailure(ctx, options.id, options.model, inputTokens, outputTokens, local);
    throw new MergeStoryError('LLM_REFUSED', `${host} blocked the answer with its content filter.`, {
      hint: 'Try another model, or set llm.provider to "none" for the offline storyboard.',
    });
  }
  if (finish === 'length') {
    recordBilledFailure(ctx, options.id, options.model, inputTokens, outputTokens, local);
    throw new MergeStoryError(
      'LLM_FAILED',
      `The model's answer was cut off after ${outputTokens} output tokens.`,
      {
        hint: 'Raise llm.maxOutputTokens (reasoning models count thinking tokens too), lower llm.effort, or lower the target length.',
      },
    );
  }
  if (!text.trim()) {
    recordBilledFailure(ctx, options.id, options.model, inputTokens, outputTokens, local);
    throw new MergeStoryError('LLM_FAILED', 'The model returned no text.', {
      hint: 'Run again. If it keeps happening, try another model.',
      retryable: true,
    });
  }
  return {
    text,
    json: parseJsonLoose(text),
    usage: {
      inputTokens,
      outputTokens,
      cacheReadTokens: asNumber(promptDetails?.cached_tokens) ?? undefined,
      cacheWriteTokens: asNumber(promptDetails?.cache_write_tokens) ?? undefined,
    },
    model,
    stopReason: finish,
  };
}

/** Provider for the Chat Completions API of OpenAI or any server that speaks it. */
export function createOpenAiProvider(options: OpenAiProviderOptions): LlmProvider {
  const baseUrlText = options.baseUrl.href.replace(/\/+$/, '');
  const host = options.baseUrl.host;
  // A server on this machine or a private network (for example Ollama) bills nothing.
  const local = isPrivateHostname(options.baseUrl.hostname);

  return {
    id: options.id,
    model: options.model,
    endpointHost: host,

    async generateJson(request: LlmRequest, ctx: RunContext): Promise<LlmResponse> {
      const apiKey = ctx.secrets.get(options.keyName);
      if (!apiKey && options.keyRequired) throw missingKeyError(options.id, options.keyName);
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;

      const dialect = initialDialect(options.id);
      const applied = new Set<string>();
      for (;;) {
        const body = buildBody(request, options.model, dialect, options.effort);
        ctx.logger.debug('Chat Completions request', {
          host,
          model: options.model,
          jsonMode: dialect.jsonMode,
          turns: (body.messages as unknown[]).length,
          promptChars: request.system.length + request.prompt.length,
        });
        let response: Response;
        try {
          response = await fetchWithRetry(
            `${baseUrlText}/chat/completions`,
            { method: 'POST', headers, body: JSON.stringify(body) },
            {
              timeoutMs: options.timeoutMs,
              attempts: 3,
              minDelayMs: 1000,
              signal: ctx.signal,
              isRetryable,
              onRetry: ({ attempt, delayMs }) =>
                ctx.logger.warn('Retrying the model request', { attempt, waitMs: Math.round(delayMs) }),
            },
          );
        } catch (err) {
          if (err instanceof HttpError && (err.status === 400 || err.status === 422)) {
            const note = adaptDialect(dialect, applied, err.bodySnippet);
            if (note) {
              ctx.logger.info(`The server rejected part of the request. Trying again: ${note}.`);
              continue;
            }
          }
          throw mapFailure(err, ctx, options, host);
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(
            new TextDecoder().decode(await readBodyLimited(response, MAX_ANSWER_BYTES, 'LLM_FAILED', host)),
          );
        } catch (err) {
          // A cancel while the body is read keeps its code and is not a billing doubt.
          if (ctx.signal.aborted) throw abortedError(err);
          // The server answered, so it may bill the call although its answer cannot be read.
          throw markMayBeBilled(
            err instanceof MergeStoryError
              ? err
              : new MergeStoryError('LLM_FAILED', `${host} returned an answer that is not JSON.`, {
                  cause: err,
                  hint: 'Check that llm.baseUrl points at an OpenAI-compatible /v1 endpoint.',
                }),
          );
        }
        return readCompletion(parsed, request, ctx, options, host);
      }
    },

    estimateCostUsd(inputTokens: number, outputTokens: number, ctx: RunContext): number | null {
      return budgetLlmCostUsd(options.id, options.model, inputTokens, outputTokens, ctx, local);
    },

    priceNote(ctx: RunContext) {
      return llmPriceNote(options.id, options.model, ctx, local);
    },
  };
}

/**
 * The OpenAI key goes only to OpenAI, so the openai provider accepts no base URL except the
 * OpenAI API. Returns the error for any other URL, or null when the setting is fine.
 */
export function openAiBaseUrlError(baseUrl: string | null | undefined): MergeStoryError | null {
  if (!baseUrl || baseUrl.trim().replace(/\/+$/, '') === OPENAI_BASE_URL) return null;
  return new MergeStoryError('CONFIG_INVALID', 'The openai provider only talks to the OpenAI API.', {
    hint: 'To use another server, set llm.provider to "openai-compatible" and put its key in MERGESTORY_LLM_API_KEY. Or remove llm.baseUrl (MERGESTORY_LLM_BASE_URL) to use OpenAI.',
  });
}

/** Validate the settings for the "openai" or "openai-compatible" provider and build it. */
export function createOpenAiFromConfig(
  flavor: OpenAiFlavor,
  config: Config,
  secrets: Secrets,
  model: string,
): LlmProvider {
  const keyName = flavor === 'openai' ? 'OPENAI_API_KEY' : 'MERGESTORY_LLM_API_KEY';
  if (flavor === 'openai' && !secrets.has(keyName)) throw missingKeyError(flavor, keyName);
  let baseUrlText = config.llm.baseUrl;
  if (flavor === 'openai') {
    const error = openAiBaseUrlError(baseUrlText);
    if (error) throw error;
  }
  if (flavor === 'openai-compatible' && !baseUrlText) {
    throw new MergeStoryError('CONFIG_INVALID', 'The openai-compatible provider needs a base URL.', {
      hint: 'Set llm.baseUrl or MERGESTORY_LLM_BASE_URL, for example http://localhost:11434/v1 for Ollama.',
    });
  }
  baseUrlText ??= OPENAI_BASE_URL;
  return createOpenAiProvider({
    id: flavor,
    model,
    baseUrl: parseEndpointUrl(baseUrlText, 'llm.baseUrl'),
    keyName,
    keyRequired: flavor === 'openai',
    effort: config.llm.effort,
    timeoutMs: config.llm.timeoutMs,
  });
}
