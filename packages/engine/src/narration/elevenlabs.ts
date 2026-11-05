/**
 * ElevenLabs speech provider (paid, remote): POST /v1/text-to-speech/{voice_id} with raw 24 kHz PCM
 * back. The request sequence is shared with the other paid provider (see remote-speech.ts).
 */
import { MergeStoryError } from '../core/errors.ts';
import type { TtsProvider } from '../core/providers.ts';
import { createRemoteSpeechProvider, type RemoteSpeechOptions } from './remote-speech.ts';

const ELEVENLABS_HOST = 'api.elevenlabs.io';
const ELEVENLABS_BASE_URL = `https://${ELEVENLABS_HOST}/v1/text-to-speech`;
/** The cheap, fast model. */
const ELEVENLABS_DEFAULT_MODEL = 'eleven_flash_v2_5';
/** A premade voice (Rachel) that every account can use; set tts.voice to use another. */
export const ELEVENLABS_DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM';
/** The smallest per-request limit among the models is 5,000 characters; stay below it. */
const MAX_INPUT_CHARS = 4000;
/** Only some models have a speed setting, and the API accepts 0.7 to 1.2 for it. */
const HAS_SPEED = /flash|turbo|multilingual/;

export function createElevenLabsProvider(options: RemoteSpeechOptions = {}): TtsProvider {
  return createRemoteSpeechProvider(
    {
      id: 'elevenlabs',
      service: 'ElevenLabs',
      host: ELEVENLABS_HOST,
      keyName: 'ELEVENLABS_API_KEY',
      defaultModel: ELEVENLABS_DEFAULT_MODEL,
      defaultVoice: () => ELEVENLABS_DEFAULT_VOICE,
      // The voice id becomes part of the URL path, so only plain id characters are allowed.
      voiceProblem: (voice) =>
        /^[A-Za-z0-9_-]{8,64}$/.test(voice)
          ? null
          : new MergeStoryError('CONFIG_INVALID', 'The ElevenLabs voice must be a voice ID.', {
              hint: 'Copy the voice ID from the Voices page of your ElevenLabs account into tts.voice.',
            }),
      maxChars: MAX_INPUT_CHARS,

      notices({ ctx, model, request }) {
        if (request.speed === 1 || HAS_SPEED.test(model) || !ctx.firstTime(`elevenlabs-speed:${model}`))
          return;
        ctx.logger.warn(`The ElevenLabs model ${model} has no speed setting, so tts.speed is ignored.`);
      },

      call({ key, model, voice, piece, request }) {
        const languageCode = request.language.split(/[-_]/)[0]?.toLowerCase() ?? 'en';
        const body: Record<string, unknown> = { text: piece, model_id: model };
        if (languageCode !== 'en' && model !== 'eleven_multilingual_v2') body.language_code = languageCode;
        if (request.speed !== 1 && HAS_SPEED.test(model)) {
          body.voice_settings = { speed: Math.min(1.2, Math.max(0.7, request.speed)) };
        }
        return {
          url: `${ELEVENLABS_BASE_URL}/${encodeURIComponent(voice)}?output_format=pcm_24000`,
          headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
          body,
        };
      },
    },
    options,
  );
}
