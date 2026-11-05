import { describe, expect, it } from 'vitest';
import type { GenerateResult, PlanResult } from '../core/types.ts';
import type { Job } from './model.ts';
import { maskContext, publicJob, redactResult, summarizeJob } from './view.ts';

const KEY = `sk-ant-${'Qw3Er5Ty7Ui9Op1A'.repeat(2)}`;

function result(overrides: Partial<GenerateResult> = {}): GenerateResult {
  return {
    ok: true,
    runId: 'r1',
    runDir: '/runs/r1',
    title: 'Add retries',
    summary: 'Adds retries.',
    durationSec: 60,
    chapters: [],
    storyboardSource: 'llm',
    files: { video: 'v', poster: 'p', captions: 'c', storyboard: 's', watchPage: 'w' },
    publish: null,
    notify: null,
    grounding: { groundedClaims: 1, fixes: [], warnings: [] },
    cost: {
      totalUsd: 0.01,
      budgetUsd: 0.25,
      records: [
        {
          provider: 'anthropic',
          kind: 'llm',
          model: 'claude-haiku-5-5',
          inputTokens: 1200,
          outputTokens: 800,
          costUsd: 0.01,
          estimated: true,
        },
      ],
    },
    egress: [],
    warnings: [],
    ...overrides,
  };
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    version: 1,
    id: '20261103-214501-a3f9',
    status: 'succeeded',
    createdAt: '2026-11-03T21:45:01.000Z',
    updatedAt: '2026-11-03T21:46:01.000Z',
    startedAt: '2026-11-03T21:45:02.000Z',
    finishedAt: '2026-11-03T21:46:01.000Z',
    pid: 4242,
    options: { source: 'acme/app#1' },
    progress: { stage: 'notify', message: 'Finished', progress: 1 },
    result: null,
    error: null,
    ...overrides,
  };
}

describe('redactResult', () => {
  it('removes secrets from every string but keeps token counts', () => {
    const redacted = redactResult(result({ title: `Rotate ${KEY}`, warnings: [`saw ${KEY}`] }));
    expect(JSON.stringify(redacted)).not.toContain(KEY);
    expect(redacted.cost.records[0]?.inputTokens).toBe(1200);
    expect(redacted.cost.records[0]?.outputTokens).toBe(800);
    expect(redacted.cost.totalUsd).toBe(0.01);
  });

  it('keeps the links to the published video, signature included', () => {
    const link =
      'https://files.example.com/v/abc/video.mp4?X-Amz-Signature=0123456789abcdef&X-Amz-Expires=3600';
    const redacted = redactResult(
      result({
        publish: {
          provider: 's3',
          watchUrl: 'https://files.example.com/v/abc/index.html?X-Amz-Signature=fedcba9876543210',
          videoUrl: link,
          posterUrl: null,
          captionsUrl: 'https://files.example.com/v/abc/captions.vtt?sig=abcdef0123456789',
          expiresAt: '2026-11-10T00:00:00Z',
          visibility: 'private',
          location: 's3://bucket/prefix/',
        },
      }),
    );
    expect(redacted.publish?.videoUrl).toBe(link);
    expect(redacted.publish?.watchUrl).toContain('X-Amz-Signature=fedcba9876543210');
    expect(redacted.publish?.captionsUrl).toContain('sig=abcdef0123456789');
    expect(redacted.publish?.posterUrl).toBeNull();
  });

  it('still removes a password from a link', () => {
    const redacted = redactResult(
      result({
        publish: {
          provider: 'local',
          watchUrl: null,
          videoUrl: 'https://user:hunter2hunter2@files.example.com/video.mp4',
          posterUrl: null,
          captionsUrl: null,
          expiresAt: null,
          visibility: 'public',
          location: '/runs',
        },
      }),
    );
    expect(redacted.publish?.videoUrl).toBe('https://files.example.com/video.mp4');
  });

  it('handles a plan, which has no publish section', () => {
    const plan: PlanResult = {
      ok: true,
      dryRun: true,
      runId: 'r',
      runDir: '/r',
      title: `Plan ${KEY}`,
      storyboardSource: 'heuristic',
      estimatedDurationSec: 60,
      scenes: [],
      providers: { llm: 'none', tts: 'none', publish: 'local' },
      estimatedCost: { totalUsd: 0, budgetUsd: 0.25, records: [] },
      plannedEgress: [],
      warnings: [],
    };
    expect(JSON.stringify(redactResult(plan))).not.toContain(KEY);
  });

  it('does not change the result it was given', () => {
    const original = result({ title: `Rotate ${KEY}` });
    redactResult(original);
    expect(original.title).toContain(KEY);
  });
});

