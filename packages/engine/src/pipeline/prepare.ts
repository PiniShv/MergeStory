/** The first half of every run: read the change, check the context and analyse it. */
import { analyze, buildEvidencePack, targetDuration } from '../analyzer/index.ts';
import { type Config, resolveConfig } from '../core/config.ts';
import { createRunContext, type RunContext } from '../core/context.ts';
import { assertNotAborted, type MergeStoryError } from '../core/errors.ts';
import { newRunId } from '../core/ids.ts';
import { assertNoLinks, assertNotWorkFolder, ensureDir, runDirFor } from '../core/paths.ts';
import { runFolder, writeRunJson } from '../core/run-folder.ts';
import type { Analysis, ChangeSet, ContextInputs, RepoReader } from '../core/types.ts';
import { createPublisher } from '../publish/index.ts';
import { joinedPrivacy, joinSources, type LoadedSource } from '../sources/join.ts';
import { loadSources } from '../sources/load.ts';
import { sourceInputsOf } from '../sources/spec.ts';
import { buildContextInputs } from './inputs.ts';
import type { GenerateHooks, GenerateOptions } from './types.ts';

export interface Prepared {
  ctx: RunContext;
  config: Config;
  changeSet: ChangeSet;
  reader: RepoReader;
  inputs: ContextInputs;
  analysis: Analysis;
  targetSec: number;
  /** A publish setting that would make the upload fail. Only looked for when asked (see PrepareSettings). */
  publishProblem: MergeStoryError | null;
}

export interface PrepareSettings {
  /** Look for publish settings that would fail, and (unless this is a dry run) stop on the first one. */
  checkPublishing?: boolean;
  /** Write analysis.json (and so create the run folder). On by default; off for a caller that only reads the change. */
  writeAnalysis?: boolean;
  /** The folder becomes a run folder that publish trusts later (generate), so it may not be a work folder. */
  runFolder?: boolean;
}

/** Read the change, check the context, analyse, and write analysis.json into the run folder. */
export async function prepare(
  options: Omit<GenerateOptions, 'storyboard'>,
  hooks: GenerateHooks,
  outDirOverride?: string | null,
  settings: PrepareSettings = {},
): Promise<Prepared> {
  const cwd = process.cwd();
  const config = resolveConfig({ overrides: options.config, configPath: options.configPath });
  const runId = options.runId ?? newRunId();
  // The folder is created once there is something to put in it, so a run that fails early leaves nothing behind.
  const runDir = runDirFor(runId, outDirOverride ?? config.outDir, config.home);
  if (settings.runFolder) await assertNotWorkFolder(runDir, config.home);
  if (settings.writeAnalysis ?? true) await assertNoLinks(runDir);
  const ctx = createRunContext({
    config,
    runId,
    runDir,
    dryRun: options.dryRun ?? false,
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(hooks.onProgress ? { onProgress: hooks.onProgress } : {}),
  });

  const loaded = await loadSources(sourceInputsOf(options, cwd), ctx);
  assertNotAborted(ctx.signal);

  // A setting that would make the upload fail is found now, before anything is written, spent or rendered.
  const publishProblem = settings.checkPublishing
    ? ((await createPublisher(config)?.check(ctx, joinedPrivacy(loaded.map((l) => l.changeSet.repo)))) ??
      null)
    : null;
  if (publishProblem && !ctx.dryRun) throw publishProblem;

  const inputs = await buildContextInputs(options.context, cwd, config, (message) =>
    ctx.progress({ stage: 'source', status: 'warn', message }),
  );
  ctx.progress({ stage: 'analyze', status: 'start', message: 'Analysing the change' });
  const analysed: LoadedSource[] = [];
  for (const one of loaded)
    analysed.push({ ...one, analysis: await analyze(one.changeSet, one.reader, inputs, ctx) });
  const { changeSet, reader, analysis } = joinSources(analysed);
  const targetSec = targetDuration(analysis, config);
  ctx.progress({
    stage: 'analyze',
    status: 'done',
    message: `Size ${analysis.size.toUpperCase()}, ${analysis.components.length} components, ${analysis.risks.length} review signals, target ${targetSec}s`,
  });
  if (settings.writeAnalysis ?? true) {
    await ensureDir(runDir);
    await writeRunJson(runFolder(runDir).analysis, analysis);
  }
  return { ctx, config, changeSet, reader, inputs, analysis, targetSec, publishProblem };
}

/** The evidence pack for the model or for an author, cut to `maxTokens`. */
export function packFor(p: Prepared, maxTokens: number) {
  return buildEvidencePack(p.changeSet, p.analysis, p.inputs, {
    maxTokens,
    llmContext: p.config.privacy.llmContext,
    targetDurationSec: p.targetSec,
    style: p.config.style,
    language: p.config.language,
  });
}
