import { describe, expect, it } from 'vitest';
import type { CostReport, GenerateResult, PublishResult } from '../core/types.ts';
import type { JobSummary, PublicJob } from '../jobs/view.ts';
import type { AuthoringResult } from '../pipeline/index.ts';
import {
  formatAuthoring,
  formatCost,
  formatDuration,
  formatEgress,
  formatError,
  formatGenerateResult,
  formatJob,
  formatJobList,
  formatRows,
  formatUsd,
} from './format.ts';
import { colorEnabled, createStyle } from './style.ts';

const plain = createStyle(false);

describe('formatGenerateResult: where the video went', () => {
  const result = (publish: PublishResult | null): GenerateResult => ({
    ok: true,
    runId: '20261104-101500-a1b2',
    runDir: '/runs/a',
    title: 'Add retries',
    summary: 'Retries.',
    durationSec: 60,
    chapters: [],
    storyboardSource: 'heuristic',
    files: {
      video: '/runs/a/video.mp4',
      poster: '/runs/a/poster.jpg',
      captions: '/runs/a/captions.vtt',
      storyboard: '/runs/a/storyboard.json',
      watchPage: '/runs/a/watch/index.html',
    },
    publish,
    notify: null,
    grounding: { groundedClaims: 3, fixes: [], warnings: [] },
    cost: { totalUsd: 0, budgetUsd: 0.25, records: [] },
    egress: [],
    warnings: [],
  });
  const published = (overrides: Partial<PublishResult>): PublishResult => ({
    provider: 'local',
    watchUrl: 'file:///runs/a/publish/index.html',
    videoUrl: 'file:///runs/a/publish/video.mp4',
    posterUrl: null,
    captionsUrl: null,
    expiresAt: null,
    visibility: 'private',
    location: 'file:///runs/a/publish/',
    ...overrides,
  });

  it('says that a link to a local file is saved on this machine, not shared', () => {
    const text = formatGenerateResult(result(published({})), plain);
    expect(text).toMatch(/Saved +file:\/\/\/runs\/a\/publish\/index\.html {2}\(saved on this machine\)/);
    expect(text).not.toContain('Shared');
    expect(text).not.toContain('(private');
  });

  it('shows a link that others can open as shared, with its access', () => {
    const text = formatGenerateResult(
      result(published({ provider: 's3', watchUrl: 'https://videos.example.com/v/index.html' })),
      plain,
    );
    expect(text).toMatch(/Shared +https:\/\/videos\.example\.com\/v\/index\.html {2}\(private\)/);
  });

  it('says how long the run took, and nothing for a result from 1.0.0', () => {
    expect(formatGenerateResult({ ...result(null), elapsedSec: 92.4 }, plain)).toMatch(/Made in +1m 32s/);
    expect(formatGenerateResult({ ...result(null), elapsedSec: 45 }, plain)).toMatch(/Made in +45s/);
    expect(formatGenerateResult(result(null), plain)).not.toContain('Made in');
  });

  it('shows neither row when nothing was published', () => {
    const text = formatGenerateResult(result(null), plain);
    expect(text).not.toMatch(/Shared|Saved/);
  });
});

describe('formatDuration', () => {
  it('uses m:ss, and h:mm:ss from an hour', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(5)).toBe('0:05');
    expect(formatDuration(59)).toBe('0:59');
    expect(formatDuration(61)).toBe('1:01');
    expect(formatDuration(83.6)).toBe('1:24');
    expect(formatDuration(600)).toBe('10:00');
    expect(formatDuration(3600)).toBe('1:00:00');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatDuration(-4)).toBe('0:00');
  });
});

