/**
 * The speech providers that call a web service (paid, remote): one request for each piece of the
 * text, raw 24 kHz PCM back. Narration text is the only thing sent. The budget is checked before
 * the first request, and cost and data egress are recorded for every one. A provider gives the
 * spec of its service (address, headers, body, voice rule and notices); this runs the rest.
 */
import type { SecretName } from '../core/config.ts';
import type { RunContext } from '../core/context.ts';
import { MergeStoryError } from '../core/errors.ts';
import type { TtsProvider, TtsRequest, TtsResult } from '../core/providers.ts';
import { fetchWithRetry, type RetryOptions } from '../core/retry.ts';
import type { EgressRecord } from '../core/types.ts';
import { readBodyLimited } from '../llm/shared.ts';
import { splitForSynthesis } from './chunking.ts';
import { joinPcmS16le } from './convert.ts';
import { speechRequestError } from './http-errors.ts';
import { ttsCostUsd } from './pricing.ts';

const PCM_RATE = 24_000;
/** One request carries a few thousand characters: well under 64 MB of audio, even spoken slowly. */
const MAX_AUDIO_BYTES = 64 * 1_048_576;

export interface RemoteSpeechOptions {
  retry?: Pick<RetryOptions, 'attempts' | 'minDelayMs' | 'maxDelayMs'>;
}

/** One request to the service. */
interface SpeechCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface RemoteSpeechSpec {
  /** Provider id, and the name of its prices: "openai" or "elevenlabs". */
  id: string;
  /** How messages name the service, for example "OpenAI". */
  service: string;
  /** Host that receives the narration text. */
  host: string;
  /** Environment variable that holds the key. */
  keyName: SecretName;
  defaultModel: string;
  /** The voice used when none is configured, for the model in use. */
  defaultVoice(model: string): string;
  /** The error for a voice name that the service, or its address, cannot take. */
  voiceProblem(voice: string): MergeStoryError | null;
  /** The most characters that one request carries. */
  maxChars: number;
  /** Say what a person should know before the first request: for example a retired model or an ignored setting. */
  notices?(input: { ctx: RunContext; model: string; request: TtsRequest }): void;
  /** The request for one piece of the text. */
  call(input: { key: string; model: string; voice: string; piece: string; request: TtsRequest }): SpeechCall;
}

function keyMissing(keyName: SecretName): MergeStoryError {
  return new MergeStoryError('CONFIG_INVALID', `${keyName} is not set.`, {
    hint: `Set ${keyName} in the environment (never in a config file), or use a free voice with --tts kokoro.`,
  });
}

export function createRemoteSpeechProvider(
  spec: RemoteSpeechSpec,
  options: RemoteSpeechOptions = {},
): TtsProvider {
  const model = (ctx: RunContext): string => ctx.config.tts.model ?? spec.defaultModel;
  return {
    id: spec.id,
    local: false,
    speaks: true,
    model,

    async voice(ctx: RunContext): Promise<string | null> {
      return ctx.config.tts.voice || spec.defaultVoice(model(ctx));
    },

    async unavailable(ctx: RunContext): Promise<MergeStoryError | null> {
      return ctx.secrets.has(spec.keyName) ? null : keyMissing(spec.keyName);
    },

    estimateCostUsd(characters: number, ctx: RunContext): number {
      return ttsCostUsd(ctx, spec.id, model(ctx), characters);
    },

    async plannedEgress(_ctx: RunContext, characters: number): Promise<EgressRecord[]> {
      return [
        {
          destination: spec.host,
          purpose: 'speech synthesis',
          bytes: characters,
          contains: ['narration-text'],
        },
      ];
    },

    async synthesize(request: TtsRequest, ctx: RunContext): Promise<TtsResult> {
      if (ctx.dryRun) {
        throw new MergeStoryError('INTERNAL', 'Refusing to send a paid speech request during a dry run.');
      }
      const key = ctx.secrets.get(spec.keyName);
      if (!key) throw keyMissing(spec.keyName);
      const modelName = model(ctx);
      const voice = request.voice ?? spec.defaultVoice(modelName);
      const badVoice = spec.voiceProblem(voice);
      if (badVoice) throw badVoice;
      const pieces = splitForSynthesis(request.text, spec.maxChars);
      if (pieces.length === 0) {
        throw new MergeStoryError('TTS_FAILED', 'There is no text to speak.');
      }
      const characters = pieces.reduce((sum, p) => sum + p.length, 0);
      ctx.cost.assertWithinBudget(
        ttsCostUsd(ctx, spec.id, modelName, characters),
        `${spec.service} speech synthesis`,
      );
      spec.notices?.({ ctx, model: modelName, request });

      const audio: Buffer[] = [];
      for (const piece of pieces) {
        const call = spec.call({ key, model: modelName, voice, piece, request });
        ctx.egress.record(spec.host, 'speech synthesis', Buffer.byteLength(piece, 'utf8'), [
          'narration-text',
        ]);
        let bytes: Buffer;
        try {
          const response = await fetchWithRetry(
            call.url,
            { method: 'POST', headers: call.headers, body: JSON.stringify(call.body) },
            { signal: ctx.signal, timeoutMs: 120_000, ...options.retry },
          );
          bytes = await readBodyLimited(response, MAX_AUDIO_BYTES, 'TTS_FAILED', spec.host);
        } catch (err) {
          throw speechRequestError(err, { service: spec.service, keyName: spec.keyName, ctx });
        }
        ctx.cost.record({
          provider: spec.id,
          kind: 'tts',
          model: modelName,
          characters: piece.length,
          costUsd: ttsCostUsd(ctx, spec.id, modelName, piece.length),
          estimated: true,
        });
        if (bytes.length < 2) {
          throw new MergeStoryError('TTS_FAILED', `${spec.service} returned no audio for a narration line.`, {
            hint: 'Run again; finished lines are cached.',
          });
        }
        audio.push(bytes);
      }
      return {
        audio: joinPcmS16le(audio, PCM_RATE),
        format: 'pcm_s16le',
        sampleRate: PCM_RATE,
        channels: 1,
        characters,
      };
    },
  };
}
