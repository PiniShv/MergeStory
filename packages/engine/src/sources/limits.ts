/** Size limits shared by the sources. They keep a change set small enough to analyse quickly. */

export interface SourceLimits {
  /** Most changed files listed in a change set (GitHub itself stops at 3000). */
  maxFiles: number;
  /** Most files that keep their code hunks. The files with the most changed lines win. */
  maxHunkFiles: number;
  /** A file with more changed lines than this keeps its counts but no hunks. */
  maxFilePatchLines: number;
  /** Budget of changed lines across all kept hunks. */
  maxTotalPatchLines: number;
  /** Most commits listed. */
  maxCommits: number;
}

export const DEFAULT_SOURCE_LIMITS: SourceLimits = {
  maxFiles: 3000,
  maxHunkFiles: 300,
  maxFilePatchLines: 5000,
  maxTotalPatchLines: 60_000,
  maxCommits: 250,
};

/** Largest file the readers return (1 MiB). Bigger files read as "not available". */
export const MAX_READ_BYTES = 1024 * 1024;

/** Repository context caps. */
export const REPO_TREE_MAX_ENTRIES = 200;
export const README_MAX_LINES = 60;
export const README_MAX_CHARS = 4096;
export const MANIFEST_MAX_CHARS = 1536;

/** Linked issues. */
export const MAX_LINKED_ISSUES = 3;
export const ISSUE_BODY_MAX_CHARS = 4096;

/** Per-commit text caps, so one huge message cannot dominate a change set. */
export const COMMIT_SUBJECT_MAX_CHARS = 500;
export const COMMIT_BODY_MAX_CHARS = 2000;
