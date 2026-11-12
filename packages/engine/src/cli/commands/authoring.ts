/** analyze, validate and schema: the commands for writing a storyboard without a model. */
import type { Command } from 'commander';
import { globalRedactor } from '../../core/redact.ts';
import { commandLine } from '../../pipeline/commands.ts';
import { formatAuthoring, formatValidation } from '../format.ts';
import type { ContextFlags } from '../inputs.ts';
import {
  addContextFlags,
  addSourceFlags,
  buildCommonOptions,
  type CommonOptions,
  type ConfigFlags,
  durationOption,
  followUpFor,
  maxDurationOption,
  readStoryboard,
  type SourceFlags,
} from '../options.ts';
import type { CliRuntime, CommandEnv } from '../runtime.ts';

export type AnalyzeFlags = SourceFlags & ContextFlags & Pick<ConfigFlags, 'out'>;
export type ValidateFlags = SourceFlags &
  ContextFlags &
  Pick<ConfigFlags, 'maxDuration' | 'duration' | 'language'>;

/** Add the `analyze` command. */
export function registerAnalyze(program: Command, rt: CliRuntime): void {
  const command = program
    .command('analyze')
    .description(
      'Analyse a change and write the files needed to author a storyboard yourself (free, no model is called)',
    )
    .argument('[source]', 'pull request URL, owner/repo#123, or the path of a local repository', '.');
  addSourceFlags(command);
  addContextFlags(command);
  command
    .optionsGroup('Output:')
    .option('--out <dir>', 'write the files here instead of under the MergeStory home');
  command.action(async (source: string, flags: AnalyzeFlags, cmd: Command) => {
    const env = rt.env(cmd);
    const common = await buildCommonOptions(source, flags, { cwd: env.io.cwd, logger: env.logger });
    // The follow-up commands name the source the way it was resolved, so they work from any directory.
    const shownSource = typeof common.source === 'string' ? common.source : source;
    const { source: followSource, args, contextArgs } = followUpFor(shownSource, flags, env.io.cwd);
    const { prepareAuthoring } = await import('../../pipeline/index.ts');
    const result = await prepareAuthoring({
      ...common,
      outDir: common.config?.outDir ?? null,
      followUp: { source: followSource, args },
      signal: env.signal,
      logger: env.logger,
    });
    if (env.json) {
      env.emitJson(globalRedactor.redactValue({ ok: true, ...result }));
      return;
    }
    env.say(
      formatAuthoring(
        globalRedactor.redactValue(result),
        { source: shownSource, base: flags.base, head: flags.head },
        env.style,
      ),
    );
    // Task, notes, tests and screenshots create the evidence ids, so steps 3 and 4 need them too.
    if (contextArgs.length > 0) {
      env.say(
        `Give steps 3 and 4 the same context flags, so that the ids in evidence.md exist there too:\n  ${commandLine(contextArgs)}`,
      );
    }
  });
}

/** Add the `validate` command. */
export function registerValidate(program: Command, rt: CliRuntime): void {
  const command = program
    .command('validate')
    .description('Check a storyboard against a change without rendering anything')
    .argument('<storyboard>', 'storyboard JSON file')
    .argument('[source]', 'pull request URL, owner/repo#123, or the path of a local repository', '.');
  addSourceFlags(command);
  addContextFlags(command);
  command
    .optionsGroup('Limits:')
    .addOption(maxDurationOption(true))
    .addOption(durationOption())
    .option('--language <code>', 'narration language, for example en');
  command.action(async (storyboardPath: string, source: string, flags: ValidateFlags, cmd: Command) => {
    const env = rt.env(cmd);
    const common = await buildCommonOptions(source, flags, { cwd: env.io.cwd, logger: env.logger });
    const storyboard = await readStoryboard(storyboardPath, env.io.cwd, 'storyboard file');
    await checkAndReport(env, common, storyboard);
  });
}

/** Check a storyboard and print the result (validate and agent validate). */
export async function checkAndReport(
  env: CommandEnv,
  common: CommonOptions,
  storyboard: unknown,
): Promise<void> {
  const { checkStoryboard } = await import('../../pipeline/index.ts');
  const result = await checkStoryboard({ ...common, storyboard, signal: env.signal, logger: env.logger });
  const valid = result.errors.length === 0;
  if (env.json) {
    env.emitJson(
      globalRedactor.redactValue({
        ok: valid,
        errors: result.errors,
        warnings: result.warnings,
        fixes: result.fixes,
        groundedClaims: result.groundedClaims,
      }),
    );
  } else {
    env.say(formatValidation(globalRedactor.redactValue(result), env.style));
  }
  // Exit code 3 is "the storyboard is not valid", the same as when generate refuses one.
  if (!valid) env.setExitCode(3);
}

/** Add the `schema` command. */
export function registerSchema(program: Command, rt: CliRuntime): void {
  program
    .command('schema')
    .description('Print the JSON Schema of a storyboard')
    .action(async (_options: unknown, cmd: Command) => {
      const env = rt.env(cmd);
      const { storyboardJsonSchema } = await import('../../core/storyboard-schema.ts');
      env.io.stdout(`${JSON.stringify(storyboardJsonSchema(), null, 2)}\n`);
    });
}
