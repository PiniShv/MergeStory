/**
 * Provider interfaces. Each external capability sits behind one of these, so a new
 * LLM, speech engine, renderer or host can be added without touching the pipeline.
 */
import type { RunContext } from './context.ts';
import type { MergeStoryError } from './errors.ts';
import type { RenderPlan } from './render-plan.ts';
import type {
  CaptionCue,
  ChangeSet,
  EgressContent,
  EgressRecord,
  PublishResult,
  RepoReader,
} from './types.ts';

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export type SourceInput =
  | { kind: 'github'; url: string }
  | { kind: 'local'; repoPath: string; base: string | null; head: string | null };

export interface LoadedSource {
  changeSet: ChangeSet;
  /** Read-only access to file contents at base and head. */
  reader: RepoReader;
}

export interface SourceProvider {
  readonly id: 'github' | 'local';
  load(input: SourceInput, ctx: RunContext): Promise<LoadedSource>;
}

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

export interface LlmRequest {
  system: string;
  prompt: string;
  /** Short identifier for the schema, e.g. "storyboard". */
  schemaName: string;
  /** Sanitised JSON Schema (see storyboardJsonSchemaForLlm). */
  jsonSchema: Record<string, unknown>;
  maxOutputTokens: number;
  /** Earlier turns for repair attempts: the previous answer and the validation errors. */
  history?: { role: 'user' | 'assistant'; content: string }[];
}

/** Token counts of one call. inputTokens counts all input, including cached tokens; the cache fields are parts of it. */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface LlmResponse {
  /** Raw text of the answer (the JSON document). */
  text: string;
  /** Parsed JSON (not yet validated against the Zod schema). */
  json: unknown;
  usage: LlmUsage;
  model: string;
  stopReason: string | null;
}

export interface LlmProvider {
  /** "anthropic", "openai" or "openai-compatible". */
  readonly id: string;
  readonly model: string;
  /** Host that receives the prompt, for the egress report (e.g. "api.anthropic.com"). */
  readonly endpointHost: string;
  generateJson(request: LlmRequest, ctx: RunContext): Promise<LlmResponse>;
  /** Estimated USD for a call, from the price book; null when the price is unknown. */
  estimateCostUsd(inputTokens: number, outputTokens: number, ctx: RunContext): number | null;
}

// ---------------------------------------------------------------------------
// Speech
// ---------------------------------------------------------------------------

export interface TtsRequest {
  text: string;
  voice: string | null;
  language: string;
  speed: number;
}

export interface TtsResult {
  audio: Buffer;
  /** Container/encoding of `audio`. pcm_s16le is raw little-endian 16-bit samples. */
  format: 'wav' | 'mp3' | 'aiff' | 'pcm_s16le';
  sampleRate: number | null;
  channels: number | null;
  /** The characters that were spoken. */
  characters: number;
}

export interface TtsProvider {
  /** "kokoro", "say", "openai", "elevenlabs" or "none". */
  readonly id: string;
  /** true when synthesis runs on this machine (no data leaves it). */
  readonly local: boolean;
  /** false only for the silent provider: it makes no audio, so a run has captions only and estimated timing. */
  readonly speaks: boolean;
  /** The model that a run with this configuration speaks with, or null when the provider has no model name. */
  model(ctx: RunContext): string | null;
  /** The voice that a run speaks with: the configured one, else the provider's own choice (null = the system's). */
  voice(ctx: RunContext): Promise<string | null>;
  /**
   * Why this provider cannot speak in this run, as the error that choosing it reports, or null when it
   * can. It reads settings, secrets and this machine, and makes no network call.
   */
  unavailable(ctx: RunContext): Promise<MergeStoryError | null>;
  /**
   * Speaks one line. A paid provider records the cost of every request it sends in `ctx.cost` as soon
   * as the answer arrives, also when the line fails after it. The pipeline adds only the free parts
   * (cached lines and local speech).
   */
  synthesize(request: TtsRequest, ctx: RunContext): Promise<TtsResult>;
  /** What speaking this many characters costs, for the budget check before the first request. */
  estimateCostUsd(characters: number, ctx: RunContext): number;
  /** What a run with this provider would send, and where, for the dry-run plan. `characters` is the text to speak. */
  plannedEgress(ctx: RunContext, characters: number): Promise<EgressRecord[]>;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface RenderInput {
  plan: RenderPlan;
  /** Final mixed audio track (WAV), or null for a silent video. */
  audioPath: string | null;
  outDir: string;
  quality: 'draft' | 'standard' | 'high';
}

export interface RenderOutput {
  videoPath: string;
  /** Null when the poster frame could not be captured. */
  posterPath: string | null;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  frames: number;
  /** Frames reused because nothing changed on screen. */
  reusedFrames: number;
  sizeBytes: number;
}

export interface Renderer {
  readonly id: string;
  render(input: RenderInput, ctx: RunContext): Promise<RenderOutput>;
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

export interface PublishFile {
  /** Name inside the published folder, e.g. "video.mp4". */
  name: string;
  path: string;
}

/** Final URLs of the published assets, handed to the watch-page builder. */
export interface AssetUrls {
  video: string;
  poster: string | null;
  captions: string | null;
  /** When the links stop working (ISO timestamp), or null for links that do not expire. */
  linkExpiresAt: string | null;
  /**
   * The caption cues, for a page that is opened from disk: browsers refuse to load a separate caption
   * file next to such a page, so the page carries the cues itself.
   */
  captionCues?: CaptionCue[];
}

/**
 * What a publisher uploads. How it is shared (who may open the links, how long they last, where the
 * files go) comes from the settings, not from the bundle.
 */
export interface PublishBundle {
  files: PublishFile[];
  /** Builds the watch page HTML once the final asset URLs are known (presigned or public). */
  buildWatchPage: (urls: AssetUrls) => string;
  /** What the published files contain, for the egress report. */
  contains: EgressContent[];
  /** Privacy of the source repository (null = unknown, treated as private). Used by the privacy guard. */
  repoIsPrivate: boolean | null;
  /** Text for hosts that show a title and description next to the video (YouTube). */
  meta?: PublishMeta;
}

export interface PublishMeta {
  title: string;
  summary: string;
  language: string;
  /** Length of the video in seconds, as the renderer measured it. */
  durationSec: number;
  chapters: { title: string; startSec: number }[];
  checklist: { title: string; severity: 'info' | 'low' | 'medium' | 'high' }[];
  /** Pull request link; only included in public descriptions when the repository is public. */
  changeUrl: string | null;
  repoLabel: string;
  changeLabel: string;
  headSha: string;
  engineVersion: string;
}

/**
 * What a publisher needs to judge its settings before anything is uploaded. The settings themselves are
 * the config the publisher was built with.
 */
export type PublishCheckContext = Pick<RunContext, 'secrets' | 'redactor' | 'home'>;

export interface Publisher {
  readonly id: string;
  /**
   * The first problem that would stop publish(), as the error that publish() throws, or null when the
   * settings look usable. It reads settings and secrets and makes no network call, so a run can ask
   * before anything is rendered or spent. `repoIsPrivate` is the privacy of the source repository
   * (null = unknown, treated as private).
   */
  check(ctx: PublishCheckContext, repoIsPrivate: boolean | null): Promise<MergeStoryError | null>;
  /** What publish() would send, and where, for the dry-run plan. `estimatedBytes` is the size of the video. */
  plannedEgress(estimatedBytes: number): EgressRecord[];
  publish(bundle: PublishBundle, ctx: RunContext): Promise<PublishResult>;
}
