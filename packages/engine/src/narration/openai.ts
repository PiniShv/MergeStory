/**
 * OpenAI speech provider (paid, remote): POST /v1/audio/speech with raw 24 kHz PCM back. The request
 * sequence is shared with the other paid provider (see remote-speech.ts).
 */
import { MergeStoryError } from '../core/errors.ts';
import type { TtsProvider } from '../core/providers.ts';
import { createRemoteSpeechProvider, type RemoteSpeechOptions } from './remote-speech.ts';

const OPENAI_HOST = 'api.openai.com';
export const OPENAI_SPEECH_URL = `https://${OPENAI_HOST}/v1/audio/speech`;
const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini-tts';
/** The API allows 4096 characters but the model page caps input at about 2000 tokens; stay well below both. */
const MAX_INPUT_CHARS = 1500;
const NARRATOR_STYLE = 'Calm, clear, friendly technical narrator. Natural pace.';
/** OpenAI has announced it will remove these speech models on 2027-01-06. Warn from 2026-12-01. */
const SHUTDOWN_WARNING_FROM = Date.UTC(2026, 11, 1);

export function createOpenAiProvider(options: RemoteSpeechOptions = {}): TtsProvider {
  return createRemoteSpeechProvider(
    {
      id: 'openai',
      service: 'OpenAI',
      host: OPENAI_HOST,
      keyName: 'OPENAI_API_KEY',
      defaultModel: OPENAI_DEFAULT_MODEL,
      defaultVoice: (model) => (model.startsWith('tts-1') ? 'alloy' : 'marin'),
      voiceProblem: (voice) =>
        /^[A-Za-z0-9_-]{2,64}$/.test(voice)
          ? null
          : new MergeStoryError('CONFIG_INVALID', 'The OpenAI voice name is not valid.', {
              hint: 'Use a voice name such as marin, cedar, alloy or coral in tts.voice.',
            }),
      maxChars: MAX_INPUT_CHARS,

      notices({ ctx }) {
        if (Date.now() < SHUTDOWN_WARNING_FROM || !ctx.firstTime('openai-tts-shutdown')) return;
        ctx.logger.warn(
          'OpenAI has announced that its text-to-speech models (tts-1, tts-1-hd and gpt-4o-mini-tts) ' +
            'will be removed from the API on 2027-01-06. Plan to switch to another speech provider.',
        );
      },

      call({ key, model, voice, piece, request }) {
        const body: Record<string, unknown> = {
          model,
          voice: /^voice_/.test(voice) ? { id: voice } : voice,
          input: piece,
          response_format: 'pcm',
        };
        if (request.speed !== 1) body.speed = Math.min(4, Math.max(0.25, request.speed));
        if (model.startsWith('gpt-4o-mini-tts')) body.instructions = NARRATOR_STYLE;
        return {
          url: OPENAI_SPEECH_URL,
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body,
        };
      },
    },
    options,
  );
}
