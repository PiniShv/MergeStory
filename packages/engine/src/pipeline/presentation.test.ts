import { describe, expect, it } from 'vitest';
import type { Storyboard } from '../core/storyboard-schema.ts';
import type { EvidenceItem } from '../core/types.ts';
import { buildPrComment, buildWatchPage } from '../publish/index.ts';
import { makeStoryboard } from '../testing/narration.ts';
import { retryFixture } from '../testing/storyboard-fixtures.ts';
import { buildCommentData, buildWatchPageData, reviewChecklist } from './presentation.ts';

const NOW = '2026-11-04T10:00:00.000Z';

/** A storyboard whose review item and narration cite code on one line only. */
function storyboardWithOneLineRanges(evidenceId: string): Storyboard {
  const storyboard = makeStoryboard({ s1: ['The cap is four seconds.'] });
  storyboard.scenes[0]!.narration[0]!.evidence = [evidenceId];
  storyboard.reviewChecklist = [
    {
      title: 'Cap',
      detail: 'Check the cap.',
      severity: 'low',
      evidence: [],
      ref: { path: 'src/http/retry.ts', startLine: 8, endLine: 8, side: 'head' },
    },
    {
      title: 'Client',
      detail: 'Check the call.',
      severity: 'medium',
      evidence: [],
      ref: { path: 'src/http/client.ts', startLine: 10, endLine: 15, side: 'head' },
    },
  ];
  return storyboard;
}

function setup() {
  const fx = retryFixture();
  const symbol = fx.analysis.evidence.find((e) => e.kind === 'symbol') as EvidenceItem;
  const evidence: EvidenceItem = { ...symbol, id: 'S99', label: 'MAX_RETRIES (src/http/retry.ts:8-8)' };
  fx.analysis.evidence.push(evidence);
  const storyboard = storyboardWithOneLineRanges(evidence.id);
  const watch = buildWatchPageData({
    storyboard,
    storyboardSource: 'heuristic',
    changeSet: fx.changeSet,
    analysis: fx.analysis,
    chapters: [{ title: 'Why', startSec: 0 }],
    durationSec: 90,
    generator: { llm: null, tts: 'none' },
    generatedAt: NOW,
    captionsBurnedIn: true,
  });
  return { fx, storyboard, watch };
}

describe('labels of code references', () => {
  it('show a range of one line as that line, and keep real ranges', () => {
    const { watch } = setup();
    expect(watch.checklist.map((item) => item.ref?.label)).toEqual([
      'src/http/retry.ts:8',
      'src/http/client.ts:10-15',
    ]);
    expect(watch.claims[0]?.evidence.map((e) => e.label)).toEqual(['MAX_RETRIES (src/http/retry.ts:8)']);
  });

  it('are the same for the review checklist alone', () => {
    const { fx, storyboard } = setup();
    expect(reviewChecklist(storyboard, fx.changeSet).map((item) => item.ref?.label)).toEqual([
      'src/http/retry.ts:8',
      'src/http/client.ts:10-15',
    ]);
  });

  it('read the same on the watch page and in the pull request comment', () => {
    const { watch } = setup();
    const page = buildWatchPage(watch, {
      video: 'https://media.example.com/v/video.mp4',
      poster: null,
      captions: null,
      linkExpiresAt: null,
    });
    const comment = buildPrComment(
      buildCommentData(
        watch,
        {
          provider: 's3',
          watchUrl: 'https://media.example.com/v/index.html',
          videoUrl: 'https://media.example.com/v/video.mp4',
          posterUrl: null,
          captionsUrl: null,
          expiresAt: null,
          visibility: 'protected',
          location: 's3://media/v/',
        },
        watch.headSha,
      ),
    );
    for (const text of [page, comment]) {
      expect(text).toContain('src/http/retry.ts:8');
      expect(text).toContain('src/http/client.ts:10-15');
      expect(text).not.toContain('retry.ts:8-8');
    }
  });
});
