/**
 * The second demo, a bug that the viewer can see: its repository is built by the script in
 * examples/bugfix-demo, its captures are made by capture.mjs with a real browser and FFmpeg
 * (the test is skipped when either is missing), and its hand-written storyboard has to stay clean.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyze, targetDuration } from '../analyzer/index.ts';
import { resolveFfmpeg } from '../core/binaries.ts';
import type { Storyboard } from '../core/storyboard-schema.ts';
import { buildContextInputs, unusedScreenshotWarning } from '../pipeline/inputs.ts';
import { locateBrowser } from '../render/browser.ts';
import { LocalGitSource } from '../sources/local.ts';
import { expectCleanStoryboard } from '../testing/analysed.ts';
import { testContext } from '../testing/context.ts';
import { heuristicStoryboard } from './heuristic.ts';
import type { ValidationDeps } from './types.ts';

const DEMO = fileURLToPath(new URL('../../../../examples/bugfix-demo/', import.meta.url));

const config = testContext().ctx.config;
const ffmpeg = await resolveFfmpeg(config).catch(() => null);
const browser = await locateBrowser(config).catch(() => null);

describe.skipIf(ffmpeg === null || browser === null)('the bug-fix demo', () => {
  let directory = '';
  let captures = '';
  let deps: ValidationDeps;
  let targetSec = 0;
  const original = {
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  };

  beforeAll(async () => {
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    directory = await mkdtemp(join(tmpdir(), 'mergestory-bugfix-demo-'));
    const repo = join(directory, 'repo');
    captures = join(directory, 'captures');
    execFileSync('bash', [join(DEMO, 'create-demo-repo.sh'), repo], { stdio: 'pipe' });
    execFileSync('node', [join(DEMO, 'capture.mjs'), captures], {
      stdio: 'pipe',
      env: { ...process.env, MERGESTORY_BROWSER_PATH: browser!.path, MERGESTORY_FFMPEG_PATH: ffmpeg!.ffmpeg },
      timeout: 120_000,
    });
    const ctx = testContext().ctx;
    const { changeSet, reader } = await new LocalGitSource().load(
      { kind: 'local', repoPath: repo, base: 'main', head: 'fix/basket-count' },
      ctx,
    );
    const inputs = await buildContextInputs(
      {
        task: await readFile(join(DEMO, 'task.md'), 'utf8'),
        notes: await readFile(join(DEMO, 'notes.md'), 'utf8'),
        tests: JSON.parse(await readFile(join(DEMO, 'tests.json'), 'utf8')) as [],
        screenshots: [
          { path: join(captures, 'before.png'), caption: 'The basket before the fix', moment: 'before' },
          { path: join(captures, 'after.png'), caption: 'The basket after the fix', moment: 'after' },
        ],
        recordings: [
          {
            path: join(captures, 'before.mp4'),
            caption: 'The basket page before the fix: typing 2 and 3 shows 23 items',
            moment: 'before',
          },
          {
            path: join(captures, 'after.mp4'),
            caption: 'The basket page after the fix: typing 2 and 3 shows 5 items',
            moment: 'after',
          },
        ],
      },
      directory,
      ctx.config,
    );
    const analysis = await analyze(changeSet, reader, inputs, ctx);
    targetSec = targetDuration(analysis, ctx.config);
    deps = { changeSet, analysis, inputs, reader, config: ctx.config };
  }, 180_000);

  afterAll(async () => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });

  it('gives the two recordings the ids RC1 and RC2', () => {
    expect(deps.inputs.recordings.map((r) => [r.id, r.moment])).toEqual([
      ['RC1', 'before'],
      ['RC2', 'after'],
    ]);
  });

  it('has a hand-written storyboard with nothing to report, repair or remove', async () => {
    const written = JSON.parse(await readFile(join(DEMO, 'storyboard.json'), 'utf8')) as Storyboard;
    expect(await expectCleanStoryboard(deps, written)).toEqual([]);
  });

  it('puts every highlight and the focus on the item count, as this machine draws it', async () => {
    const written = JSON.parse(await readFile(join(DEMO, 'storyboard.json'), 'utf8')) as Storyboard;
    // capture.mjs writes where the text of the count is in each picture, as fractions of it.
    type Box = { x: number; y: number; w: number; h: number };
    const counts = JSON.parse(await readFile(join(captures, 'count.json'), 'utf8')) as Record<string, Box>;
    const checked: { moment: string; where: string; box: Box }[] = [];
    for (const scene of written.scenes) {
      const visual = scene.visual;
      if (visual.type === 'recording') {
        const moment = deps.inputs.recordings.find((r) => r.id === visual.recordingId)!.moment;
        for (const box of [...visual.highlights, ...(visual.focus ? [visual.focus] : [])])
          checked.push({ moment, where: scene.id, box });
      } else if (visual.type === 'before-after') {
        for (const panel of [visual.before, visual.after]) {
          if (panel.kind !== 'screenshot') continue;
          const moment = deps.inputs.screenshots.find((s) => s.id === panel.screenshotId)!.moment;
          for (const box of panel.highlights) checked.push({ moment, where: scene.id, box });
        }
      }
    }
    // Two recordings with a box each, one with a focus, and two screenshot panels.
    expect(checked).toHaveLength(5);
    for (const { moment, where, box } of checked) {
      // The text is as wide as the font of this machine makes it. The box must hold it with a little room.
      const count = counts[moment]!;
      const room = 0.01;
      const label = `${where} ${moment}: ${JSON.stringify(box)} must contain ${JSON.stringify(count)}`;
      expect(box.x, label).toBeLessThanOrEqual(count.x - room);
      expect(box.y, label).toBeLessThanOrEqual(count.y - room);
      expect(box.x + box.w, label).toBeGreaterThanOrEqual(count.x + count.w + room);
      expect(box.y + box.h, label).toBeGreaterThanOrEqual(count.y + count.h + room);
    }
  });

  it('still gets an offline storyboard, which says it does not show the recordings', async () => {
    const board = heuristicStoryboard(deps.changeSet, deps.analysis, deps.inputs, deps.config, targetSec);
    expect(board.scenes.some((s) => s.visual.type === 'recording')).toBe(false);
    expect(await expectCleanStoryboard(deps, board)).toEqual([]);
    expect(unusedScreenshotWarning(board, deps.inputs, 'heuristic', { maskEmails: true })).toContain(
      'The recordings RC1',
    );
  });
});