describe('formatCost', () => {
  const record = (kind: 'llm' | 'tts' | 'storage' | 'other', costUsd: number, estimated = false) => ({
    provider: 'p',
    kind,
    model: null,
    costUsd,
    estimated,
  });

  it('splits the total into LLM and speech', () => {
    const cost: CostReport = {
      totalUsd: 0.0042,
      budgetUsd: 0.25,
      records: [record('llm', 0.004), record('tts', 0.0002)],
    };
    expect(formatCost(cost)).toBe(
      '$0.0042 (LLM $0.0040, speech $0.0002), budget $0.25; your coding agent, storage and CI are billed separately',
    );
  });

  it('shows zero costs as zero', () => {
    expect(formatCost({ totalUsd: 0, budgetUsd: 0.25, records: [] })).toBe(
      '$0.0000 (LLM $0.0000, speech $0.0000), budget $0.25; your coding agent, storage and CI are billed separately',
    );
  });

  it('adds other costs and says when prices are estimates', () => {
    const cost: CostReport = {
      totalUsd: 0.0105,
      budgetUsd: 1,
      records: [record('llm', 0.01, true), record('storage', 0.0005), record('other', 0)],
    };
    expect(formatCost(cost)).toBe(
      '$0.0105 (LLM $0.0100, speech $0.0000, other $0.0005), estimated from list prices, budget $1.00; your coding agent, storage and CI are billed separately',
    );
  });

  it('says when a model with no known price was counted at an assumed rate', () => {
    const cost: CostReport = {
      totalUsd: 0.02,
      budgetUsd: 1,
      records: [{ ...record('llm', 0.02, true), priceNote: 'assumed' }],
    };
    expect(formatCost(cost)).toBe(
      '$0.0200 (LLM $0.0200, speech $0.0000), estimated; includes an assumed rate for a model with no known price, budget $1.00; your coding agent, storage and CI are billed separately',
    );
  });

  it('says when a model server on this machine or your network was counted as $0', () => {
    const cost: CostReport = {
      totalUsd: 0,
      budgetUsd: 1,
      records: [{ ...record('llm', 0, true), priceNote: 'local' }],
    };
    expect(formatCost(cost)).toBe(
      '$0.0000 (LLM $0.0000, speech $0.0000), a model server on this machine or your network counted as $0, budget $1.00; your coding agent, storage and CI are billed separately',
    );
  });

  it('does not call a zero cost an estimate', () => {
    expect(formatCost({ totalUsd: 0, budgetUsd: 0.25, records: [record('llm', 0, true)] })).not.toContain(
      'estimated',
    );
    expect(formatUsd(1.23456)).toBe('$1.2346');
    expect(formatUsd(0.25, 2)).toBe('$0.25');
  });
});

describe('formatEgress', () => {
  it('names the host, the purpose, the size and what was in it', () => {
    expect(
      formatEgress({
        destination: 'api.anthropic.com',
        purpose: 'storyboard',
        bytes: 2048,
        contains: ['diff', 'pr-metadata'],
      }),
    ).toBe('api.anthropic.com: storyboard, 2 KB (diff, pr-metadata)');
    expect(
      formatEgress({
        destination: 's3.example.com',
        purpose: 'upload',
        bytes: 12 * 1024 * 1024,
        contains: [],
      }),
    ).toBe('s3.example.com: upload, 12 MB');
  });
});

describe('formatRows', () => {
  it('aligns the values and skips empty rows', () => {
    const lines = formatRows(
      [
        ['Video', '/a/b.mp4'],
        ['Warnings', null],
        ['Length', '1:23'],
        ['Empty', ''],
        ['List', ['one', 'two']],
        ['None', []],
      ],
      plain,
    );
    expect(lines).toEqual(['  Video   /a/b.mp4', '  Length  1:23', '  List    one', '          two']);
  });
});

describe('formatJob', () => {
  const base: PublicJob = {
    id: '20261103-214501-a3f9',
    status: 'running',
    createdAt: '2026-11-03T21:45:01.000Z',
    updatedAt: '2026-11-03T21:45:30.000Z',
    startedAt: '2026-11-03T21:45:02.000Z',
    finishedAt: null,
    options: {},
    progress: { stage: 'render', message: 'Rendering frames', progress: 0.456 },
    result: null,
    error: null,
  };

  it('shows the stage, percent and times of a running job', () => {
    const text = formatJob(base, plain);
    expect(text).toContain('Job 20261103-214501-a3f9: running');
    expect(text).toContain('render 46%');
    expect(text).toContain('Rendering frames');
    expect(text).toContain('2026-11-03 21:45:01 UTC');
    expect(text).not.toContain('Finished');
  });

  it('shows the error and its hint for a failed job', () => {
    const text = formatJob(
      {
        ...base,
        status: 'failed',
        finishedAt: '2026-11-03T21:46:00.000Z',
        error: { code: 'LLM_FAILED', message: 'No key.', hint: 'Set ANTHROPIC_API_KEY.' },
      },
      plain,
    );
    expect(text).toContain('[LLM_FAILED] No key.');
    expect(text).toContain('Set ANTHROPIC_API_KEY.');
    expect(text).not.toContain('Rendering frames');
  });
});

