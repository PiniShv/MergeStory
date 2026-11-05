/**
 * Anthropic provider, built on the official SDK (loaded on first use so the other providers
 * and the offline path never pay for it).
 *
 * Request rules for current models: no temperature, top_p or top_k, no assistant prefill and no
 * thinking parameter. The JSON schema goes in output_config.format.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { Config, Secrets } from '../core/config.ts';
import type { RunContext } from '../core/context.ts';
import { abortedError, MergeStoryError, toMergeStoryError } from '../core/errors.ts';
import { isLoopbackHost } from '../core/net.ts';
import type { LlmProvider, LlmRequest, LlmResponse } from '../core/providers.ts';
import { parseRetryAfter, retry } from '../core/retry.ts';
import { budgetLlmCostUsd } from './prices.ts';
import {
  buildMessages,
  parseEndpointUrl,
  parseJsonLoose,
  recordBilledFailure,
  safeSnippet,
} from './shared.ts';

type AnthropicModule = typeof import('@anthropic-ai/sdk');

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
/** Above this many output tokens the answer is streamed, so a long request never sits idle on the wire. */
const STREAM_ABOVE_OUTPUT_TOKENS = 16_000;
const MAX_RETRIES = 3;

let sdkPromise: Promise<AnthropicModule> | null = null;

function loadSdk(): Promise<AnthropicModule> {
  sdkPromise ??= import('@anthropic-ai/sdk').catch((err: unknown) => {
    sdkPromise = null;
    throw new MergeStoryError('INTERNAL', 'The Anthropic SDK could not be loaded.', {
      cause: err,
      hint: 'Reinstall the package dependencies (npm install).',
    });
  });
  return sdkPromise;
}

function isInstance(value: unknown, type: unknown): boolean {
  return typeof type === 'function' && value instanceof (type as new (...args: never[]) => unknown);
}

/**
 * Rate limits, server errors and failed connections are tried again. A timeout is not: the model
 * may still finish and bill that answer, and the next try would most likely time out as well.
 */
function isRetryableSdkError(err: unknown, sdk: AnthropicModule): boolean {
  if (isInstance(err, sdk.APIConnectionError)) return !isInstance(err, sdk.APIConnectionTimeoutError);
  if (!isInstance(err, sdk.APIError)) return false;
  const status = (err as { status?: number }).status;
  return status !== undefined && (status === 429 || status >= 500);
}

function missingKeyError(): MergeStoryError {
  return new MergeStoryError('CONFIG_INVALID', 'No Anthropic API key was found.', {
    hint: 'Set ANTHROPIC_API_KEY, or choose another provider with MERGESTORY_LLM_PROVIDER.',
  });
}

/** Map an SDK failure to a MergeStoryError with an actionable hint. */
function mapSdkError(
  err: unknown,
  sdk: AnthropicModule,
  ctx: RunContext,
  host: string,
  timeoutMs: number,
): MergeStoryError {
  if (err instanceof MergeStoryError) return err;
  if (ctx.signal.aborted) return abortedError(err);
  if (isInstance(err, sdk.AuthenticationError)) {
    return new MergeStoryError('CONFIG_INVALID', 'Anthropic rejected the API key.', {
      cause: err,
      hint: 'Set ANTHROPIC_API_KEY to a valid key.',
    });
  }
  if (isInstance(err, sdk.RateLimitError)) {
    return new MergeStoryError('RATE_LIMITED', 'Anthropic is rate limiting this key.', {
      cause: err,
      retryable: true,
      hint: 'Wait a minute and run again, or pick another model.',
    });
  }
  if (isInstance(err, sdk.APIConnectionTimeoutError)) {
    return new MergeStoryError(
      'LLM_FAILED',
      `The model did not answer within ${Math.round(timeoutMs / 1000)} seconds.`,
      {
        cause: err,
        retryable: true,
        hint: 'Raise llm.timeoutMs, lower llm.effort, or shorten the change.',
      },
    );
  }
  if (isInstance(err, sdk.APIConnectionError)) {
    return new MergeStoryError('LLM_FAILED', `Could not reach ${host}.`, {
      cause: err,
      retryable: true,
      hint: 'Check your network connection and ANTHROPIC_BASE_URL.',
    });
  }
  if (isInstance(err, sdk.APIError)) {
    const api = err as { status?: number; message?: string };
    const status = typeof api.status === 'number' ? api.status : undefined;
    const detail = safeSnippet(ctx, api.message ?? '');
    let hint = 'Check llm.model and the Anthropic status page.';
    if (status === 400) hint = 'Check llm.model and llm.effort. The model must support structured outputs.';
    else if (status === 403) hint = 'The API key has no access to this model.';
    else if (status === 404) hint = 'The model was not found. Check llm.model.';
    else if (status === 413) hint = 'The request is too large. Lower llm.maxInputTokens.';
    return new MergeStoryError(
      'LLM_FAILED',
      `Anthropic returned an error${status ? ` (HTTP ${status})` : ''}: ${detail}`,
      {
        cause: err,
        hint,
        retryable: status !== undefined && status >= 500,
        details: status ? { status } : undefined,
      },
    );
  }
  return toMergeStoryError(err, 'LLM_FAILED');
}

