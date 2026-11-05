/** Helpers used by more than one command. */
import type { Config, ConfigInput } from '../../core/config.ts';
import { EXIT_CODES } from '../../core/errors.ts';
import type { GenerateResult } from '../../core/types.ts';
import type { JobStore } from '../../jobs/store.ts';
import type { CommandEnv } from '../runtime.ts';

/** Resolve the configuration the way a run would: flags are not involved, environment and config file are. */
export async function loadConfig(env: CommandEnv, overrides?: ConfigInput): Promise<Config> {
  const { resolveConfig } = await import('../../core/config.ts');
  return resolveConfig({ overrides, configPath: env.configPath, env: env.io.env, cwd: env.io.cwd });
}

/** The job store under the configured MergeStory home. */
export async function openJobStore(env: CommandEnv): Promise<{ store: JobStore; config: Config }> {
  const config = await loadConfig(env);
  const { defaultJobStore } = await import('../../jobs/runner.ts');
  return { store: defaultJobStore(config.home), config };
}

/**
 * Set the exit code when a pull request update was asked for and nothing could be written. The video
 * is published and its link is printed, but a script that asked for a comment should notice that
 * there is none. (A pull request that was skipped on purpose has no `notify` at all.)
 */
export function reportFailedPullRequestUpdate(env: CommandEnv, result: Pick<GenerateResult, 'notify'>): void {
  const { notify } = result;
  if (notify !== null && notify.commentUrl === null && !notify.descriptionUpdated) {
    env.setExitCode(EXIT_CODES.NOTIFY_FAILED);
  }
}
