/**
 * The rules that keep a video from leaving the machine when it should not, shared by the publishers
 * that upload. Each publisher says what its own settings expose and words its own refusal.
 */
import type { Config } from '../core/config.ts';
import type { RunContext } from '../core/context.ts';
import { MergeStoryError } from '../core/errors.ts';

/** The words of a refusal: for a private repository, for one whose privacy is unknown, and what to do. */
export interface ExposureTexts {
  isPrivate: string;
  unknown: string;
  hint: string;
}

/**
 * A video that others can open, for a repository that is private or that cannot be told apart from one
 * (`repoIsPrivate` null or missing), unless publish.allowPublicForPrivateRepos allows it.
 */
export function exposureProblem(
  config: Config,
  exposed: boolean,
  repoIsPrivate: boolean | null,
  texts: ExposureTexts,
): MergeStoryError | null {
  if (!exposed || config.publish.allowPublicForPrivateRepos || repoIsPrivate === false) return null;
  return new MergeStoryError('PRIVACY_BLOCKED', repoIsPrivate === true ? texts.isPrivate : texts.unknown, {
    hint: texts.hint,
  });
}

/** A dry run never uploads, whoever calls the publisher. */
export function assertNotDryRun(ctx: Pick<RunContext, 'dryRun'>): void {
  if (ctx.dryRun) {
    throw new MergeStoryError('PUBLISH_FAILED', 'Uploads are switched off during a dry run.', {
      hint: 'Run again without dry-run mode to upload.',
    });
  }
}
