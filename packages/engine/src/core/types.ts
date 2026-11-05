/**
 * Shared data model for the MergeStory engine.
 *
 * Every module depends on these types. No type here depends on a module, so the
 * source, analyzer, storyboard, narration, render and publish layers stay loosely coupled.
 *
 * Evidence ids (used to ground every claim in a video):
 *   PR        pull request title and description      TASK   original task description
 *   NOTES     implementation notes from the agent      T<n>   test evidence supplied by the caller
 *   IS<n>     linked issue                             CM<n>  commit
 *   F<n>      changed file                             F<n>.H<m>  diff hunk in that file
 *   S<n>      changed symbol (function, class, ...)    M<n>   component (module)
 *   R<n>      review risk signal                       D<n>   dependency change
 *   SS<n>     screenshot supplied by the caller        REPO   repository structure context
 */

export type Side = 'base' | 'head';

/** A range of lines in one file at one side of the change. Lines are 1-based and inclusive. */
export interface CodeRef {
  path: string;
  side: Side;
  startLine: number;
  endLine: number;
}

// ---------------------------------------------------------------------------
// Change set: the normalised input produced by any source (GitHub PR, local git)
// ---------------------------------------------------------------------------

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx';
  text: string;
  /** Line number at base, null for added lines. */
  oldLine: number | null;
  /** Line number at head, null for deleted lines. */
  newLine: number | null;
}

export interface DiffHunk {
  /** Evidence id, e.g. "F2.H1". */
  id: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Text after the closing @@ marker, often the enclosing function signature. */
  header: string;
  lines: DiffLine[];
}

export interface ChangedFile {
  /** Evidence id, e.g. "F2". */
  id: string;
  /** Repo-relative POSIX path at head (at base for deleted files). */
  path: string;
  /** Previous path for renamed or copied files. */
  oldPath: string | null;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  /** Shiki language id guessed from the path, or null. */
  language: string | null;
  hunks: DiffHunk[];
  /** True when the source omitted the patch (for example, the diff was too large). */
  patchTruncated: boolean;
  /**
   * True when the path or the previous path is off limits: it matches a sensitive pattern (.env,
   * private keys, credentials) or `privacy.excludePaths`. The source sets it, and every later stage
   * reads it. Content of sensitive files is never shown in a video and never sent to any provider.
   */
  sensitive: boolean;
}

/** Commit metadata. Author names and emails are deliberately not collected. */
export interface CommitInfo {
  /** Evidence id, e.g. "CM1". */
  id: string;
  sha: string;
  subject: string;
  body: string;
}

export interface PullRequestInfo {
  number: number;
  title: string;
  body: string;
  url: string;
  /** Login of the author. It is never rendered. */
  author: string | null;
  baseRef: string;
  headRef: string;
  labels: string[];
  draft: boolean;
  state: 'open' | 'closed' | 'merged';
}

export interface RepoInfo {
  /** "github.com", a GitHub Enterprise host, or "local". */
  host: string;
  owner: string | null;
  name: string;
  /** null when unknown (for example, a local repository). */
  isPrivate: boolean | null;
  defaultBranch: string | null;
  /** Web URL used for file links (https://github.com/owner/name), or null when unknown. */
  webUrl: string | null;
}

export interface LinkedIssue {
  /** Evidence id, e.g. "IS1". */
  id: string;
  number: number;
  title: string;
  body: string;
  url: string;
}

export interface RepoContext {
  /** Directory and file paths near the top of the tree at head, capped. */
  tree: string[];
  treeTruncated: boolean;
  /** First part of the README at head, if any. */
  readmeExcerpt: string | null;
  /** Short excerpts of manifest files (package.json, go.mod, pyproject.toml, ...). */
  manifests: { path: string; excerpt: string }[];
}

export interface ChangeSet {
  source: 'github' | 'local';
  repo: RepoInfo;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
  pr: PullRequestInfo | null;
  linkedIssues: LinkedIssue[];
  commits: CommitInfo[];
  files: ChangedFile[];
  stats: { files: number; additions: number; deletions: number };
  /** Set when the source capped what it collected. */
  limits: { filesCapped: boolean; commitsCapped: boolean; note: string | null };
  repoContext: RepoContext;
}

