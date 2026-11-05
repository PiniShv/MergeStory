/** The options and results of the pipeline's entry points (see index.ts). */
import type { ConfigInput } from '../core/config.ts';
import type { Logger } from '../core/logger.ts';
import type { SourceInput } from '../core/providers.ts';
import type { ProgressEvent, ScreenshotInput, TestEvidence } from '../core/types.ts';

export interface ContextOptions {
  task?: string | null;
  notes?: string | null;
  tests?: Omit<TestEvidence, 'id'>[];
  screenshots?: Omit<ScreenshotInput, 'id'>[];
}

export interface GenerateOptions {
  /** PR URL, "owner/repo#123", a local repository path, or an explicit SourceInput. */
  source: string | SourceInput;
  /** Local sources only: base and head refs (defaults: merge base with the default branch, and HEAD). */
  base?: string | null;
  head?: string | null;
  context?: ContextOptions;
  /** Storyboard written by the caller (for example a coding agent). Validated like any other. */
  storyboard?: unknown;
  /** Highest-precedence config overrides (CLI flags, API input). */
  config?: ConfigInput;
  configPath?: string | null;
  /** Plan only: no paid calls, no rendering, no uploads, no GitHub writes. */
  dryRun?: boolean;
  runId?: string;
  signal?: AbortSignal;
  logger?: Logger;
}

export interface GenerateHooks {
  onProgress?: (event: ProgressEvent) => void;
}

export interface AuthoringResult {
  runId: string;
  runDir: string;
  files: {
    /** Machine-readable analysis. */
    analysis: string;
    /** The evidence pack: what the storyboard may cite. */
    evidence: string;
    /** How to write a grounded storyboard. */
    guide: string;
    /** JSON Schema of the storyboard. */
    schema: string;
  };
  summary: {
    title: string;
    changeLabel: string;
    size: string;
    files: number;
    suggestedDurationSec: number;
    evidenceItems: number;
  };
}

export interface AuthoringOptions extends Omit<GenerateOptions, 'storyboard' | 'dryRun'> {
  /** Write the files here instead of under the MergeStory home. */
  outDir?: string | null;
  /**
   * The source and the flags (task, notes, tests, screenshots, refs) of the command line, as raw
   * words. AUTHORING.md shows `validate` and `generate` with them, so the author's commands see the
   * same evidence ids as the analysis did. Without it the document says to repeat them.
   */
  followUp?: { source: string; args: string[] };
}

export interface PublishRunOptions {
  /** Run folder (runDir from a generate result) or run id. */
  run: string;
  /** Config overrides, typically publish.* and github.* (for example --publish s3 --comment). */
  config?: ConfigInput;
  configPath?: string | null;
  signal?: AbortSignal;
  logger?: Logger;
}
