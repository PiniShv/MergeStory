/** The first half of every run: read the change, check the context and analyse it. */
import { basename } from 'node:path';
import { analyze, buildEvidencePack, targetDuration } from '../analyzer/index.ts';
import { type Config, resolveConfig } from '../core/config.ts';
import { createRunContext, type RunContext } from '../core/context.ts';
import { assertNotAborted, MergeStoryError } from '../core/errors.ts';
import { newRunId } from '../core/ids.ts';
import { assertNoLinks, assertNotWorkFolder, ensureDir, runDirFor } from '../core/paths.ts';
import type { SourceInput } from '../core/providers.ts';
import { runFolder, writeRunJson } from '../core/run-folder.ts';
import type { Analysis, ChangeSet, ContextInputs, RepoReader } from '../core/types.ts';
import { createPublisher } from '../publish/index.ts';
import { createSourceProvider } from '../sources/index.ts';
import { joinedPrivacy, joinSources, type LoadedSource } from '../sources/join.ts';
import { sourceInputsOf } from '../sources/spec.ts';
import { buildContextInputs } from './inputs.ts';
import { changeLabel } from './presentation.ts';
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

function describeSource(input: SourceInput, several = false): string {
  if (input.kind === 'github') return input.url;
  const range = `${input.base ?? 'merge base'}..${input.head ?? 'HEAD'}`;
  // With several sources the message must say which one it means.
  return several ? `local repository ${basename(input.repoPath)} (${range})` : `local repository (${range})`;
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

  const sourceInputs = sourceInputsOf(options as GenerateOptions, cwd);
  const several = sourceInputs.length > 1;
  const loaded: Pick<LoadedSource, 'changeSet' | 'reader'>[] = [];
  for (const input of sourceInputs) {
    ctx.progress({ stage: 'source', status: 'start', message: `Reading ${describeSource(input, several)}` });
    const one = await createSourceProvider(input)
      .load(input, ctx)
      .catch((error: unknown) => {
        // With several sources a failure must say which one it came from.
        if (!several || !(error instanceof MergeStoryError) || error.code === 'ABORTED') throw error;
        throw new MergeStoryError(error.code, `${describeSource(input, true)}: ${error.message}`, {
          ...(error.hint === undefined ? {} : { hint: error.hint }),
          ...(error.details === undefined ? {} : { details: error.details }),
          retryable: error.retryable,
          cause: error,
        });
      });
    ctx.progress({
      stage: 'source',
      status: 'done',
      message: `${changeLabel(one.changeSet)}: ${one.changeSet.stats.files} files, +${one.changeSet.stats.additions} -${one.changeSet.stats.deletions}`,
    });
    if (one.changeSet.files.length === 0) {
      throw new MergeStoryError(
        'SOURCE_INVALID',
        several
          ? `There are no changes to explain in ${describeSource(input, true)}.`
          : 'There are no changes to explain.',
        { hint: 'Check the base and head refs. Only committed changes are included for local repositories.' },
      );
    }
    loaded.push(one);
  }
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
  const { changeSet, reader, analysis } = several ? joinSources(analysed) : (analysed[0] as LoadedSource);
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
