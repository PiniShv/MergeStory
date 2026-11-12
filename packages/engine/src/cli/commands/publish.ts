/** `mergestory publish <run>`: upload a run that was rendered earlier, and optionally update the PR. */
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { MergeStoryError } from '../../core/errors.ts';
import type { GenerateResult, PublishResult } from '../../core/types.ts';
import { redactResult } from '../../jobs/view.ts';
import type { PublishRunOptions } from '../../pipeline/index.ts';
import { formatCost, formatEgress, formatRows, formatTime } from '../format.ts';
import { addPublishFlags, configFromFlags, type PublishFlags } from '../options.ts';
import type { CliRuntime } from '../runtime.ts';
import type { Style } from '../style.ts';
import { loadConfig, reportFailedPullRequestUpdate } from './shared.ts';

const EXAMPLES = `
Examples:
  mergestory publish 20261104-101500-a1b2 --publish s3
  mergestory publish ~/.mergestory/runs/20261104-101500-a1b2 --publish s3 --visibility protected --comment
  mergestory publish ./my-run --publish youtube
  mergestory publish ./my-run --publish drive --visibility protected --comment
`;

/** A run folder that exists next to the user becomes an absolute path; anything else is taken as a run id. */
async function normalizeRun(run: string, cwd: string): Promise<string> {
  if (run.trim() === '') {
    throw new MergeStoryError('USAGE', 'The run folder or run id is empty.', {
      hint: 'Pass the runDir of a generate result, or its run id.',
    });
  }
  const absolute = resolve(cwd, run);
  const info = await stat(absolute).catch(() => null);
  return info?.isDirectory() ? absolute : run;
}

/** Who can open the link, in plain words. */
function describeAccess(publish: PublishResult): string {
  if (publish.provider === 'local') return 'only on this machine, so nobody else can open these files';
  switch (publish.visibility) {
    case 'protected':
      return 'protected: a permanent link that needs a team sign-in';
    case 'public':
      return 'public: a permanent link that anyone can open';
    case 'unlisted':
      return 'unlisted: anyone with the link can watch, and it is not listed publicly';
    case 'private':
      return publish.expiresAt
        ? 'private: a signed link that stops working when it expires'
        : 'private: only you can watch it';
  }
}

function pullRequestLine(notify: NonNullable<GenerateResult['notify']>): string | null {
  const parts: string[] = [];
  if (notify.commentUrl) parts.push(`comment ${notify.commentUrl}`);
  if (notify.descriptionUpdated) parts.push('description updated');
  return parts.length > 0 ? parts.join(', ') : null;
}

/** The block printed after a run was published. Takes a result that is already redacted. */
export function formatPublishResult(result: GenerateResult, style: Style): string {
  const publish = result.publish;
  if (!publish) {
    return [
      `${style.yellow('Nothing was published')}: ${result.title}`,
      '',
      'Choose where the video goes with --publish local, s3, youtube or drive.',
      '',
    ].join('\n');
  }
  const link = publish.watchUrl ?? publish.videoUrl;
  const lines = [
    `${style.green('Published')}: ${result.title}`,
    '',
    ...formatRows(
      [
        [publish.provider === 'local' ? 'Saved' : 'Shared', link],
        ['Video', publish.watchUrl && publish.provider !== 'local' ? publish.videoUrl : null],
        ['Access', describeAccess(publish)],
        ['Expires', formatTime(publish.expiresAt)],
        ['Pull request', result.notify ? pullRequestLine(result.notify) : null],
        ['Run folder', result.runDir],
        ['Cost', formatCost(result.cost)],
        ['Sent', result.egress.length > 0 ? result.egress.map(formatEgress) : ['nothing left this machine']],
      ],
      style,
    ),
  ];
  if (result.warnings.length > 0)
    lines.push('', style.yellow('Warnings'), ...result.warnings.map((w) => `  - ${w}`));
  return `${lines.join('\n')}\n`;
}

/** Add the `publish` command. */
export function registerPublish(program: Command, rt: CliRuntime): void {
  const command = program
    .command('publish')
    .description('Upload or share a video you made earlier, and optionally post it on the pull request')
    .argument('<run>', 'run folder (the runDir of a generate result) or run id');
  addPublishFlags(command);
  command.addHelpText('after', EXAMPLES);
  command.action(async (run: string, flags: PublishFlags, cmd: Command) => {
    const env = rt.env(cmd);
    const config = await configFromFlags(flags, env.io.cwd);
    const overrides = Object.keys(config).length > 0 ? config : undefined;
    // The settings are checked here, before anything is read or sent, so a typo is reported at once.
    const settings = await loadConfig(env, overrides);
    if (settings.publish.provider === 'none') {
      throw new MergeStoryError('USAGE', 'There is nowhere to publish to: the publish provider is "none".', {
        hint: 'Choose one with --publish local, s3, youtube or drive, or set MERGESTORY_PUBLISH_PROVIDER.',
      });
    }
    const options: PublishRunOptions = {
      run: await normalizeRun(run, env.io.cwd),
      signal: env.signal,
      logger: env.logger,
    };
    if (overrides) options.config = overrides;
    // Loaded here, so that --help and the small commands stay quick to start.
    const { publishRun } = await import('../../pipeline/index.ts');
    const result = await publishRun(options);
    const safe = redactResult(result);
    if (env.json) env.emitJson(safe);
    else env.say(formatPublishResult(safe, env.style));
    reportFailedPullRequestUpdate(env, safe);
  });
}
