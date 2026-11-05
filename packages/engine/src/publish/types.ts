/** Shared types and constants of the publish module. Re-exported from index.ts. */
import type { Chapter, EgressContent } from '../core/types.ts';

/** What a published bundle carries: the video, its captions and the watch page with title, summary and claims. */
export const BUNDLE_CONTAINS: readonly EgressContent[] = [
  'video',
  'narration-text',
  'storyboard',
  'pr-metadata',
];

/** First line of the pull request comment; used to find and update the comment later. */
export const COMMENT_MARKER = '<!-- mergestory:comment -->';
export const DESCRIPTION_START = '<!-- mergestory:start -->';
export const DESCRIPTION_END = '<!-- mergestory:end -->';

export interface EvidenceLink {
  label: string;
  /** http(s) link to the file at the head commit, or null when unknown. */
  url: string | null;
}

export interface WatchPageData {
  title: string;
  summary: string;
  repoLabel: string;
  changeLabel: string;
  /** Link to the pull request, when known. */
  changeUrl: string | null;
  headSha: string;
  durationSec: number;
  chapters: Chapter[];
  checklist: {
    title: string;
    detail: string;
    severity: 'info' | 'low' | 'medium' | 'high';
    ref: EvidenceLink | null;
  }[];
  /** Every narration line with the evidence it cites, grouped by chapter. */
  claims: { chapter: string; text: string; evidence: EvidenceLink[] }[];
  uncertainties: string[];
  storyboardSource: 'llm' | 'agent' | 'heuristic';
  generator: { llm: string | null; tts: string };
  /** true when the video contains simulated (illustrative) visuals. */
  hasSimulatedVisuals: boolean;
  generatedAt: string;
  engineVersion: string;
  /**
   * Whether the sidecar caption track is switched on when the page loads. Defaults to true.
   * Set it to false when the captions are already drawn into the video.
   */
  captionsDefault?: boolean;
  /** Language of the narration and captions as a BCP 47 code, for the caption track. Defaults to "en". */
  language?: string;
}

export interface CommentData {
  title: string;
  summary: string;
  watchUrl: string;
  posterUrl: string | null;
  durationSec: number;
  chapters: Chapter[];
  checklist: WatchPageData['checklist'];
  headSha: string;
  linkExpiresAt: string | null;
  visibility: 'public' | 'private' | 'protected' | 'unlisted';
  /** The publisher that made the link, such as "s3" or "youtube". */
  provider: string;
}
