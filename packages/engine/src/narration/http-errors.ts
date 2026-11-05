/** Turning failures of a speech web service into short errors with a next step. */
import type { RunContext } from '../core/context.ts';
import { MergeStoryError, toMergeStoryError } from '../core/errors.ts';
import { HttpError } from '../core/retry.ts';

/** The human-readable message inside a JSON error body, or an empty string. Never the raw body. */
export function apiErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; detail?: unknown; message?: unknown };
    const candidates = [parsed.error, parsed.detail, parsed.message];
    for (const candidate of candidates) {
      if (typeof candidate === 'string') return candidate.slice(0, 200);
      if (candidate && typeof candidate === 'object') {
        const message = (candidate as { message?: unknown }).message;
        if (typeof message === 'string') return message.slice(0, 200);
      }
    }
  } catch {
    // not JSON
  }
  return '';
}

export interface SpeechErrorContext {
  /** Display name, e.g. "OpenAI". */
  service: string;
  /** Environment variable that holds the key, e.g. "OPENAI_API_KEY". */
  keyName: string;
  ctx: RunContext;
}

/** Map any failure of a speech request to a MergeStoryError (TTS_FAILED unless it is a cancel or a budget stop). */
export function speechRequestError(err: unknown, info: SpeechErrorContext): MergeStoryError {
  const { service, keyName, ctx } = info;
  if (ctx.signal.aborted) return toMergeStoryError(ctx.signal.reason ?? err);
  if (err instanceof MergeStoryError && err.code !== 'INTERNAL') return err;
  if (err instanceof HttpError) {
    const detail = ctx.redactor.redact(apiErrorMessage(err.bodySnippet));
    const suffix = detail ? ` ${detail}` : '';
    const details = { status: err.status };
    if (err.status === 401 || err.status === 403) {
      return new MergeStoryError(
        'TTS_FAILED',
        `${service} rejected the API key (HTTP ${err.status}).${suffix}`,
        {
          hint: `Check ${keyName}, and that the key may use speech synthesis.`,
          cause: err,
          details,
        },
      );
    }
    if (err.status === 429) {
      return new MergeStoryError(
        'TTS_FAILED',
        `${service} is rate limiting speech requests or the account is out of credit.${suffix}`,
        {
          hint: 'Wait and run again (finished lines are cached), check the plan and billing, or use a local voice (--tts kokoro).',
          cause: err,
          details,
        },
      );
    }
    if (err.status === 404) {
      return new MergeStoryError(
        'TTS_FAILED',
        `${service} could not find the speech model or voice.${suffix}`,
        {
          hint: 'Check tts.model and tts.voice in the config. The provider may have retired the model.',
          cause: err,
          details,
        },
      );
    }
    if (err.status === 400 || err.status === 422) {
      return new MergeStoryError(
        'TTS_FAILED',
        `${service} rejected the speech request (HTTP ${err.status}).${suffix}`,
        {
          hint: 'Check tts.model, tts.voice and tts.speed in the config.',
          cause: err,
          details,
        },
      );
    }
    return new MergeStoryError(
      'TTS_FAILED',
      `${service} speech request failed (HTTP ${err.status}).${suffix}`,
      {
        hint: 'Run again later (finished lines are cached) or choose another speech provider with --tts.',
        cause: err,
        details,
      },
    );
  }
  const reason = err instanceof Error ? err.message : String(err);
  return new MergeStoryError(
    'TTS_FAILED',
    `${service} speech request failed: ${ctx.redactor.redact(reason)}`,
    {
      hint: 'Check the network connection, then run again (finished lines are cached).',
      cause: err,
    },
  );
}
