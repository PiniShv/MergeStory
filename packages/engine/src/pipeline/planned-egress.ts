/**
 * What a real run would send, and where, for the dry-run plan. The speech provider and the publisher
 * say what they would send; this adds the model call (modelEgress, as in the real run) and the pull
 * request update. It follows the decisions of the real run: a link to a file on this machine is never
 * posted on a pull request, and a publish setting that would make the run fail sends nothing.
 */
import type { Config } from '../core/config.ts';
import type { RunContext } from '../core/context.ts';
import type { TtsProvider } from '../core/providers.ts';
import type { ChangeSet, EgressRecord } from '../core/types.ts';
import { parsePullRequestUrl } from '../github/pr-url.ts';
import { createPublisher } from '../publish/index.ts';
import { modelEgress } from '../storyboard/generate.ts';
import { decidePullRequestUpdate } from './publish-run.ts';

export interface EgressPlanInput {
  ctx: RunContext;
  changeSet: Pick<ChangeSet, 'source' | 'pr'>;
  /** The model that would write the storyboard, or null when none is called. */
  llm: { host: string; promptBytes: number } | null;
  tts: Pick<TtsProvider, 'plannedEgress'>;
  narrationChars: number;
  estimatedVideoBytes: number;
  /** Publishing would fail before anything is sent (the publisher's check found a problem). */
  publishBlocked: boolean;
}

/** The host that the pull request is updated on: the API of the pull request's own host, as in the real run. */
function pullRequestHost(prUrl: string, config: Config): string {
  try {
    return new URL(parsePullRequestUrl(prUrl, config.github.apiUrl).apiUrl).host;
  } catch {
    return new URL(config.github.apiUrl).host;
  }
}

export async function planEgress(
  input: EgressPlanInput,
): Promise<{ egress: EgressRecord[]; warnings: string[] }> {
  const { ctx, changeSet, tts } = input;
  const { config } = ctx;
  const egress: EgressRecord[] = [];
  const warnings: string[] = [];

  const model = input.llm ? modelEgress(config, input.llm.host, input.llm.promptBytes) : null;
  if (model) egress.push(model);
  egress.push(...(await tts.plannedEgress(ctx, input.narrationChars)));

  const publisher = createPublisher(config);
  if (publisher && !input.publishBlocked) {
    egress.push(...publisher.plannedEgress(input.estimatedVideoBytes));
  }

  const update = decidePullRequestUpdate(
    config,
    { source: changeSet.source, prUrl: changeSet.pr?.url ?? null },
    publisher?.id ?? null,
  );
  if (update.kind === 'not-a-pull-request') {
    warnings.push(
      'The pull request would not be updated: this change does not come from a GitHub pull request.',
    );
  } else if (update.kind === 'video-stays-local') {
    warnings.push(
      'The pull request would not be updated: the video stays on this machine. Publish it first (for example --publish s3).',
    );
  } else if (update.kind === 'update' && !input.publishBlocked) {
    const destination = pullRequestHost(update.prUrl, config);
    if (config.github.comment)
      egress.push({ destination, purpose: 'pull request comment', bytes: 4000, contains: ['comment'] });
    if (config.github.updateDescription)
      egress.push({ destination, purpose: 'pull request description', bytes: 4000, contains: ['comment'] });
  }
  return { egress, warnings };
}
