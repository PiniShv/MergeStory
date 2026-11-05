/** Types shared by the storyboard modules. They are re-exported from the module index. */
import type { EvidencePack } from '../analyzer/index.ts';
import type { Config } from '../core/config.ts';
import type { LlmProvider } from '../core/providers.ts';
import type { Storyboard } from '../core/storyboard-schema.ts';
import type { Analysis, ChangeSet, ContextInputs, RepoReader } from '../core/types.ts';

/** The stable machine codes of the problems the validator and the pipeline report. */
export type IssueCode =
  | 'schema'
  | 'invalid-json'
  | 'validator-failed'
  | 'too-few-scenes'
  | 'no-narration'
  | 'uncited-line'
  | 'empty-text'
  | 'url-in-text'
  | 'unverified-claim'
  | 'unknown-identifier'
  | 'secret-masked'
  | 'language-mismatch'
  | 'claims-english-only'
  | 'line-too-long'
  | 'code-ref-unknown-path'
  | 'code-ref-sensitive'
  | 'code-ref-binary'
  | 'code-ref-unreadable'
  | 'code-ref-out-of-range'
  | 'code-ref-missing'
  | 'diff-too-tall'
  | 'no-evidence'
  | 'visual-fallback'
  | 'screenshot-unknown'
  | 'simulated-unbacked'
  | 'over-length';

export interface ValidationIssue {
  /** Location in the storyboard, e.g. "scenes[2].visual.ref". */
  path: string;
  /** Stable machine code, e.g. "code-ref-out-of-range" or "unverified-claim". */
  code: IssueCode;
  message: string;
}

export interface ValidationResult {
  /** The storyboard after automatic fixes, or null when it cannot be used. */
  storyboard: Storyboard | null;
  /** Problems that block rendering. */
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  /** Human-readable list of automatic fixes that were applied. */
  fixes: string[];
  /** Narration lines that cite at least one valid evidence id. */
  groundedClaims: number;
}

export interface ValidationDeps {
  changeSet: ChangeSet;
  analysis: Analysis;
  inputs: ContextInputs;
  reader: RepoReader;
  config: Config;
  /** The storyboard is the offline one, written in English by MergeStory itself. */
  offline?: boolean;
}

export interface GenerateStoryboardInput {
  provider: LlmProvider;
  pack: EvidencePack;
  deps: ValidationDeps;
  targetSec: number;
}

export interface GenerateStoryboardOutput {
  storyboard: Storyboard;
  validation: ValidationResult;
  attempts: number;
  cached: boolean;
}
