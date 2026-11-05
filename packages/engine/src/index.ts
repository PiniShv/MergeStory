/**
 * MergeStory as a library: turn a pull request or a local change into a short, accurate,
 * narrated video. `generate` is the main entry point; the rest is for callers that want to
 * run the stages on their own. Every export is listed by name, so what is public is what is
 * written here.
 */

// Stages
export type { EvidencePack, EvidencePackOptions } from './analyzer/index.ts';
export { analyze, buildEvidencePack } from './analyzer/index.ts';
// Errors, configuration and run context
export type {
  Config,
  ConfigInput,
  QualitySettings,
  ResolveConfigOptions,
  SecretName,
} from './core/config.ts';
export {
  ConfigSchema,
  configFromEnv,
  loadSecrets,
  mergeConfigInputs,
  QUALITY_PRESETS,
  readConfigFile,
  resolveConfig,
  SECRET_ENV_VARS,
  Secrets,
  USER_CONFIG_FILE,
} from './core/config.ts';
export type { CreateContextOptions, RunContext } from './core/context.ts';
export { createRunContext } from './core/context.ts';
export type { ErrorCode, MergeStoryErrorOptions } from './core/errors.ts';
export { EXIT_CODES, isMergeStoryError, MergeStoryError, toMergeStoryError } from './core/errors.ts';
export type { LogFormat, Logger, LoggerOptions, LogLevel } from './core/logger.ts';
export { createLogger, silentLogger } from './core/logger.ts';
// Data model and provider interfaces
export type {
  AssetUrls,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmUsage,
  LoadedSource,
  PublishBundle,
  PublishCheckContext,
  Publisher,
  PublishFile,
  PublishMeta,
  Renderer,
  RenderInput,
  RenderOutput,
  SourceInput,
  SourceProvider,
  TtsProvider,
  TtsRequest,
  TtsResult,
} from './core/providers.ts';
export type {
  ArchitectureResolved,
  BadgeKind,
  BeforeAfterResolved,
  BrowserResolved,
  BulletsResolved,
  ChecklistResolved,
  CodeLine,
  CodeResolved,
  CodeToken,
  FilesResolved,
  FlowResolved,
  MergeStoryRuntimeApi,
  MissionResolved,
  PlanCue,
  PlanMeta,
  PlannedScene,
  QualityPreset,
  RenderPlan,
  ResolvedCode,
  ResolvedImage,
  ResolvedPanel,
  ResolvedVisual,
  ScreenshotResolved,
  SeekResult,
  SummaryResolved,
  TerminalResolved,
  TextBeat,
  ThemeName,
  TitleResolved,
} from './core/render-plan.ts';
export type {
  CodeRefInput,
  NarrationLine,
  NodeKind,
  Panel,
  ReviewItem,
  Scene,
  SceneRole,
  Severity,
  Storyboard,
  TerminalLine,
  TransitionType,
  Visual,
  VisualType,
} from './core/storyboard-schema.ts';
// The storyboard contract
export {
  SIMULATED_VISUALS,
  STORYBOARD_LIMITS,
  STORYBOARD_VERSION,
  StoryboardSchema,
  storyboardJsonSchema,
  storyboardJsonSchemaForLlm,
} from './core/storyboard-schema.ts';
export type {
  Analysis,
  CaptionCue,
  ChangedFile,
  ChangeSet,
  ChangeSize,
  Chapter,
  CodeRef,
  CommitInfo,
  Component,
  ComponentKind,
  ContextInputs,
  CostReport,
  DependencyChange,
  DiffHunk,
  DiffLine,
  EgressContent,
  EgressRecord,
  EvidenceItem,
  EvidenceKind,
  FileInsight,
  FileRole,
  FileStatus,
  GenerateResult,
  GroundingSummary,
  KeyHunk,
  LinkedIssue,
  NarrationClip,
  NarrationResult,
  PlanResult,
  ProgressEvent,
  PublishResult,
  PullRequestInfo,
  Relationship,
  RepoContext,
  RepoInfo,
  RepoReader,
  RiskCategory,
  RiskSeverity,
  RiskSignal,
  ScreenshotInput,
  Side,
  StageName,
  SymbolChange,
  SymbolKind,
  TestEvidence,
  Timeline,
  TimelineBeat,
  TimelineScene,
  UsageRecord,
} from './core/types.ts';
// The pipeline
export type {
  AuthoringOptions,
  AuthoringResult,
  ContextOptions,
  GenerateHooks,
  GenerateOptions,
  PublishRunOptions,
} from './pipeline/index.ts';
export { checkStoryboard, generate, prepareAuthoring, publishRun } from './pipeline/index.ts';
// The HTTP API
export type { ServerHandle, StartServerOptions } from './server/index.ts';
export { startServer } from './server/index.ts';
export { createSourceProvider, detectSourceInput } from './sources/index.ts';
export type { IssueCode, ValidationDeps, ValidationIssue, ValidationResult } from './storyboard/index.ts';
export { heuristicStoryboard, validateStoryboard } from './storyboard/index.ts';
export { ENGINE_VERSION } from './version.ts';
