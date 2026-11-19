/** The sections of the evidence pack that come from the caller are written once, however many sources there are. */
import { describe, expect, it } from 'vitest';
import { joinSources } from '../sources/join.ts';
import { emptyInputs } from '../testing/change.ts';
import { orders, store } from '../testing/joined.ts';
import { buildEvidencePack, type EvidencePackOptions } from './pack.ts';

const OPTIONS: EvidencePackOptions = {
  maxTokens: 24_000,
  llmContext: 'full',
  targetDurationSec: 70,
  style: 'hybrid',
  language: 'en',
};

const inputs = emptyInputs({
  task: 'Fix the total',
  screenshots: [
    {
      id: 'SS1',
      path: '/tmp/x.png',
      caption: 'The page',
      moment: 'after',
      hidden: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }],
    },
  ],
  repro: {
    title: 'The total is wrong',
    environment: null,
    steps: [{ text: 'Open the basket', screenshotId: 'SS1', recordingId: null, result: 'bug' }],
  },
  logs: [
    { id: 'L1', path: '/tmp/x.log', caption: 'Test run', lines: ['start', 'Error: total is NaN', 'end'] },
  ],
});

describe('the pack of two sources with a reproduction, a log and a hidden region', () => {
  it('writes each of those sections once, after the sections of the sources', async () => {
    const { changeSet, analysis } = joinSources([await orders(), await store()]);
    const { markdown } = buildEvidencePack(changeSet, analysis, inputs, OPTIONS);
    for (const heading of ['## Reproduction', '## Available screenshots', '## Available logs']) {
      expect(markdown.split(heading).length - 1, heading).toBe(1);
    }
    expect(markdown).toContain('REPRO.1');
    expect(markdown).toContain('parts hidden');
    expect(markdown).toContain('L1');
    // The sections of the sources come first, then the ones of the run, then the code.
    const at = (text: string) => markdown.indexOf(text);
    expect(at('## Commits (source B)')).toBeLessThan(at('## Components'));
    expect(at('## Reproduction')).toBeLessThan(at('## Commits (source A)'));
    expect(at('## Available screenshots')).toBeGreaterThan(at('## Components'));
    expect(at('## Available logs')).toBeGreaterThan(at('## Components'));
    // Ids of the caller keep their names, ids of a repository have a letter.
    expect(markdown).not.toMatch(/\b[AB]\.(?:REPRO|L1|SS1)/);
    expect(markdown).toContain('A.F1');
  });
});
