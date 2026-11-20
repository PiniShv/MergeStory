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
import { buildContext } from '../cli/inputs.ts';
import { resolveFfmpeg } from '../core/binaries.ts';
import { runCommand } from '../core/process.ts';
import { frameDirForStep } from '../core/recording-frames.ts';
import { narrationWords, wordBudget } from '../core/storyboard-facts.ts';
import type { Storyboard } from '../core/storyboard-schema.ts';
import { buildContextInputs, checkRepro, unusedScreenshotWarning } from '../pipeline/inputs.ts';
import { locateBrowser } from '../render/browser.ts';
import { LocalGitSource } from '../sources/local.ts';
import { expectCleanStoryboard } from '../testing/analysed.ts';
import { testContext } from '../testing/context.ts';
import { COVER_EDGE, COVER_FILL, type PixelRect, regionRect } from '../visuals/hide-regions.ts';
import { loadScreenshot } from '../visuals/image.ts';
import { loadStoryboardScreenshots } from '../visuals/plan.ts';
import { extractFrames, extractStoryboardFrames } from '../visuals/recording-frames.ts';
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
        // The folder that the capture script writes, read the way --screenshots-dir reads it.
        screenshots: (await buildContext({ screenshotsDir: join(captures, 'screenshots') }, directory))
          ?.screenshots,
        redact: JSON.parse(await readFile(join(DEMO, 'redact.json'), 'utf8')) as unknown,
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
        repro: checkRepro(JSON.parse(await readFile(join(DEMO, 'repro.json'), 'utf8')), '--repro-file'),
        logs: [{ path: join(captures, 'check.log'), caption: 'check.log' }],
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

  it('gives the two screenshots of the folder the ids SS1 and SS2, with their captions', () => {
    expect(deps.inputs.screenshots.map((s) => [s.id, s.caption, s.moment])).toEqual([
      ['SS1', 'The basket before the fix', 'before'],
      ['SS2', 'The basket after the fix', 'after'],
    ]);
  });

  it('gives the two recordings the ids RC1 and RC2', () => {
    expect(deps.inputs.recordings.map((r) => [r.id, r.moment])).toEqual([
      ['RC1', 'before'],
      ['RC2', 'after'],
    ]);
  });

  it('has regions in redact.json that hold the signed-in line as this machine draws it', async () => {
    // capture.mjs writes where the line is in each capture (for a clip, everywhere it was), as fractions of the picture.
    type Box = { x: number; y: number; w: number; h: number };
    const lines = JSON.parse(await readFile(join(captures, 'signed-in.json'), 'utf8')) as Record<string, Box>;
    for (const item of [...deps.inputs.screenshots, ...deps.inputs.recordings]) {
      expect(item.hidden, item.id).toHaveLength(1);
      const region = item.hidden![0]!;
      const line = lines[item.moment]!;
      // The text is as wide as the font of this machine makes it. The region must hold it with a little room.
      const room = 0.01;
      const label = `${item.id}: ${JSON.stringify(region)} must contain ${JSON.stringify(line)}`;
      expect(region.x, label).toBeLessThanOrEqual(line.x - room);
      expect(region.y, label).toBeLessThanOrEqual(line.y - room);
      expect(region.x + region.w, label).toBeGreaterThanOrEqual(line.x + line.w + room);
      expect(region.y + region.h, label).toBeGreaterThanOrEqual(line.y + line.h + room);
    }
  });

  it('covers the signed-in line of every capture with the regions of redact.json', async () => {
    for (const item of [...deps.inputs.screenshots, ...deps.inputs.recordings]) {
      expect(item.hidden, item.id).toHaveLength(1);
    }
    /** How far the pixels of the region are from the two greys of the cover, at most. */
    const offCover = async (bytes: Buffer, rect: PixelRect): Promise<number> => {
      const { stdoutBuffer } = await runCommand(
        ffmpeg!.ffmpeg,
        [
          '-v',
          'error',
          '-i',
          'pipe:0',
          '-vf',
          `crop=${rect.w}:${rect.h}:${rect.x}:${rect.y}`,
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgb24',
          'pipe:1',
        ],
        { input: bytes, timeoutMs: 60_000 },
      );
      return Math.max(
        ...stdoutBuffer.map((value) => Math.min(Math.abs(value - COVER_FILL), Math.abs(value - COVER_EDGE))),
      );
    };
    const decode = (src: string) => Buffer.from(src.slice(src.indexOf(',') + 1), 'base64');
    for (const shot of deps.inputs.screenshots) {
      const plain = await loadScreenshot(shot.path, config);
      const rect = regionRect(shot.hidden![0]!, plain.width, plain.height);
      const hidden = await loadScreenshot(shot.path, config, shot.id, { id: shot.id, regions: shot.hidden! });
      // Dark text on white before, so far from the greys; the cover after.
      expect(await offCover(decode(plain.src), rect), shot.id).toBeGreaterThan(60);
      expect(await offCover(decode(hidden.src), rect), shot.id).toBe(0);
    }
    for (const recording of deps.inputs.recordings) {
      const outDir = join(directory, `frames-${recording.id}`);
      const { count } = await extractFrames(ffmpeg!.ffmpeg, {
        recording,
        trim: { start: 0, end: recording.durationSec },
        zoom: null,
        box: { width: recording.width, height: recording.height },
        outDir,
      });
      const rect = regionRect(recording.hidden![0]!, recording.width, recording.height);
      for (const n of [1, Math.ceil(count / 2), count]) {
        const frame = await readFile(join(outDir, `f-${String(n).padStart(5, '0')}.jpg`));
        expect(await offCover(frame, rect), `${recording.id} frame ${n}`).toBeLessThan(16);
      }
    }
  });

  it('covers the signed-in line in the thumbnails of the reproduction scene, for a recording step and a screenshot step', async () => {
    // The offline storyboard shows the reproduction and the proof, which hold the recording step and the screenshot step.
    const written = heuristicStoryboard(deps.changeSet, deps.analysis, deps.inputs, deps.config, targetSec);
    type Box = { x: number; y: number; w: number; h: number };
    const lines = JSON.parse(await readFile(join(captures, 'signed-in.json'), 'utf8')) as Record<string, Box>;
    /** How far the pixels of the box are from the two greys of the cover, at most. */
    const offCover = async (bytes: Buffer, line: Box, width: number, height: number): Promise<number> => {
      const rect = regionRect(line, width, height);
      const { stdoutBuffer } = await runCommand(
        ffmpeg!.ffmpeg,
        [
          ...['-v', 'error', '-i', 'pipe:0'],
          ...['-vf', `crop=${rect.w}:${rect.h}:${rect.x}:${rect.y}`],
          ...['-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
        ],
        { input: bytes, timeoutMs: 60_000 },
      );
      return Math.max(
        ...stdoutBuffer.map((value) => Math.min(Math.abs(value - COVER_FILL), Math.abs(value - COVER_EDGE))),
      );
    };
    const shownSteps = written.scenes.flatMap((scene, index) =>
      scene.visual.type === 'repro'
        ? scene.visual.steps.map(({ step }) => ({
            scene: index + 1,
            step,
            source: deps.inputs.repro!.steps[step - 1]!,
          }))
        : [],
    );
    const recordingStep = shownSteps.find((s) => s.source.recordingId !== null);
    const screenshotStep = shownSteps.find((s) => s.source.screenshotId !== null);
    expect(recordingStep && screenshotStep, 'the scenes show both kinds').toBeTruthy();

    const runDir = join(directory, 'repro-run');
    const signal = new AbortController().signal;
    const frames = await extractStoryboardFrames(written, deps.inputs, deps.config, runDir, signal);
    const frameDir = frameDirForStep(recordingStep!.scene, recordingStep!.step);
    const frame = frames.get(frameDir)!;
    const recordingId = recordingStep!.source.recordingId;
    const moment = deps.inputs.recordings.find((r) => r.id === recordingId)!.moment;
    const shown = await readFile(join(runDir, frameDir, 'f-00001.jpg'));
    expect(await offCover(shown, lines[moment]!, frame.width, frame.height), 'recording step').toBeLessThan(
      16,
    );
    // Without the regions the same cut shows the text, so the test would notice a thumbnail that skips the cover.
    const plainInputs = {
      ...deps.inputs,
      recordings: deps.inputs.recordings.map(({ hidden: _hidden, ...rest }) => rest),
    };
    const plainRun = join(directory, 'repro-plain');
    await extractStoryboardFrames(written, plainInputs, deps.config, plainRun, signal);
    const plain = await readFile(join(plainRun, frameDir, 'f-00001.jpg'));
    expect(await offCover(plain, lines[moment]!, frame.width, frame.height)).toBeGreaterThan(60);

    const images = await loadStoryboardScreenshots(written, deps.inputs, deps.config, signal);
    const screenshotId = screenshotStep!.source.screenshotId!;
    const shot = deps.inputs.screenshots.find((s) => s.id === screenshotId)!;
    const picture = images.get(screenshotId)!;
    const bytes = Buffer.from(picture.src.slice(picture.src.indexOf(',') + 1), 'base64');
    expect(await offCover(bytes, lines[shot.moment]!, picture.width, picture.height), 'screenshot step').toBe(
      0,
    );
    const original = await loadScreenshot(shot.path, deps.config);
    const originalBytes = Buffer.from(original.src.slice(original.src.indexOf(',') + 1), 'base64');
    expect(
      await offCover(originalBytes, lines[shot.moment]!, original.width, original.height),
    ).toBeGreaterThan(60);
  });

  it('reads the real output of the check as the log L1', () => {
    expect(deps.inputs.logs.map((l) => [l.id, l.caption, l.lines.length])).toEqual([['L1', 'check.log', 7]]);
  });

  it('has a hand-written storyboard with nothing to report, repair or remove', async () => {
    const written = JSON.parse(await readFile(join(DEMO, 'storyboard.json'), 'utf8')) as Storyboard;
    // With the target length, so a storyboard over its word budget is reported too.
    expect(await expectCleanStoryboard({ ...deps, targetSec }, written, false)).toEqual([]);
    // The example follows the guide: the word budget is a limit, not only the point where validate warns.
    expect(narrationWords(written)).toBeLessThanOrEqual(wordBudget(targetSec));
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

  it('reads the reproduction steps from repro.json, with the captures that they name', () => {
    expect(deps.inputs.repro?.steps.map((s) => [s.recordingId, s.screenshotId, s.result])).toEqual([
      [null, null, null],
      [null, null, null],
      ['RC1', null, 'bug'],
      [null, 'SS2', 'fixed'],
    ]);
  });

  it('still gets an offline storyboard, which shows the reproduction but not the other captures', async () => {
    const board = heuristicStoryboard(deps.changeSet, deps.analysis, deps.inputs, deps.config, targetSec);
    expect(board.scenes.some((s) => s.visual.type === 'recording')).toBe(false);
    expect(board.scenes.map((s) => s.role).filter((r) => r === 'reproduction' || r === 'proof')).toEqual([
      'reproduction',
      'proof',
    ]);
    expect(await expectCleanStoryboard(deps, board)).toEqual([]);
    const warning = unusedScreenshotWarning(board, deps.inputs, 'heuristic', { maskEmails: true });
    expect(warning).toContain('The recording RC2');
    expect(warning).not.toContain('RC1');
    expect(warning).toContain('L1');
  });
});
