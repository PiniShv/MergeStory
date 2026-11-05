/** generate(): the whole pipeline, from the change to the published video. */
import { writeFile } from 'node:fs/promises';
import type { Config } from '../core/config.ts';
import { assertNotAborted, MergeStoryError } from '../core/errors.ts';
import {
  RUN_FILE,
  resultFiles,
  runFolder,
  type StoredPublishInput,
  writeRunJson,
} from '../core/run-folder.ts';
import { groundedLines } from '../core/storyboard-facts.ts';
import type { GenerateResult, PlanResult } from '../core/types.ts';
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
import { publishCommand } from './commands.ts';
import { describeFit } from './fit-duration.ts';
import { unusedScreenshotWarning } from './inputs.ts';
import { planResult } from './plan.ts';
import { prepare } from './prepare.ts';
import { buildWatchPageData } from './presentation.ts';
import { type PublishOutcome, publishAndNotify, saveResult } from './publish-run.ts';
import { chooseStoryboard, fitStoryboard } from './storyboard-choice.ts';
import type { GenerateHooks, GenerateOptions } from './types.ts';

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
 * Make the video for a pull request or a local change: analyse it, write and ground the storyboard,
 * narrate, render, then publish and notify when that is configured. With `dryRun` it only plans.
 */
export async function generate(
  options: GenerateOptions,
  hooks: GenerateHooks = {},
): Promise<GenerateResult | PlanResult> {
  const p = await prepare(options, hooks, undefined, { checkPublishing: true });
  const { ctx, config, changeSet, publishProblem } = p;
  const folder = runFolder(ctx.runDir);
  const warnings: string[] = [];

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
    ...[unusedScreenshotWarning(storyboard, p.inputs, choice.source)].filter((w): w is string => w !== null),
  ];
  for (const message of notices) ctx.progress({ stage: 'validate', status: 'warn', message });
  warnings.push(...notices);
  ctx.progress({
    stage: 'validate',
    status: 'done',
    message: `${groundedClaims} grounded narration lines, ${validation.fixes.length} automatic fixes`,
  });
  assertNotAborted(ctx.signal);

  if (ctx.dryRun) return planResult(p, choice, storyboard, warnings, publishProblem);

  // Narration and timing
  const tts = await selectTtsProvider(ctx);
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
  const rendered = await createRenderer(config).render(
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
  await writeWatchFolder({
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

  // No file paths here: the files are always the fixed names in the run folder (see runFolder).
  const stored: StoredPublishInput = {
    version: 1,
    runId: ctx.runId,
    source: changeSet.source,
    prUrl: changeSet.pr?.url ?? null,
    repoIsPrivate: changeSet.repo.isPrivate,
    headSha: changeSet.head.sha,
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
    chapters: plan.chapters,
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
