/** status, jobs and the hidden worker: the command line side of background jobs. */
import type { Command } from 'commander';
import { EXIT_CODES } from '../../core/errors.ts';
import type { Job } from '../../jobs/model.ts';
import { formatJob, formatJobList } from '../format.ts';
import { numberFlag } from '../options.ts';
import type { CliRuntime } from '../runtime.ts';
import { openJobStore } from './shared.ts';

/** 0 unless the job failed, in which case the exit code of its error. */
export function exitCodeForJob(job: Job): number {
  if (job.status !== 'failed') return 0;
  return job.error ? (EXIT_CODES[job.error.code] ?? 1) : 1;
}

/** Add `status`, `jobs` and the hidden `worker` command. */
export function registerJobCommands(program: Command, rt: CliRuntime): void {
  program
    .command('status')
    .description('Show the state of a background job')
    .argument('<jobId>', 'job id, as printed by generate --async')
    .option('--wait', 'wait until the job has finished')
    .option(
      '--timeout <sec>',
      'with --wait: stop waiting after this many seconds (the job keeps running)',
      numberFlag({ integer: true, min: 1 }),
      900,
    )
    .action(async (jobId: string, flags: { wait?: boolean; timeout: number }, cmd: Command) => {
      const env = rt.env(cmd);
      const { store } = await openJobStore(env);
      const { publicJob } = await import('../../jobs/view.ts');
      let job: Job;
      if (flags.wait) {
        const { waitForJob } = await import('../../jobs/runner.ts');
        job = await waitForJob(jobId, flags.timeout * 1000, {
          store,
          signal: env.signal,
          onUpdate: (current) => env.logger.info(`[${current.progress.stage}] ${current.progress.message}`),
        });
      } else {
        job = await store.get(jobId);
      }
      const view = publicJob(job);
      if (env.json) env.emitJson(view);
      else env.say(formatJob(view, env.style));
      env.setExitCode(exitCodeForJob(job));
    });

  program
    .command('jobs')
    .description('List recent background jobs')
    .option(
      '--limit <n>',
      'how many jobs to show (1-200)',
      numberFlag({ integer: true, min: 1, max: 200 }),
      20,
    )
    .action(async (flags: { limit: number }, cmd: Command) => {
      const env = rt.env(cmd);
      const { store } = await openJobStore(env);
      const { summarizeJob } = await import('../../jobs/view.ts');
      const jobs = (await store.list(flags.limit)).map(summarizeJob);
      if (env.json) env.emitJson({ jobs });
      else env.say(formatJobList(jobs, env.style));
    });

  program
    .command('worker', { hidden: true })
    .description('Run a background job (started by generate --async)')
    .argument('<jobId>')
    .action(async (jobId: string, _options: unknown, cmd: Command) => {
      const env = rt.env(cmd);
      // The job holds its own settings. The worker only needs to find the job file, and the process
      // that started it passed the home folder on in the environment.
      const { defaultJobStore, runJob } = await import('../../jobs/runner.ts');
      const store = defaultJobStore(env.io.env.MERGESTORY_HOME?.trim() || null);
      const job = await runJob(jobId, { store, signal: env.signal, logger: env.logger });
      env.setExitCode(exitCodeForJob(job));
    });
}
