/** Helpers shared by the LLM providers. */
import type { RunContext } from '../core/context.ts';
import { type ErrorCode, MergeStoryError } from '../core/errors.ts';
import { isPrivateHostname } from '../core/net.ts';
import type { LlmRequest } from '../core/providers.ts';
import { budgetLlmCostUsd } from './prices.ts';

/** Parse a JSON answer. Tolerates a code fence or text around the object. Returns undefined when nothing parses. */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.replace(/^﻿/, '').trim();
  const attempt = (candidate: string): { ok: true; value: unknown } | { ok: false } => {
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {
      return { ok: false };
    }
  };
  const direct = attempt(trimmed);
  if (direct.ok) return direct.value;
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (unfenced !== trimmed) {
    const result = attempt(unfenced);
    if (result.ok) return result.value;
  }
  const first = unfenced.indexOf('{');
  const last = unfenced.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const result = attempt(unfenced.slice(first, last + 1));
    if (result.ok) return result.value;
  }
  return undefined;
}

/**
 * Parse and check an endpoint URL taken from configuration or the environment.
 * Rejects credentials in the URL and plain http to public hosts, so code and keys never travel unencrypted.
 */
export function parseEndpointUrl(value: string, setting: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MergeStoryError('CONFIG_INVALID', `${setting} is not a valid URL.`, {
      hint: 'Use a full URL such as https://api.example.com/v1 or http://localhost:11434/v1.',
    });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new MergeStoryError('CONFIG_INVALID', `${setting} must start with https:// or http://.`);
  }
  if (url.username || url.password) {
    throw new MergeStoryError('CONFIG_INVALID', `${setting} must not contain a user name or password.`, {
      hint: 'Put keys in environment variables such as MERGESTORY_LLM_API_KEY, never in a URL.',
    });
  }
  if (url.protocol === 'http:' && !isPrivateHostname(url.hostname)) {
    throw new MergeStoryError('CONFIG_INVALID', `${setting} uses plain http to a public host.`, {
      hint: 'Use https, or point at a server on this machine or your private network.',
    });
  }
  return url;
}

/** Messages after the system prompt: the original request, then repair turns. Never ends with an assistant turn. */
export function buildMessages(request: LlmRequest): { role: 'user' | 'assistant'; content: string }[] {
  const messages: { role: 'user' | 'assistant'; content: string }[] = [
    { role: 'user', content: request.prompt },
    ...(request.history ?? []),
  ];
  if (messages[messages.length - 1]?.role !== 'user') {
    throw new MergeStoryError('INTERNAL', 'The model history must end with a user turn.', {
      hint: 'Assistant prefill is not supported by current models.',
    });
  }
  return messages;
}

/**
 * Record a call that the provider billed but that produced no usable answer (refused, cut off or
 * empty). `model` is the model that was requested (the answer may name a dated snapshot instead);
 * `local` marks a server on this machine or network. Successful calls are recorded by the caller,
 * so every paid call appears once in the cost report.
 */
export function recordBilledFailure(
  ctx: RunContext,
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  local = false,
): void {
  ctx.cost.record({
    provider,
    kind: 'llm',
    model,
    inputTokens,
    outputTokens,
    costUsd: budgetLlmCostUsd(provider, model, inputTokens, outputTokens, ctx, local),
    estimated: true,
  });
}

/** First part of a message, redacted and on one line, safe to put in an error. */
export function safeSnippet(ctx: RunContext, text: string, max = 300): string {
  return ctx.redactor.redact(text).replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Read a whole response body, but stop with `code` once it is larger than `maxBytes`. A broken or
 * hostile server could otherwise send gigabytes, and all of it would be kept in memory.
 */
export async function readBodyLimited(
  response: Response,
  maxBytes: number,
  code: Extract<ErrorCode, 'LLM_FAILED' | 'TTS_FAILED'>,
  host: string,
): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  // Leaving the loop early cancels the rest of the body.
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > maxBytes) {
      throw new MergeStoryError(
        code,
        `${host} sent an answer larger than ${Math.round(maxBytes / 1_048_576)} MB.`,
        {
          hint: 'Check that the address points at the right server.',
        },
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
