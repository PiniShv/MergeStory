/** mergestory generate: make the video (or, with --dry-run, show the plan). */
import type { Command } from 'commander';
import { type ConfigInput, mergeConfigInputs } from '../../core/config.ts';
import type { GenerateResult, PlanResult } from '../../core/types.ts';
import type { JobOptions } from '../../jobs/model.ts';
import { redactResult } from '../../jobs/view.ts';
import { formatGenerateResult, formatPlanResult } from '../format.ts';
import {
  addContextFlags,
  addProviderFlags,
  addRunFlags,
  addSourceFlags,
  addStyleFlags,
  buildCommonOptions,
  type GenerateFlags,
  readStoryboard,
} from '../options.ts';
import type { CliRuntime, CommandEnv } from '../runtime.ts';
import { loadConfig, reportFailedPullRequestUpdate } from './shared.ts';

const EXAMPLES = `
Examples:
  mergestory generate https://github.com/acme/app/pull/42
  mergestory generate . --base main --dry-run
  mergestory generate acme/app#42 --llm anthropic --budget 0.10
  mergestory generate . --storyboard storyboard.json --tests-file tests.json
`;

/** true for the result of a dry run. */
export function isPlanResult(result: GenerateResult | PlanResult): result is PlanResult {
  return 'dryRun' in result && result.dryRun === true;
}

/** Start the job in a background worker and print its id. */
async function runInBackground(env: CommandEnv, options: JobOptions): Promise<void> {
  // Check the settings now, so a typo is reported here instead of in a background process.
  const config = await loadConfig(env, options.config);
  const { startBackgroundJob } = await import('../../jobs/runner.ts');
  const job = await startBackgroundJob(options, { home: config.home, env: env.io.env });
  if (env.json) {
    env.emitJson({ ok: true, id: job.id, status: job.status });
    return;
  }
  env.say(`Started job ${job.id} in the background.`);
  env.say(`Check on it with: mergestory status ${job.id} --wait`);
}

/** Add the `generate` command. */
export function registerGenerate(program: Command, rt: CliRuntime): void {
  const command = program
    .command('generate')
    .description('Make a video from a pull request or a local change')
    .argument('[source]', 'pull request URL, owner/repo#123, or the path of a local repository', '.');
  addSourceFlags(command);
  addContextFlags(command);
  addStyleFlags(command, true);
  addProviderFlags(command);
  addRunFlags(command);
  command.addHelpText('after', EXAMPLES);
  command.action(async (source: string, flags: GenerateFlags, cmd: Command) => {
    await makeVideo(rt.env(cmd), source, flags);
  });
}

/**
 * Build the options, read the storyboard, run the pipeline and print the result. `forced` settings
 * are merged over the flags (render uses them to stay on this machine).
 */
export async function makeVideo(
  env: CommandEnv,
  source: string,
  flags: GenerateFlags,
  forced?: ConfigInput,
): Promise<void> {
  const common = await buildCommonOptions(source, flags, { cwd: env.io.cwd, logger: env.logger });
  const options: JobOptions = { ...common };
  if (forced) options.config = mergeConfigInputs(common.config, forced);
  if (flags.storyboard)
    options.storyboard = await readStoryboard(flags.storyboard, env.io.cwd, '--storyboard');
  if (flags.dryRun) options.dryRun = true;
  if (flags.allowLowContrast) options.allowLowContrast = true;
  if (flags.async) {
    await runInBackground(env, options);
    return;
  }
  // Loaded here, so that --help and the small commands stay quick to start.
  const { generate } = await import('../../pipeline/index.ts');
  const result = await generate({ ...options, signal: env.signal, logger: env.logger });
  const safe = redactResult(result);
  if (env.json) env.emitJson(safe);
  else
    env.say(isPlanResult(safe) ? formatPlanResult(safe, env.style) : formatGenerateResult(safe, env.style));
  if (!isPlanResult(safe)) reportFailedPullRequestUpdate(env, safe);
}
