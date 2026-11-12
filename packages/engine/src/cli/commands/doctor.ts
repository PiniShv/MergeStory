/** mergestory doctor: check the environment. Exit code 1 when a check fails. */
import type { Command } from 'commander';
import type { Config } from '../../core/config.ts';
import { type CliRuntime, describeError } from '../runtime.ts';

/** Add the `doctor` command. */
export function registerDoctor(program: Command, rt: CliRuntime): void {
  program
    .command('doctor')
    .description('Check that this machine is ready to make videos, and how to fix what is missing')
    .option(
      '--online',
      'also contact the services you set up: the storage bucket, and the sign-in on protected link addresses. Without it nothing is sent over the network',
    )
    .action(async (flags: { online?: boolean }, cmd: Command) => {
      const env = rt.env(cmd);
      const { resolveConfig } = await import('../../core/config.ts');
      let config: Config;
      let configError: { message: string; hint?: string | undefined } | null = null;
      try {
        config = resolveConfig({ env: env.io.env, cwd: env.io.cwd });
      } catch (err) {
        const report = describeError(err);
        configError = { message: report.message, hint: report.hint ?? undefined };
        // Check the rest of the machine with the defaults.
        config = resolveConfig({ skipFile: true, env: {} });
      }
      const { runDoctor, formatDoctor } = await import('../../doctor/index.ts');
      const report = await runDoctor({
        config,
        configError,
        online: flags.online === true,
        deps: { env: env.io.env },
      });
      if (env.json) env.emitJson(report);
      else env.say(formatDoctor(report, env.style));
      if (!report.ok) env.setExitCode(1);
    });
}
