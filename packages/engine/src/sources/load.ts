/** Load the sources of a run, one after the other, with a progress line for each. */
import { basename } from 'node:path';
import type { RunContext } from '../core/context.ts';
import { MergeStoryError } from '../core/errors.ts';
import { changeLabel } from '../core/labels.ts';
import type { SourceInput } from '../core/providers.ts';
import { createSourceProvider } from './index.ts';
import type { LoadedSource } from './join.ts';

function describeSource(input: SourceInput, several: boolean): string {
  if (input.kind === 'github') return input.url;
  const range = `${input.base ?? 'merge base'}..${input.head ?? 'HEAD'}`;
  // With several sources the message must say which one it means.
  return several ? `local repository ${basename(input.repoPath)} (${range})` : `local repository (${range})`;
}

/** The change set and the reader of each source, in the order given. A source with no changes is an error. */
export async function loadSources(
  inputs: readonly SourceInput[],
  ctx: RunContext,
): Promise<Pick<LoadedSource, 'changeSet' | 'reader'>[]> {
  const several = inputs.length > 1;
  const loaded: Pick<LoadedSource, 'changeSet' | 'reader'>[] = [];
  for (const input of inputs) {
    const name = describeSource(input, several);
    ctx.progress({ stage: 'source', status: 'start', message: `Reading ${name}` });
    const one = await createSourceProvider(input)
      .load(input, ctx)
      .catch((error: unknown) => {
        // With several sources a failure must say which one it came from.
        if (!several || !(error instanceof MergeStoryError) || error.code === 'ABORTED') throw error;
        throw new MergeStoryError(error.code, `${name}: ${error.message}`, {
          ...(error.hint === undefined ? {} : { hint: error.hint }),
          ...(error.details === undefined ? {} : { details: error.details }),
          retryable: error.retryable,
          cause: error,
        });
      });
    ctx.progress({
      stage: 'source',
      status: 'done',
      message: `${changeLabel(one.changeSet)}: ${one.changeSet.stats.files} files, +${one.changeSet.stats.additions} -${one.changeSet.stats.deletions}`,
    });
    if (one.changeSet.files.length === 0) {
      throw new MergeStoryError(
        'SOURCE_INVALID',
        several ? `There are no changes to explain in ${name}.` : 'There are no changes to explain.',
        { hint: 'Check the base and head refs. Only committed changes are included for local repositories.' },
      );
    }
    loaded.push(one);
  }
  return loaded;
}
