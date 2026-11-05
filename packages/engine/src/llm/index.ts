/** LLM providers behind the LlmProvider interface. The engine is not tied to any one vendor. */
import type { Config, Secrets } from '../core/config.ts';
import { MergeStoryError } from '../core/errors.ts';
import type { LlmProvider } from '../core/providers.ts';
import { createAnthropicProvider } from './anthropic.ts';
import { createOpenAiFromConfig } from './openai-compatible.ts';

export { createAnthropicProvider } from './anthropic.ts';
export type { OpenAiFlavor, OpenAiProviderOptions } from './openai-compatible.ts';
export { createOpenAiFromConfig, createOpenAiProvider, OPENAI_BASE_URL } from './openai-compatible.ts';

/** Cheap, capable defaults per provider (used when llm.model is null). */
export const DEFAULT_MODELS: Record<'anthropic' | 'openai' | 'openai-compatible', string | null> = {
  anthropic: 'claude-haiku-5-5',
  openai: 'gpt-6-luna',
  'openai-compatible': null,
};

/** Returns null for provider "none". Throws CONFIG_INVALID when a required key or base URL is missing. */
export function createLlmProvider(config: Config, secrets: Secrets): LlmProvider | null {
  const { provider } = config.llm;
  if (provider === 'none') return null;
  const model = config.llm.model?.trim() || DEFAULT_MODELS[provider];
  if (!model) {
    throw new MergeStoryError('CONFIG_INVALID', `The ${provider} provider needs a model name.`, {
      hint: 'Set llm.model or MERGESTORY_LLM_MODEL, for example "llama3.1" for a local Ollama server.',
    });
  }
  if (provider === 'anthropic') return createAnthropicProvider(config, secrets, model);
  return createOpenAiFromConfig(provider, config, secrets, model);
}
