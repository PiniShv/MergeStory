/** Builds the data for the watch page and the PR comment from a validated storyboard. */

import { isSimulated } from '../core/storyboard-facts.ts';
import type { Storyboard } from '../core/storyboard-schema.ts';
import { collapseLineRange } from '../core/text.ts';
import type { Analysis, ChangeSet, Chapter, CodeRef, PublishResult } from '../core/types.ts';
import type { CommentData, EvidenceLink, WatchPageData } from '../publish/index.ts';
import { ENGINE_VERSION } from '../version.ts';

export function changeLabel(changeSet: ChangeSet): string {
  return changeSet.pr ? `PR #${changeSet.pr.number}` : changeSet.head.ref;
}

export function repoLabel(changeSet: ChangeSet): string {
  return changeSet.repo.owner ? `${changeSet.repo.owner}/${changeSet.repo.name}` : changeSet.repo.name;
}

/** Link to a line range at the exact commit, when the repository has a known web URL. */
export function codeRefUrl(changeSet: ChangeSet, ref: CodeRef): string | null {
  if (!changeSet.repo.webUrl) return null;
  const sha = ref.side === 'head' ? changeSet.head.sha : changeSet.base.sha;
  const path = ref.path.split('/').map(encodeURIComponent).join('/');
  return `${changeSet.repo.webUrl}/blob/${sha}/${path}#L${ref.startLine}-L${ref.endLine}`;
}

function refLink(changeSet: ChangeSet, ref: CodeRef | null): EvidenceLink | null {
  if (!ref) return null;
  return {
    label: collapseLineRange(`${ref.path}:${ref.startLine}-${ref.endLine}`),
    url: codeRefUrl(changeSet, ref),
  };
}

function evidenceLinks(ids: string[], analysis: Analysis): EvidenceLink[] {
  const byId = new Map(analysis.evidence.map((e) => [e.id, e]));
  const links: EvidenceLink[] = [];
  for (const id of ids) {
    const item = byId.get(id);
    if (item) links.push({ label: collapseLineRange(item.label), url: item.url });
  }
  return links;
}

export function reviewChecklist(storyboard: Storyboard, changeSet: ChangeSet): WatchPageData['checklist'] {
  const fromBoard = storyboard.reviewChecklist.map((item) => ({
    title: item.title,
    detail: item.detail,
    severity: item.severity,
    ref: refLink(changeSet, item.ref),
  }));
  if (fromBoard.length > 0) return fromBoard;
  const items: WatchPageData['checklist'] = [];
  for (const scene of storyboard.scenes) {
    if (scene.visual.type !== 'checklist') continue;
    for (const item of scene.visual.items) {
      items.push({
        title: item.title,
        detail: item.detail,
        severity: item.severity,
        ref: refLink(changeSet, item.ref),
      });
    }
  }
  return items;
}

export interface PresentationInput {
  storyboard: Storyboard;
  storyboardSource: 'llm' | 'agent' | 'heuristic';
  changeSet: ChangeSet;
  analysis: Analysis;
  chapters: Chapter[];
  durationSec: number;
  generator: { llm: string | null; tts: string };
  generatedAt: string;
  /** true when the captions are drawn into the video, so the page's own caption track starts off. */
  captionsBurnedIn: boolean;
}

export function buildWatchPageData(input: PresentationInput): WatchPageData {
  const { storyboard, changeSet, analysis } = input;
  const claims: WatchPageData['claims'] = [];
  for (const scene of storyboard.scenes) {
    for (const line of scene.narration) {
      claims.push({
        chapter: scene.title,
        text: line.text,
        evidence: evidenceLinks(line.evidence, analysis),
      });
    }
  }
  const hasSimulated = storyboard.scenes.some((s) => isSimulated(s.visual));
  return {
    title: storyboard.title,
    summary: storyboard.summary,
    repoLabel: repoLabel(changeSet),
    changeLabel: changeLabel(changeSet),
    changeUrl: changeSet.pr?.url ?? null,
    headSha: changeSet.head.sha,
    durationSec: input.durationSec,
    chapters: input.chapters,
    checklist: reviewChecklist(storyboard, changeSet),
    claims,
    uncertainties: storyboard.uncertainties,
    storyboardSource: input.storyboardSource,
    generator: input.generator,
    hasSimulatedVisuals: hasSimulated,
    generatedAt: input.generatedAt,
    engineVersion: ENGINE_VERSION,
    captionsDefault: !input.captionsBurnedIn,
    language: storyboard.language,
  };
}

export function buildCommentData(watch: WatchPageData, publish: PublishResult, headSha: string): CommentData {
  return {
    title: watch.title,
    summary: watch.summary,
    watchUrl: publish.watchUrl ?? publish.videoUrl,
    posterUrl: publish.posterUrl,
    durationSec: watch.durationSec,
    chapters: watch.chapters,
    checklist: watch.checklist,
    headSha,
    linkExpiresAt: publish.expiresAt,
    visibility: publish.visibility,
    provider: publish.provider,
  };
}