/** Read-only access to file contents at the two sides of the change. Implementations never write. */
export interface RepoReader {
  /** Returns the file content, or null when the file does not exist at that side or is binary. */
  readFile(path: string, side: Side): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Optional context supplied by the calling agent or user
// ---------------------------------------------------------------------------

/** Test results reported by the caller. MergeStory never runs tests and never invents results. */
export interface TestEvidence {
  /** Evidence id, e.g. "T1". */
  id: string;
  command: string;
  passed: boolean;
  summary: string;
  source: 'agent' | 'ci' | 'user';
}

/** A real screenshot supplied by the caller. Rendered with an "actual screenshot" label. */
export interface ScreenshotInput {
  /** Evidence id, e.g. "SS1". */
  id: string;
  path: string;
  caption: string;
  moment: 'before' | 'after' | 'other';
}

export interface ContextInputs {
  /** Original task description, if known. */
  task: string | null;
  /** Implementation notes or design decisions from the agent or author. */
  notes: string | null;
  tests: TestEvidence[];
  screenshots: ScreenshotInput[];
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export type FileRole =
  | 'source'
  | 'test'
  | 'config'
  | 'docs'
  | 'build'
  | 'ci'
  | 'dependency-manifest'
  | 'lockfile'
  | 'generated'
  | 'asset'
  | 'migration'
  | 'other';

export type ComponentKind =
  | 'module'
  | 'package'
  | 'service'
  | 'ui'
  | 'api'
  | 'cli'
  | 'data'
  | 'tests'
  | 'docs'
  | 'config'
  | 'infra';

export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'constant'
  | 'component'
  | 'route'
  | 'other';

export interface SymbolChange {
  /** Evidence id, e.g. "S3". */
  id: string;
  name: string;
  kind: SymbolKind;
  change: 'added' | 'modified' | 'removed';
  fileId: string;
  path: string;
  side: Side;
  startLine: number;
  endLine: number;
  exported: boolean;
}

export interface FileInsight {
  fileId: string;
  path: string;
  role: FileRole;
  /** Component id (M<n>). */
  componentId: string;
  /**
   * True when the content of the file is off limits (`ChangedFile.sensitive`). The file keeps its path
   * and counts, but no hunk, symbol, dependency or risk is taken from it.
   */
  hidden: boolean;
  /** Trivial changes (formatting only, lockfiles, generated code, pure renames) are not explained in depth. */
  trivial: boolean;
  trivialReason: string | null;
  /** 0..1, higher means more worth explaining. */
  importance: number;
  symbolIds: string[];
}

export interface Component {
  /** Evidence id, e.g. "M2". */
  id: string;
  name: string;
  /** Directory that groups the component's files. */
  path: string;
  kind: ComponentKind;
  fileIds: string[];
  additions: number;
  deletions: number;
  status: 'added' | 'modified' | 'removed';
}

export interface Relationship {
  from: string; // component id
  to: string; // component id
  kind: 'imports' | 'tests' | 'configures';
  /** File id that shows the relationship. */
  evidence: string;
}

export interface KeyHunk {
  /** Hunk evidence id, e.g. "F2.H1". */
  id: string;
  fileId: string;
  path: string;
  side: Side;
  startLine: number;
  endLine: number;
  score: number;
  reasons: string[];
}

export type RiskSeverity = 'info' | 'low' | 'medium' | 'high';
export type RiskCategory =
  | 'security'
  | 'data'
  | 'migration'
  | 'concurrency'
  | 'error-handling'
  | 'public-api'
  | 'dependency'
  | 'config'
  | 'tests'
  | 'performance'
  | 'complexity';

export interface RiskSignal {
  /** Evidence id, e.g. "R1". */
  id: string;
  severity: RiskSeverity;
  category: RiskCategory;
  title: string;
  detail: string;
  /** Evidence ids (files, hunks, symbols) that triggered the signal. */
  evidence: string[];
  ref: CodeRef | null;
}

export interface DependencyChange {
  /** Evidence id, e.g. "D1". */
  id: string;
  ecosystem: 'npm' | 'pypi' | 'go' | 'cargo' | 'rubygems' | 'maven' | 'other';
  name: string;
  change: 'added' | 'removed' | 'updated';
  from: string | null;
  to: string | null;
  dev: boolean;
  fileId: string;
}

export type EvidenceKind =
  | 'pr'
  | 'task'
  | 'notes'
  | 'test'
  | 'issue'
  | 'commit'
  | 'file'
  | 'hunk'
  | 'symbol'
  | 'component'
  | 'risk'
  | 'dependency'
  | 'screenshot'
  | 'repo';

/** One citable fact. Storyboards may only cite ids that exist in the evidence index. */
export interface EvidenceItem {
  id: string;
  kind: EvidenceKind;
  /** Short human-readable label, e.g. "src/retry.ts:12-40" or "PR description". */
  label: string;
  ref: CodeRef | null;
  /** Web link (file at commit with line anchors), when known. */
  url: string | null;
}

export type ChangeSize = 'xs' | 's' | 'm' | 'l' | 'xl';

export interface Analysis {
  version: 1;
  size: ChangeSize;
  /** Weighted size used for pacing: meaningful changed lines after trivial files are removed. */
  meaningfulLines: number;
  files: FileInsight[];
  components: Component[];
  relationships: Relationship[];
  symbols: SymbolChange[];
  keyHunks: KeyHunk[];
  risks: RiskSignal[];
  dependencies: DependencyChange[];
  tests: { added: string[]; modified: string[]; removed: string[] };
  languages: { language: string; files: number }[];
  /** Factual one-liners derived from the diff, e.g. "New module src/retry/". */
  architectureSignals: string[];
  /** Adaptive target length for the video, before the configured maximum is applied. */
  suggestedDurationSec: number;
  evidence: EvidenceItem[];
}

// ---------------------------------------------------------------------------
// Narration and timeline
// ---------------------------------------------------------------------------

export interface NarrationClip {
  sceneId: string;
  beatIndex: number;
  /** Text as shown in captions. */
  text: string;
  /** Text as sent to the speech provider (identifiers split, markup removed). */
  spokenText: string;
  /** Mono 48 kHz 16-bit WAV, or null for the silent provider. */
  audioPath: string | null;
  durationSec: number;
  cached: boolean;
}

export interface NarrationResult {
  provider: string;
  voice: string | null;
  clips: NarrationClip[];
}

export interface TimelineBeat {
  index: number;
  startSec: number;
  durationSec: number;
}

export interface TimelineScene {
  sceneId: string;
  startSec: number;
  durationSec: number;
  /** Length of the transition into this scene (overlaps the previous scene). */
  transitionSec: number;
  beats: TimelineBeat[];
}

export interface Timeline {
  /** Total length, including the branded end card. */
  durationSec: number;
  scenes: TimelineScene[];
  /** Branded end card after the last scene (overlaps it by a short transition). */
  outro: { startSec: number; durationSec: number };
}

export interface CaptionCue {
  startSec: number;
  endSec: number;
  text: string;
}

// ---------------------------------------------------------------------------
// Cost and data egress
// ---------------------------------------------------------------------------

export interface UsageRecord {
  provider: string;
  kind: 'llm' | 'tts' | 'storage' | 'other';
  model: string | null;
  inputTokens?: number;
  outputTokens?: number;
  characters?: number;
  bytes?: number;
  costUsd: number;
  /** true when the cost is an estimate (price table) rather than a billed amount. */
  estimated: boolean;
  cached?: boolean;
}

export interface CostReport {
  totalUsd: number;
  budgetUsd: number;
  records: UsageRecord[];
}

export type EgressContent =
  | 'diff'
  | 'code-context'
  | 'pr-metadata'
  | 'narration-text'
  | 'video'
  | 'storyboard'
  | 'comment';

/** One outbound transfer. Lets users see exactly what left the machine and where it went. */
export interface EgressRecord {
  /** Host name only, never a full URL with credentials or signatures. */
  destination: string;
  purpose: string;
  bytes: number;
  contains: EgressContent[];
}

// ---------------------------------------------------------------------------
// Publishing and results
// ---------------------------------------------------------------------------

export interface PublishResult {
  provider: string;
  /** Shareable page with the player, chapters and review checklist. */
  watchUrl: string | null;
  videoUrl: string;
  posterUrl: string | null;
  captionsUrl: string | null;
  /** ISO timestamp when presigned links stop working, or null for permanent links. */
  expiresAt: string | null;
  /** "unlisted" is YouTube's link-only mode; "protected" is a permanent link behind an access proxy. */
  visibility: 'public' | 'private' | 'protected' | 'unlisted';
  /** Storage location without secrets, e.g. "s3://bucket/prefix/". */
  location: string;
}

export type StageName =
  | 'source'
  | 'analyze'
  | 'storyboard'
  | 'validate'
  | 'narrate'
  | 'visuals'
  | 'render'
  | 'publish'
  | 'notify';

export interface ProgressEvent {
  stage: StageName;
  status: 'start' | 'progress' | 'done' | 'skip' | 'warn';
  /** 0..1 within the stage, when known. */
  progress?: number;
  message: string;
}

export interface Chapter {
  title: string;
  startSec: number;
}

export interface GroundingSummary {
  /** Narration lines that cite evidence. */
  groundedClaims: number;
  /** Problems found and fixed automatically (clamped ranges, removed claims, ...). */
  fixes: string[];
  warnings: string[];
}

export interface GenerateResult {
  ok: true;
  runId: string;
  runDir: string;
  title: string;
  summary: string;
  durationSec: number;
  chapters: Chapter[];
  storyboardSource: 'llm' | 'agent' | 'heuristic';
  files: {
    video: string;
    poster: string | null;
    captions: string;
    storyboard: string;
    watchPage: string;
  };
  publish: PublishResult | null;
  notify: { commentUrl: string | null; descriptionUpdated: boolean } | null;
  grounding: GroundingSummary;
  cost: CostReport;
  egress: EgressRecord[];
  warnings: string[];
}

/** Result of a dry run: everything that would happen, with no paid calls and no uploads. */
export interface PlanResult {
  ok: true;
  dryRun: true;
  runId: string;
  runDir: string;
  title: string;
  storyboardSource: 'llm' | 'agent' | 'heuristic';
  estimatedDurationSec: number;
  scenes: { id: string; role: string; title: string; visual: string }[];
  providers: { llm: string; tts: string; publish: string };
  estimatedCost: CostReport;
  /** What a real run would send, and to where. */
  plannedEgress: EgressRecord[];
  warnings: string[];
}
