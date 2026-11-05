/**
 * The PR analyzer: classifies files, groups components, finds changed symbols, ranks hunks,
 * flags review risks and builds the evidence index every storyboard claim must cite.
 * It only reports what the diff and the repository show.
 */
import { type Config, DURATION_LIMITS } from '../core/config.ts';
import type { Analysis } from '../core/types.ts';

export { analyze } from './analyze.ts';
export { hunkRange } from './hunks.ts';
export type { EvidencePack, EvidencePackOptions } from './pack.ts';
export { buildEvidencePack } from './pack.ts';
export { detectRole } from './roles.ts';

/** Target video length: the configured target, else the analysis suggestion, capped by maxDurationSec. */
export function targetDuration(
  analysis: Analysis,
  config: Pick<Config, 'targetDurationSec' | 'maxDurationSec'>,
): number {
  const wanted = config.targetDurationSec ?? analysis.suggestedDurationSec;
  return Math.max(DURATION_LIMITS.targetDurationSec.min, Math.min(config.maxDurationSec, wanted));
}
