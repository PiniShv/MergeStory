/** generate(): the whole pipeline, from the change to the published video. */
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../core/config.ts';
import type { RunContext } from '../core/context.ts';
import { assertNotAborted, MergeStoryError, toMergeStoryError } from '../core/errors.ts';
import { isRecord } from '../core/json.ts';
import type { Renderer, RenderInput, RenderOutput, TtsProvider } from '../core/providers.ts';
import { FRAMES_DIR } from '../core/recording-frames.ts';
import {
  RUN_DIR,
  RUN_FILE,
  resultFiles,
  runFolder,
  type StoredPublishInput,
  WATCH_PAGE_FILE,
  writeRunJson,
} from '../core/run-folder.ts';
import { groundedLines } from '../core/storyboard-facts.ts';
import { plural } from '../core/text.ts';
import { loadTheme } from '../core/theme.ts';
import type { FailedResult, GenerateResult, PlanResult } from '../core/types.ts';
import {
  assembleNarrationTrack,
  buildCaptionCues,
  selectTtsProvider,
  synthesizeNarration,
  toSrt,
  toWebVtt,
} from '../narration/index.ts';
import { buildWatchPage, classifyBundle, writeWatchFolder } from '../publish/index.ts';
import { createRenderer } from '../render/index.ts';
import { buildRenderPlan, buildTimeline } from '../visuals/index.ts';
import { loadStoryboardScreenshots } from '../visuals/plan.ts';
import { extractStoryboardFrames } from '../visuals/recording-frames.ts';
import { publishCommand } from './commands.ts';
import { describeFit } from './fit-duration.ts';
import { evidenceUsed, unusedScreenshotWarning } from './inputs.ts';
import { planResult } from './plan.ts';
import { type Prepared, prepare } from './prepare.ts';
import { buildWatchPageData } from './presentation.ts';
import { type PublishOutcome, publishAndNotify, saveResult } from './publish-run.ts';
import { assertStoryboardPossible, chooseStoryboard, fitStoryboard } from './storyboard-choice.ts';
import type { GenerateHooks, GenerateOptions } from './types.ts';

/**
 * Checks the render tools, then picks (and if needed installs) the voice. It runs before the
 * storyboard step, which may be paid, so a run that cannot finish stops before it spends money.
 * In order, not in parallel: a failed check must not leave a voice install running.
 */
async function readyToRender(ctx: RunContext, renderer: Renderer): Promise<TtsProvider> {
  await renderer.ready();
  return selectTtsProvider(ctx);
}

/**
 * The error of a failed upload, with what the person needs to go on: the video was rendered and is
 * kept, and one command uploads it without rendering again.
 */
function failedAfterRender(error: MergeStoryError, runDir: string, config: Config): MergeStoryError {
  const saved = `The video was rendered and is saved in ${runDir}. To upload it without rendering again, run: ${publishCommand(runDir, config)}`;
  return new MergeStoryError(error.code, error.message, {
    hint: error.hint ? `${error.hint} ${saved}` : saved,
    details: { ...error.details, runDir },
    retryable: error.retryable,
    cause: error,
  });
}

/**
 * Render within the time limit of `render.maxSeconds`. The limit stops the renderer the way a cancel
 * does, and the run then fails with RENDER_TIMEOUT. The renderer only moves a finished video into the
 * run folder, so a render that is stopped leaves none.
 */
