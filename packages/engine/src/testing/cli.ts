/**
 * Shared setup for the tests of the command line: a temporary folder, a way to run the program with its
 * output captured, and canned results. Importing this module registers the hooks that create and remove
 * the folder and reset the mocks; the test file mocks the pipeline and the worker itself.
 * Not part of the public API.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';
import { runCli } from '../cli/program.ts';
import type { GenerateResult, PlanResult } from '../core/types.ts';
import { startDetachedWorker } from '../jobs/worker.ts';
import type { GenerateOptions } from '../pipeline/index.ts';
import { checkStoryboard, generate, prepareAuthoring } from '../pipeline/index.ts';

export const generateMock = vi.mocked(generate);
export const analyzeMock = vi.mocked(prepareAuthoring);
export const validateMock = vi.mocked(checkStoryboard);
export const workerMock = vi.mocked(startDetachedWorker);

export let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mergestory-cli-'));
  generateMock.mockReset();
  analyzeMock.mockReset();
  validateMock.mockReset();
  workerMock.mockClear();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

export async function run(argv: string[], env: Record<string, string> = {}): Promise<Run> {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    env: { MERGESTORY_HOME: join(dir, 'home'), ...env },
    cwd: dir,
    handleSignals: false,
    stdoutIsTty: false,
    stderrIsTty: false,
  });
  return { code, stdout, stderr };
}

export function fakeResult(overrides: Partial<GenerateResult> = {}): GenerateResult {
  return {
    ok: true,
    runId: 'r1',
    runDir: '/runs/r1',
    title: 'Add retries to the uploader',
    summary: 'Adds retries.',
    durationSec: 83,
    chapters: [
      { title: 'The mission', startSec: 0 },
      { title: 'Under the hood', startSec: 31 },
    ],
    storyboardSource: 'heuristic',
    files: {
      video: '/runs/r1/video.mp4',
      poster: '/runs/r1/poster.png',
      captions: '/runs/r1/captions.vtt',
      storyboard: '/runs/r1/storyboard.json',
      watchPage: '/runs/r1/index.html',
    },
    publish: null,
    notify: null,
    grounding: { groundedClaims: 9, fixes: ['clamped one range'], warnings: [] },
    cost: {
      totalUsd: 0.0042,
      budgetUsd: 0.25,
      records: [
        { provider: 'anthropic', kind: 'llm', model: 'claude-haiku-5-5', costUsd: 0.004, estimated: true },
        { provider: 'openai', kind: 'tts', model: null, costUsd: 0.0002, estimated: true },
      ],
    },
    egress: [
      {
        destination: 'api.anthropic.com',
        purpose: 'storyboard',
        bytes: 41_000,
        contains: ['diff', 'pr-metadata'],
      },
    ],
    warnings: ['2 files were too large to show'],
    ...overrides,
  };
}

export function fakePlan(): PlanResult {
  return {
    ok: true,
    dryRun: true,
    runId: 'r2',
    runDir: '/runs/r2',
    title: 'Add retries to the uploader',
    storyboardSource: 'heuristic',
    estimatedDurationSec: 75,
    scenes: [
      { id: 's1', role: 'mission', title: 'The mission', visual: 'mission' },
      { id: 's2', role: 'under-the-hood', title: 'Retry loop', visual: 'code' },
    ],
    providers: { llm: 'none', tts: 'say', publish: 'local' },
    estimatedCost: { totalUsd: 0, budgetUsd: 0.25, records: [] },
    plannedEgress: [],
    warnings: ['No LLM configured'],
  };
}

export function lastGenerateOptions(): GenerateOptions {
  const call = generateMock.mock.calls.at(-1);
  if (!call) throw new Error('generate was not called');
  return call[0];
}
