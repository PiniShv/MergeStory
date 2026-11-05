/** Check of the model that writes the storyboard. */
import { openAiBaseUrlError } from '../llm/openai-compatible.ts';
import { check, urlHost } from './check.ts';
import type { DoctorCheck, DoctorContext } from './types.ts';

export function checkLlm({ config, secrets }: DoctorContext): DoctorCheck {
  const provider = config.llm.provider;
  if (provider === 'none') {
    return check(
      'llm',
      'Storyboard writer (LLM)',
      'pass',
      'none: free offline storyboards, or one you pass with --storyboard. Nothing is sent to a model.',
    );
  }
  if (provider === 'openai-compatible') {
    const host = urlHost(config.llm.baseUrl);
    if (!host) {
      return check(
        'llm',
        'Storyboard writer (LLM)',
        'fail',
        'openai-compatible selected but no base URL is set',
        'Set MERGESTORY_LLM_BASE_URL or pass --llm-base-url.',
      );
    }
    const key = secrets.has('MERGESTORY_LLM_API_KEY')
      ? 'MERGESTORY_LLM_API_KEY is set'
      : 'no key set (fine for servers that need none)';
    return check(
      'llm',
      'Storyboard writer (LLM)',
      'pass',
      `openai-compatible at ${host}, ${key}. The change's diff and text are sent there.`,
    );
  }
  if (provider === 'openai') {
    const error = openAiBaseUrlError(config.llm.baseUrl);
    if (error) return check('llm', 'Storyboard writer (LLM)', 'fail', error.message, error.hint);
  }
  const keyName = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
  const host = provider === 'anthropic' ? 'api.anthropic.com' : 'api.openai.com';
  if (secrets.has(keyName)) {
    const model = config.llm.model ? ` (${config.llm.model})` : '';
    return check(
      'llm',
      'Storyboard writer (LLM)',
      'pass',
      `${provider}${model}: ${keyName} is set. The change's diff and text are sent to ${host}.`,
    );
  }
  return check(
    'llm',
    'Storyboard writer (LLM)',
    'fail',
    `${provider} selected but ${keyName} is not set`,
    `Set ${keyName} in your environment, or use --llm none for the free offline mode.`,
  );
}