async function renderWithin(renderer: Renderer, input: RenderInput, ctx: RunContext): Promise<RenderOutput> {
  const seconds = ctx.config.render.maxSeconds;
  if (seconds === null) return renderer.render(input, ctx);
  const limit = new AbortController();
  const timer = setTimeout(() => limit.abort(), seconds * 1000);
  try {
    return await renderer.render(input, { ...ctx, signal: AbortSignal.any([ctx.signal, limit.signal]) });
  } catch (err) {
    if (!limit.signal.aborted || ctx.signal.aborted) throw err;
    throw new MergeStoryError(
      'RENDER_TIMEOUT',
      `Rendering took longer than the limit of ${plural(seconds, 'second')}, so it was stopped. No video was written.`,
      {
        hint: 'Raise --max-render-seconds (render.maxSeconds), render with --quality draft, or make the video shorter with --max-duration.',
        cause: err,
      },
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The files of an earlier run that a new run removes when it takes a folder over: the result, what
 * `mergestory publish` trusts, the files a caller uploads, and the copies of them in the watch folder
 * and in the run's own publish folder. Files by their fixed names only, never a whole folder: the
 * folder may be one that the user chose. The other files are replaced as the run writes them.
 */
function leftByEarlierRun(runDir: string): string[] {
  const folder = runFolder(runDir);
  const copies = [WATCH_PAGE_FILE, RUN_FILE.video, RUN_FILE.poster, RUN_FILE.captions];
  return [
    folder.result,
    folder.publishInput,
    folder.video,
    folder.poster,
    folder.captions,
    folder.captionsSrt,
    folder.watchHtml,
    ...[RUN_DIR.watch, RUN_DIR.publish].flatMap((dir) => copies.map((name) => join(runDir, dir, name))),
  ];
}

/**
 * Whether the folder holds an earlier MergeStory run: its result, or what publishing needs, with a run
 * id in it. Only then are the files beside them MergeStory's own. A folder that the user chose can hold
 * a `video.mp4` of theirs, and a run that fails must not remove that.
 */
async function holdsEarlierRun(runDir: string): Promise<boolean> {
  const folder = runFolder(runDir);
  for (const path of [folder.result, folder.publishInput]) {
    const value: unknown = await readFile(path, 'utf8')
      .then((text) => JSON.parse(text))
      .catch(() => null);
    if (isRecord(value) && typeof value.runId === 'string') return true;
  }
  return false;
}

/** Leave the error as result.json, so that a caller that only reads the run folder learns what happened. */
async function saveFailure(ctx: RunContext, err: unknown): Promise<void> {
  const failed: FailedResult = {
    ok: false,
    runId: ctx.runId,
    runDir: ctx.runDir,
    error: toMergeStoryError(err).toJSON(),
  };
  // Best effort: a folder that cannot be written must not replace the error that is being reported.
  await writeRunJson(runFolder(ctx.runDir).result, ctx.redactor.redactValue(failed)).catch(() => undefined);
}

/**
 * Make the video for a pull request or a local change: analyse it, write and ground the storyboard,
 * narrate, render, then publish and notify when that is configured. With `dryRun` it only plans.
 *
 * Once the run folder exists, the outcome of a real run is written to its result.json: the result, or
 * the error (`ok: false`) when the run stops before its video is made. A run that fails before that (a
 * source that cannot be read, a setting that is wrong) writes no file and touches nothing.
 */
export async function generate(
  options: GenerateOptions,
  hooks: GenerateHooks = {},
): Promise<GenerateResult | PlanResult> {
  const startedAt = performance.now();
  const p = await prepare(options, hooks, undefined, { checkPublishing: true, runFolder: true });
  const progress = { resultSaved: false };
  if (p.ctx.dryRun) return produce(p, options, startedAt, progress);
  // The folder may hold an earlier run. From here on it speaks for this run only: what a caller reads,
  // uploads or publishes from it must never be the video of another change.
  if (await holdsEarlierRun(p.ctx.runDir)) {
    for (const left of leftByEarlierRun(p.ctx.runDir)) await rm(left, { force: true });
    // The one folder removed whole: its name is MergeStory's own, so it only ever holds frames of recordings.
    await rm(join(p.ctx.runDir, FRAMES_DIR), { recursive: true, force: true });
  }
  try {
    return await produce(p, options, startedAt, progress);
  } catch (err) {
    // After a failed upload the result of the finished video is already there, and it stays.
    if (!progress.resultSaved) await saveFailure(p.ctx, err);
    throw err;
  }
}

/** Everything after the analysis: storyboard, checks, narration, rendering, publishing. */
async function produce(
  p: Prepared,
  options: GenerateOptions,
  startedAt: number,
  progress: { resultSaved: boolean },
): Promise<GenerateResult | PlanResult> {
  const { ctx, config, changeSet, publishProblem } = p;
  const folder = runFolder(ctx.runDir);
  const warnings: string[] = [];
  // Before anything is spent: a theme that cannot be used stops the run here.
  const theme = await loadTheme(config.theme, {
    home: config.home,
    allowLowContrast: options.allowLowContrast === true,
    warn: (message) => {
      ctx.progress({ stage: 'visuals', status: 'warn', message });
      warnings.push(message);
    },
  });

  assertStoryboardPossible(p, options.storyboard);
  const renderer = createRenderer(config);
  const tts = ctx.dryRun ? null : await readyToRender(ctx, renderer);

  const choice = await chooseStoryboard(p, options.storyboard);
  const { validation } = choice;
  const fit = fitStoryboard(p, choice.storyboard);
  const { storyboard } = fit;
  const groundedClaims = groundedLines(storyboard);
  const groundingWarnings = validation.warnings.map((w) => `${w.path}: ${w.message}`);
  await writeRunJson(folder.storyboard, storyboard);
  await writeRunJson(folder.grounding, {
    groundedClaims,
    fixes: validation.fixes,
    warnings: validation.warnings,
  });
  warnings.push(...groundingWarnings);
  const notices = [
    ...describeFit(fit, config.maxDurationSec),
    ...[
      unusedScreenshotWarning(storyboard, p.inputs, choice.source, { maskEmails: config.privacy.maskEmails }),
    ].filter((w): w is string => w !== null),
  ];
  for (const message of notices) ctx.progress({ stage: 'validate', status: 'warn', message });
  warnings.push(...notices);
  ctx.progress({
    stage: 'validate',
    status: 'done',
    message: `${groundedClaims} grounded narration lines, ${validation.fixes.length} automatic fixes`,
  });
  assertNotAborted(ctx.signal);

  if (ctx.dryRun || tts === null) return planResult(p, choice, storyboard, warnings, publishProblem);

  // Before any speech is paid for: a recording that cannot be decoded, or a screenshot that cannot be made smaller, stops the run here.
  const frames = await extractStoryboardFrames(storyboard, p.inputs, config, ctx.runDir, ctx.signal);
  const images = await loadStoryboardScreenshots(storyboard, p.inputs, config, ctx.signal);

  // Narration and timing
  ctx.progress({ stage: 'narrate', status: 'start', message: `Narrating with ${tts.id}` });
  const narration = await synthesizeNarration(storyboard, tts, ctx);
  const timeline = buildTimeline(storyboard, narration);
  const cues = buildCaptionCues(storyboard, timeline, { maskEmails: config.privacy.maskEmails });
  const audioPath = await assembleNarrationTrack(narration, timeline, folder.audio, ctx, {
    loudness: config.render.normalizeLoudness,
  });
  await writeFile(folder.captions, toWebVtt(cues), { mode: 0o600 });
  await writeFile(folder.captionsSrt, toSrt(cues), { mode: 0o600 });
  ctx.progress({
    stage: 'narrate',
    status: 'done',
    message: `${narration.clips.length} lines, ${timeline.durationSec.toFixed(1)}s`,
  });
  if (!audioPath) {
    warnings.push(
      config.tts.provider === 'none'
        ? 'The video has no voice-over (speech is switched off); captions are included.'
        : 'The video has no voice-over (no speech provider available); captions are included.',
    );
  }
  if (fit.fits && timeline.durationSec > config.maxDurationSec) {
    // Only the estimate is kept within the maximum. A real voice can be slower than the estimate.
    warnings.push(
      `The finished video is ${Math.round(timeline.durationSec)} s, over the maximum of ${config.maxDurationSec} s (--max-duration): ` +
        `the voice speaks more slowly than the ${Math.round(fit.afterSec)} s estimate that the storyboard was fitted to.`,
    );
  }
  assertNotAborted(ctx.signal);

  // Visuals and rendering
  ctx.progress({ stage: 'visuals', status: 'start', message: 'Resolving code, diagrams and timing' });
  const plan = await buildRenderPlan(
    {
      storyboard,
      timeline,
      cues,
      changeSet,
      analysis: p.analysis,
      inputs: p.inputs,
      reader: p.reader,
      config,
      theme,
      frames,
      images,
    },
    ctx,
  );
  await writeRunJson(folder.renderPlan, plan);
  ctx.progress({ stage: 'visuals', status: 'done', message: `${plan.scenes.length} scenes` });
  assertNotAborted(ctx.signal);

  ctx.progress({
    stage: 'render',
    status: 'start',
    message: `Rendering ${plan.width}x${plan.height} at ${plan.fps} fps`,
  });
  const rendered = await renderWithin(
    renderer,
    { plan, audioPath, outDir: ctx.runDir, quality: config.quality },
    ctx,
  );
  ctx.progress({
    stage: 'render',
    status: 'done',
    message: `${rendered.durationSec.toFixed(1)}s video, ${(rendered.sizeBytes / 1e6).toFixed(1)} MB`,
  });
  assertNotAborted(ctx.signal);

  // Watch page (always written locally) and publishing
  const generatedAt = new Date().toISOString();
  const generator = {
    llm: choice.source === 'llm' ? `${choice.provider.id} ${choice.provider.model}` : null,
    tts: tts.id,
  };
  const localWatchData = buildWatchPageData({
    storyboard,
    storyboardSource: choice.source,
    changeSet,
    analysis: p.analysis,
    chapters: plan.chapters,
    durationSec: rendered.durationSec,
    generator,
    generatedAt,
    captionsBurnedIn: config.captions,
  });
  const watchPage = await writeWatchFolder({
    dir: folder.watchDir,
    files: await classifyBundle({
      files: [
        { name: RUN_FILE.video, path: rendered.videoPath },
        ...(rendered.posterPath ? [{ name: RUN_FILE.poster, path: rendered.posterPath }] : []),
        { name: RUN_FILE.captions, path: folder.captions },
      ],
    }),
    buildPage: (urls) => buildWatchPage(localWatchData, urls),
    // The cues are at hand, so the page does not read them back from the caption file.
    captionCues: cues,
    pageMode: 0o600,
  });
  // The same page next to the video. It finds the video by name, so the two can be uploaded together.
  await copyFile(watchPage, folder.watchHtml);

  // No file paths here: the files are always the fixed names in the run folder (see runFolder).
  const stored: StoredPublishInput = {
    version: 1,
    runId: ctx.runId,
    source: changeSet.source,
    prUrl: changeSet.pr?.url ?? null,
    repoIsPrivate: changeSet.repo.isPrivate,
    headSha: changeSet.head.sha,
    ...(changeSet.parts ? { sources: changeSet.parts.length } : {}),
    language: storyboard.language,
    watch: localWatchData,
  };
  await writeRunJson(folder.publishInput, stored);

  const resultFor = (outcome: Pick<PublishOutcome, 'publish' | 'notify' | 'warnings'>): GenerateResult => ({
    ok: true,
    runId: ctx.runId,
    runDir: ctx.runDir,
    title: storyboard.title,
    summary: storyboard.summary,
    durationSec: rendered.durationSec,
    elapsedSec: Math.round((performance.now() - startedAt) / 100) / 10,
    chapters: plan.chapters,
    scenes: plan.scenes.map((scene) => ({
      id: scene.id,
      role: scene.role,
      title: scene.title,
      visual: scene.visual.type,
      startSec: scene.startSec,
      durationSec: scene.durationSec,
    })),
    evidenceUsed: evidenceUsed(storyboard, p.inputs.repro),
    storyboardSource: choice.source,
    files: { ...resultFiles(ctx.runDir), poster: rendered.posterPath ? folder.poster : null },
    publish: outcome.publish,
    notify: outcome.notify,
    grounding: { groundedClaims, fixes: validation.fixes, warnings: groundingWarnings },
    cost: ctx.cost.report(),
    egress: ctx.egress.list(),
    warnings: [...warnings, ...outcome.warnings],
  });

  // From here on the run is usable: `mergestory publish` can upload it even if publishing fails now.
  await saveResult(ctx.runDir, resultFor({ publish: null, notify: null, warnings: [] }));
  progress.resultSaved = true;
  const outcome = await publishAndNotify(ctx, stored, {
    video: rendered.videoPath,
    poster: rendered.posterPath,
    captions: folder.captions,
  });
  const result = resultFor(outcome);
  // Also after a failed upload: what was sent before it failed is part of the record.
  await saveResult(ctx.runDir, result);
  if (outcome.failure) throw failedAfterRender(outcome.failure, ctx.runDir, config);
  return result;
}