/** Provider for the Anthropic Messages API. Throws CONFIG_INVALID when no key or a bad base URL is configured. */
export function createAnthropicProvider(
  config: Config,
  secrets: Secrets,
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): LlmProvider {
  if (!secrets.has('ANTHROPIC_API_KEY')) throw missingKeyError();
  // The SDK would read ANTHROPIC_BASE_URL itself; resolving it here keeps the egress report truthful.
  const baseUrl = parseEndpointUrl(env.ANTHROPIC_BASE_URL?.trim() || DEFAULT_BASE_URL, 'ANTHROPIC_BASE_URL');
  const baseUrlText = baseUrl.href.replace(/\/+$/, '');
  const { effort, timeoutMs } = config.llm;
  // A proxy on this machine (ANTHROPIC_BASE_URL) bills nothing itself.
  const local = isLoopbackHost(baseUrl.host);

  return {
    id: 'anthropic',
    model,
    endpointHost: baseUrl.host,

    async generateJson(request: LlmRequest, ctx: RunContext): Promise<LlmResponse> {
      const apiKey = ctx.secrets.get('ANTHROPIC_API_KEY');
      if (!apiKey) throw missingKeyError();
      const sdk = await loadSdk();
      const Anthropic = sdk.default;
      const client = new Anthropic({
        apiKey,
        baseURL: baseUrlText,
        // Retries happen below, so that a timed-out request is never sent again.
        maxRetries: 0,
        timeout: timeoutMs,
      });

      const format = { type: 'json_schema' as const, schema: request.jsonSchema };
      const messages = buildMessages(request);
      ctx.logger.debug('Anthropic request', {
        model,
        maxOutputTokens: request.maxOutputTokens,
        turns: messages.length,
        promptChars: request.system.length + request.prompt.length,
      });

      let message: Anthropic.Message;
      // Some models do not take an effort setting. If the API says so, the same request is sent once without it.
      for (let withEffort = true; ; withEffort = false) {
        const params = {
          model,
          max_tokens: request.maxOutputTokens,
          system: request.system,
          messages,
          output_config: withEffort ? { format, effort } : { format },
        };
        try {
          message = await retry(
            () =>
              request.maxOutputTokens > STREAM_ABOVE_OUTPUT_TOKENS
                ? client.messages.stream(params, { signal: ctx.signal }).finalMessage()
                : client.messages.create(params, { signal: ctx.signal }),
            {
              attempts: MAX_RETRIES + 1,
              minDelayMs: 1000,
              signal: ctx.signal,
              isRetryable: (err) => isRetryableSdkError(err, sdk),
              delayFor: (err) =>
                parseRetryAfter((err as { headers?: Headers }).headers?.get?.('retry-after')),
              onRetry: ({ attempt, delayMs }) =>
                ctx.logger.warn('Retrying the model request', { attempt, waitMs: Math.round(delayMs) }),
            },
          );
          break;
        } catch (err) {
          const api = err as { status?: number; message?: string };
          if (
            withEffort &&
            isInstance(err, sdk.APIError) &&
            api.status === 400 &&
            /effort/i.test(api.message ?? '')
          ) {
            ctx.logger.info('The model does not accept an effort setting. Trying again without it.');
            continue;
          }
          throw mapSdkError(err, sdk, ctx, baseUrl.host, timeoutMs);
        }
      }

      const outputTokens = message.usage.output_tokens;
      const billedInput =
        message.usage.input_tokens +
        (message.usage.cache_read_input_tokens ?? 0) +
        (message.usage.cache_creation_input_tokens ?? 0);

      if (message.stop_reason === 'refusal') {
        recordBilledFailure(ctx, 'anthropic', model, billedInput, outputTokens, local);
        const category = message.stop_details?.category ?? null;
        throw new MergeStoryError(
          'LLM_REFUSED',
          `The model declined to write the storyboard${category ? ` (category: ${category})` : ''}.`,
          {
            hint: 'Try another model, or set llm.provider to "none" for the offline storyboard.',
            details: category ? { category } : undefined,
          },
        );
      }
      if (message.stop_reason === 'max_tokens') {
        recordBilledFailure(ctx, 'anthropic', model, billedInput, outputTokens, local);
        throw new MergeStoryError(
          'LLM_FAILED',
          `The model's answer was cut off after ${outputTokens} output tokens.`,
          {
            hint: 'Raise llm.maxOutputTokens (for example to 16000) or lower the target length.',
          },
        );
      }
      if (message.stop_reason === 'model_context_window_exceeded') {
        recordBilledFailure(ctx, 'anthropic', model, billedInput, outputTokens, local);
        throw new MergeStoryError('LLM_FAILED', 'The request does not fit in the model context window.', {
          hint: 'Lower llm.maxInputTokens or use privacy.llmContext "minimal".',
        });
      }

      const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
      if (!text.trim()) {
        recordBilledFailure(ctx, 'anthropic', model, billedInput, outputTokens, local);
        throw new MergeStoryError('LLM_FAILED', 'The model returned no text.', {
          hint: 'Run again. If it keeps happening, try another model.',
          retryable: true,
        });
      }

      return {
        text,
        json: parseJsonLoose(text),
        // inputTokens counts every input token, cached or not (as the OpenAI adapter reports it);
        // the cache fields are the part of it that was read from or written to the cache.
        usage: {
          inputTokens: billedInput,
          outputTokens,
          cacheReadTokens: message.usage.cache_read_input_tokens ?? undefined,
          cacheWriteTokens: message.usage.cache_creation_input_tokens ?? undefined,
        },
        model: message.model,
        stopReason: message.stop_reason,
      };
    },

    estimateCostUsd(inputTokens: number, outputTokens: number, ctx: RunContext): number | null {
      return budgetLlmCostUsd('anthropic', model, inputTokens, outputTokens, ctx, local);
    },
  };
}