describe('formatJobList', () => {
  it('prints one aligned row per job', () => {
    const jobs: JobSummary[] = [
      {
        id: '20261103-214501-a3f9',
        status: 'running',
        createdAt: '2026-11-03T21:45:01.000Z',
        updatedAt: '2026-11-03T21:45:01.000Z',
        progress: { stage: 'analyze', message: '', progress: null },
        title: null,
        error: null,
      },
      {
        id: '20261102-100000-b4c2',
        status: 'failed',
        createdAt: '2026-11-02T10:00:00.000Z',
        updatedAt: '2026-11-02T10:00:00.000Z',
        progress: { stage: 'render', message: '', progress: 1 },
        title: null,
        error: { code: 'RENDER_FAILED', message: 'x'.repeat(200), hint: null },
      },
    ];
    const lines = formatJobList(jobs, plain).trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^ID\s+STATUS\s+STAGE\s+CREATED\s+TITLE OR ERROR$/);
    expect(lines[1]).toContain('running');
    expect(lines[1]).toContain('analyze');
    expect(lines[2]).toContain('[RENDER_FAILED]');
    expect(lines[2]).toContain('...');
    expect(lines[2]?.length).toBeLessThan(160);
  });
});

describe('colors', () => {
  it('are used on a terminal only, and never with NO_COLOR', () => {
    expect(colorEnabled(true, {})).toBe(true);
    expect(colorEnabled(false, {})).toBe(false);
    expect(colorEnabled(true, { NO_COLOR: '1' })).toBe(false);
    expect(colorEnabled(true, { TERM: 'dumb' })).toBe(false);
    expect(colorEnabled(false, { FORCE_COLOR: '1' })).toBe(true);
    expect(colorEnabled(true, { FORCE_COLOR: '0' })).toBe(true);
    expect(createStyle(false).red('x')).toBe('x');
    expect(createStyle(true).red('x')).toBe('\u001b[31mx\u001b[39m');
  });
});

describe('untrusted text in the output', () => {
  // A commit subject or PR title that tries to set the clipboard (OSC 52), move the cursor and
  // reverse the text that follows.
  const hostile = 'Add retry \u001b]52;c;aGVsbG8=\u0007logic\u001b[2A\r\u202eevil\u009b';
  const authoring: AuthoringResult = {
    runId: 'r1',
    runDir: '/runs/r1',
    files: { analysis: 'a.json', evidence: 'e.md', guide: 'g.md', schema: 's.json' },
    summary: {
      title: hostile,
      changeLabel: 'main...feature',
      size: 'small',
      files: 2,
      suggestedDurationSec: 60,
      evidenceItems: 5,
    },
  };
  const controls = /(?![\t\n])\p{Cc}|[\u202a-\u202e\u2066-\u2069]/u;

  it('loses its control characters, while the styling stays', () => {
    const text = formatAuthoring(authoring, { source: '.' }, plain);
    expect(text).toContain('Analysis ready: Add retry ]52;c;aGVsbG8=logic[2Aevil');
    expect(text).not.toMatch(controls);
    const styled = formatAuthoring(authoring, { source: '.' }, createStyle(true));
    expect(styled).toContain('\u001b[32mAnalysis ready\u001b[39m: Add retry ]52;c;aGVsbG8=logic');
    expect(styled).not.toContain('\u001b]');
  });

  it('is cleaned in jobs, rows and errors too', () => {
    const job: PublicJob = {
      id: 'j1',
      status: 'failed',
      createdAt: '2026-11-03T21:45:01.000Z',
      updatedAt: '2026-11-03T21:45:01.000Z',
      startedAt: null,
      finishedAt: null,
      options: {},
      progress: { stage: 'analyze', message: hostile, progress: null },
      result: null,
      error: { code: 'GIT_FAILED', message: hostile, hint: hostile },
    };
    const summary: JobSummary = { ...job, title: hostile };
    for (const text of [
      formatJob(job, plain),
      formatJobList([summary], plain),
      formatRows([['Title', hostile]], plain).join('\n'),
      formatError({ code: 'GIT_FAILED', message: hostile, hint: hostile, exitCode: 1 }, plain),
    ]) {
      expect(text).toContain('Add retry');
      expect(text).not.toMatch(controls);
    }
  });

  it('keeps line breaks and tabs', () => {
    expect(formatRows([['Notes', 'one\ttwo\nthree']], plain)).toEqual(['  Notes  one\ttwo\nthree']);
  });
});
