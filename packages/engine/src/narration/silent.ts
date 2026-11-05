/** The "none" provider: no audio. Captions still work, with timing estimated from word counts. */
import { MergeStoryError } from '../core/errors.ts';
import type { TtsProvider } from '../core/providers.ts';

export function createSilentProvider(): TtsProvider {
  return {
    id: 'none',
    local: true,
    speaks: false,
    model: () => null,
    voice: async () => null,
    unavailable: async () => null,
    synthesize: async () => {
      throw new MergeStoryError('INTERNAL', 'The silent provider makes no audio.');
    },
    estimateCostUsd: () => 0,
    plannedEgress: async () => [],
  };
}
