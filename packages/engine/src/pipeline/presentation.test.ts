import { describe, expect, it } from 'vitest';
import type { Storyboard } from '../core/storyboard-schema.ts';
import type { EvidenceItem } from '../core/types.ts';
import { buildPrComment, buildWatchPage } from '../publish/index.ts';
import { joinSources } from '../sources/join.ts';
import { orders, store } from '../testing/joined.ts';
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

  it('give a cited range of a log its own label, and leave out a range outside the log', () => {
    const { fx, storyboard } = setup();
    fx.analysis.evidence.push({
      id: 'L1',
      kind: 'log',
      label: 'Log: run.log',
      ref: null,
      url: null,
      lines: 30,
    });
    storyboard.scenes[0]!.narration[0]!.evidence = ['L1.20-24', 'L1.29-31', 'L1'];
    const watch = buildWatchPageData({
      storyboard,
      storyboardSource: 'agent',
      changeSet: fx.changeSet,
      analysis: fx.analysis,
      chapters: [{ title: 'Why', startSec: 0 }],
      durationSec: 90,
      generator: { llm: null, tts: 'none' },
      generatedAt: NOW,
      captionsBurnedIn: true,
    });
    expect(watch.claims[0]?.evidence.map((e) => e.label)).toEqual([
      'Log: run.log, lines 20 to 24',
      'Log: run.log',
    ]);
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
          shareUrl: 'https://media.example.com/v/index.html',
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

describe('the watch page of a change in several repositories', () => {
  it('has no link to the change, though each source has a pull request', async () => {
    const joined = joinSources([await orders(), await store()]);
    expect(joined.changeSet.parts?.every((p) => p.pr?.url)).toBe(true);
    const watch = buildWatchPageData({
      storyboard: makeStoryboard({ s1: ['The total is in cents.'] }),
      storyboardSource: 'agent',
      changeSet: joined.changeSet,
      analysis: joined.analysis,
      chapters: [{ title: 'Why', startSec: 0 }],
      durationSec: 90,
      generator: { llm: null, tts: 'none' },
      generatedAt: NOW,
      captionsBurnedIn: true,
    });
    expect(watch.changeUrl).toBeNull();
    // No single commit for the whole change: the page has no "Commit" row and no commit in its facts.
    expect(watch.headSha).toBe('');
    const page = buildWatchPage(watch, {
      video: 'https://media.example.com/v/video.mp4',
      poster: null,
      captions: null,
      linkExpiresAt: null,
    });
    expect(page).not.toContain('<dt>Commit</dt>');
    expect(page).not.toContain('<li>Commit');
  });

  it('keeps the head commit for one source', () => {
    const { fx, watch } = setup();
    expect(watch.headSha).toBe(fx.changeSet.head.sha);
    expect(watch.headSha).not.toBe('');
  });
});
