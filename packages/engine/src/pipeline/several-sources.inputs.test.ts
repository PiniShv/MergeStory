/** The inputs of the caller (reproduction, logs, hidden regions, pictures) belong to the run, not to a repository. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makePng } from '../testing/png.ts';
import { isolateGitConfig, makeRepo } from '../testing/repos.ts';
import { checkStoryboard, generate, prepareAuthoring } from './index.ts';
import type { ContextOptions } from './types.ts';

let restoreGit: () => void;
let base: string;
let api: string;
let web: string;
let context: ContextOptions;

beforeAll(async () => {
  restoreGit = isolateGitConfig();
  base = await mkdtemp(join(tmpdir(), 'mergestory-several-inputs-'));
  api = await makeRepo(
    base,
    'orders-api',
    'export const total = (o) => o.sum;\n',
    'export const total = (o) => ({ cents: o.cents });\n',
  );
  web = await makeRepo(
    base,
    'storefront',
    'export const show = (o) => o.total;\n',
    'export const show = (o) => o.total.cents / 100;\n',
  );
  await mkdir(join(base, 'input'));
  await writeFile(join(base, 'input', 'page.png'), makePng(8, 8));
  await writeFile(join(base, 'input', 'run.log'), 'start\nError: total is NaN\nend\n');
  context = {
    task: 'Fix the total',
    screenshots: [{ path: join(base, 'input', 'page.png'), caption: 'The page', moment: 'before' }],
    repro: {
      title: 'The total is wrong',
      steps: [{ text: 'Open the basket', screenshot: 'SS1', result: 'bug' }],
    },
    logs: [{ path: join(base, 'input', 'run.log'), caption: 'Test run' }],
    redact: { SS1: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }] },
  };
});

afterAll(async () => {
  restoreGit();
  await rm(base, { recursive: true, force: true });
});

const range = { base: 'main', head: 'fix/total' };
const both = () => [
  { kind: 'local' as const, repoPath: api, ...range },
  { kind: 'local' as const, repoPath: web, ...range },
];
const config = (home: string) => ({ home, tts: { provider: 'none' as const }, quality: 'draft' as const });

/** A storyboard that cites both repositories, a step of the reproduction, a log range and a screenshot. */
function storyboard() {
  const scene = (id: string, role: string, narration: object[], visual: object) => ({
    id,
    role,
    title: id,
    narration,
    visual,
    visualDescription: 'A scene.',
    transition: 'fade',
    targetSeconds: null,
  });
  return {
    version: 1,
    title: 'The total in cents',
    summary: 'The service returns cents and the page shows them.',
    style: 'technical',
    language: 'en',
    scenes: [
      scene(
        's1',
        'mission',
        [{ text: 'The total is wrong unless both changes are merged.', evidence: ['A.CM1', 'B.CM1'] }],
        {
          type: 'title',
          kicker: 'Two repositories',
          heading: 'The total in cents',
          subheading: null,
          chips: [],
        },
      ),
      scene(
        's2',
        'under-the-hood',
        [
          { text: 'The service now returns cents.', evidence: ['A.F1.H1'] },
          { text: 'The page divides the cents by one hundred.', evidence: ['B.F1.H1'] },
        ],
        {
          type: 'code',
          ref: { path: 'orders-api/src/total.js', side: 'head', startLine: 1, endLine: 1 },
          mode: 'diff',
          focus: [],
          caption: null,
        },
      ),
      scene(
        's3',
        'under-the-hood',
        [
          {
            text: 'The reproduction shows the wrong total on the basket page.',
            evidence: ['REPRO.1', 'SS1'],
          },
          { text: 'The log has the error line.', evidence: ['L1.2'] },
        ],
        {
          type: 'summary',
          points: [{ text: 'The total was not a number.', beat: 0 }],
          closing: null,
        },
      ),
    ],
    reviewChecklist: [],
    uncertainties: [],
  };
}

describe('the inputs of the caller with two sources', () => {
  it('keeps REPRO, REPRO.1, L1 and SS1 without a letter and gives the ids of the repositories a letter', async () => {
    const home = await mkdtemp(join(base, 'home-'));
    const result = await prepareAuthoring({
      source: api,
      sources: both(),
      context,
      config: config(home),
      outDir: join(home, 'out'),
    });
    const analysis = JSON.parse(await readFile(result.files.analysis, 'utf8')) as {
      evidence: { id: string; kind: string }[];
    };
    const ids = analysis.evidence.map((e) => e.id);
    for (const id of ['TASK', 'REPRO', 'REPRO.1', 'L1', 'SS1']) expect(ids, id).toContain(id);
    for (const e of analysis.evidence) {
      const ofRun = ['task', 'notes', 'test', 'screenshot', 'recording', 'repro', 'log'].includes(e.kind);
      expect(/^[AB]\./.test(e.id), `${e.kind} ${e.id}`).toBe(!ofRun);
    }
    const pack = await readFile(result.files.evidence, 'utf8');
    expect(pack).toContain('parts hidden');
  });

  it('accepts a storyboard that cites ids of both sources, a step of the reproduction and a log line', async () => {
    const home = await mkdtemp(join(base, 'home-'));
    const result = await checkStoryboard({
      source: api,
      sources: both(),
      context,
      storyboard: storyboard(),
      config: config(home),
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.fixes).toEqual([]);
  });

  it('still needs a storyboard when a reproduction is given, and writes no offline one', async () => {
    const home = await mkdtemp(join(base, 'home-'));
    const error = await generate({
      source: api,
      sources: both(),
      context,
      config: config(home),
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'USAGE', exitCode: 2 });
    await expect(
      generate({ source: api, sources: both(), context, dryRun: true, config: config(home) }),
    ).rejects.toMatchObject({ code: 'USAGE' });
  });
});