describe('publicJob', () => {
  it('leaves out the process id and the body of the storyboard', () => {
    const view = publicJob(
      job({ options: { source: 'acme/app#1', storyboard: { scenes: ['x'.repeat(1000)] } } }),
    );
    expect('pid' in view).toBe(false);
    expect(view.options.storyboard).toBe('[provided]');
    expect(view.options.source).toBe('acme/app#1');
    expect(JSON.stringify(view)).not.toContain('xxxxxxxx');
  });

  it('does not add a storyboard field when there was none', () => {
    expect('storyboard' in publicJob(job()).options).toBe(false);
  });

  it('redacts secrets in the options, progress, result and error', () => {
    const view = publicJob(
      job({
        options: { source: 'acme/app#1', context: { task: `use ${KEY}` } },
        progress: { stage: 'publish', message: `uploading with ${KEY}`, progress: null },
        result: result({ title: `T ${KEY}` }),
        error: { code: 'LLM_FAILED', message: `bad key ${KEY}`, hint: `check ${KEY}` },
      }),
    );
    expect(JSON.stringify(view)).not.toContain(KEY);
  });
});

describe('summarizeJob', () => {
  it('shows the title of a finished video', () => {
    const summary = summarizeJob(job({ result: result() }));
    expect(summary.title).toBe('Add retries');
    expect(summary.error).toBeNull();
    expect(Object.keys(summary).sort()).toEqual([
      'createdAt',
      'error',
      'id',
      'progress',
      'status',
      'title',
      'updatedAt',
    ]);
  });

  it('shows the error of a failed job', () => {
    const summary = summarizeJob(
      job({ status: 'failed', error: { code: 'RENDER_FAILED', message: 'ffmpeg exited', hint: null } }),
    );
    expect(summary.title).toBeNull();
    expect(summary.error?.code).toBe('RENDER_FAILED');
  });
});

describe('maskContext', () => {
  it('masks secret-like values in all caller text and counts them', () => {
    const { context, masked } = maskContext({
      task: `call the API with ${KEY}`,
      notes: 'nothing secret here',
      tests: [{ command: `API_KEY=${KEY} npm test`, passed: false, summary: `failed: ${KEY}`, source: 'ci' }],
      screenshots: [{ path: '/a.png', caption: `shot ${KEY}`, moment: 'after' }],
    });
    expect(masked).toBe(4);
    expect(JSON.stringify(context)).not.toContain(KEY);
    expect(context.notes).toBe('nothing secret here');
    expect(context.tests?.[0]).toMatchObject({ passed: false, source: 'ci' });
    expect(context.screenshots?.[0]).toMatchObject({ path: '/a.png', moment: 'after' });
  });

  it('keeps nulls and leaves absent fields absent', () => {
    expect(maskContext({})).toEqual({ context: {}, masked: 0 });
    expect(maskContext({ task: null, notes: null })).toEqual({
      context: { task: null, notes: null },
      masked: 0,
    });
  });

  it('refuses a very long unbroken string in any field, and names the field', () => {
    const blob = 'password.'.repeat(200);
    expect(() => maskContext({ task: blob })).toThrow(
      /The task contains an unbroken string of more than 1000/,
    );
    expect(() => maskContext({ notes: blob })).toThrow(/The notes contains/);
    expect(() =>
      maskContext({ tests: [{ command: blob, passed: true, summary: '', source: 'user' }] }),
    ).toThrow(/test results/);
    expect(() =>
      maskContext({ tests: [{ command: 'x', passed: true, summary: blob, source: 'user' }] }),
    ).toThrow(/test results/);
    expect(() => maskContext({ screenshots: [{ path: '/a.png', caption: blob, moment: 'other' }] })).toThrow(
      /screenshot captions/,
    );
    try {
      maskContext({ task: blob });
    } catch (err) {
      expect((err as { code: string }).code).toBe('USAGE');
      expect((err as { hint: string }).hint).toContain('secrets');
    }
  });

  it('accepts a long path or word below the limit, and spaces break a run', () => {
    expect(() => maskContext({ notes: `${'a'.repeat(1000)}` })).not.toThrow();
    expect(() => maskContext({ notes: `${'a'.repeat(900)} ${'b'.repeat(900)}` })).not.toThrow();
  });

  it('is fast on the input that is slow for the secret scanner', () => {
    const started = Date.now();
    maskContext({ notes: `${'password.'.repeat(100)} ${'a.'.repeat(400)}\n`.repeat(40) });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('leaves ordinary text and commit hashes alone', () => {
    const text = 'Fixes the retry loop in 3f2a9c1d0e8b7a6f5e4d3c2b1a09f8e7d6c5b4a3 (see PR 42).';
    expect(maskContext({ notes: text })).toEqual({ context: { notes: text }, masked: 0 });
  });
});
