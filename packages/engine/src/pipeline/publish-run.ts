/**
 * Publishing a rendered run, either at the end of generate() or later with publishRun(),
 * so a video can be reviewed locally before anything leaves the machine.
 */
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { type Config, resolveConfig } from '../core/config.ts';
import { createRunContext, type RunContext } from '../core/context.ts';
import { describeProblem, MergeStoryError, toMergeStoryError } from '../core/errors.ts';
import { RUN_ID_PATTERN } from '../core/ids.ts';
import { assertNotWorkFolder, homeLayout } from '../core/paths.ts';
import { isInside } from '../core/posix.ts';
import type { PublishBundle } from '../core/providers.ts';
import { globalRedactor } from '../core/redact.ts';
import {
  PublishInputSchema,
  RenderPlanCaptionsSchema,
  RUN_FILE,
  readRunJson,
  resultFiles,
  runFolder,
  type StoredPublishInput,
  StoredResultSchema,
  writeRunJson,
} from '../core/run-folder.ts';
import type { GenerateResult, PublishResult } from '../core/types.ts';
import {
  GitHubClient,
  parsePullRequestUrl,
  updatePullRequestDescription,
  upsertPullRequestComment,
} from '../github/index.ts';
import {
  BUNDLE_CONTAINS,
  buildDescriptionSection,
  buildPrComment,
  buildWatchPage,
  COMMENT_MARKER,
  createPublisher,
} from '../publish/index.ts';
import { publishCommand } from './commands.ts';
import { buildCommentData } from './presentation.ts';
import type { GenerateHooks, PublishRunOptions } from './types.ts';

/** The files to upload. */
export interface RunFiles {
  video: string;
  poster: string | null;
  captions: string | null;
}

export interface PublishOutcome {
  publish: PublishResult | null;
  notify: GenerateResult['notify'];
  warnings: string[];
  /** Set when the upload failed. Nothing was published; the caller keeps the run and reports this. */
  failure: MergeStoryError | null;
}

/**
 * The upload files of a run folder: the fixed names inside it. A name that leads outside the folder
 * (a link to some other file) is refused, because whatever it points at would be uploaded.
 */
export async function runFilesIn(runDir: string): Promise<RunFiles> {
  const root = await realpath(runDir);
  const find = async (name: string): Promise<string | null> => {
    let real: string;
    try {
      real = await realpath(join(runDir, name));
    } catch {
      return null;
    }
    if (!isInside(root, real)) {
      throw new MergeStoryError(
        'PRIVACY_BLOCKED',
        `${name} in the run folder leads outside the folder, so it was not uploaded.`,
        { hint: 'A run folder holds only its own files. Render the video again with `mergestory generate`.' },
      );
    }
    return real;
  };
  const video = await find(RUN_FILE.video);
  if (!video) {
    throw new MergeStoryError('SOURCE_NOT_FOUND', `This run has no ${RUN_FILE.video}.`, {
      hint: 'Render the video first with `mergestory generate`.',
    });
  }
  return { video, poster: await find(RUN_FILE.poster), captions: await find(RUN_FILE.captions) };
}

/** Prefixes of the warnings that the publish step adds. A new attempt replaces the ones of an earlier attempt. */
const PUBLISH_WARNING_PREFIXES = ['Skipped the PR update:', 'The pull request was not updated:'];

/**
 * What happens to the pull request after publishing. The real run and the dry-run plan decide it here
 * and each word the outcome for their own reader.
 */
type PullRequestUpdate =
  | { kind: 'update'; prUrl: string }
  /** Neither a comment nor a description update was asked for. */
  | { kind: 'not-requested' }
  | { kind: 'not-a-pull-request' }
  /** A link to a file on this machine is useless to reviewers and would expose a local path. */
  | { kind: 'video-stays-local' };

/**
 * `publishedWith` is the publisher that the video goes through (its id, or the provider of the result),
 * or null when nothing is published.
 */
export function decidePullRequestUpdate(
  config: Pick<Config, 'github'>,
  change: { source: 'github' | 'local'; prUrl: string | null },
  publishedWith: string | null,
): PullRequestUpdate {
  if (!config.github.comment && !config.github.updateDescription) return { kind: 'not-requested' };
  if (change.source !== 'github' || !change.prUrl) return { kind: 'not-a-pull-request' };
  if (publishedWith === null || publishedWith === 'local') return { kind: 'video-stays-local' };
  return { kind: 'update', prUrl: change.prUrl };
}

/**
 * Upload with the configured publisher (if any), then update the pull request when asked. A failed
 * upload does not throw: it comes back as `failure`, so the caller can save the run first. A failed
 * pull request update is a warning, because the video is already published.
 */
export async function publishAndNotify(
  ctx: RunContext,
  stored: StoredPublishInput,
  files: RunFiles,
): Promise<PublishOutcome> {
  const { config } = ctx;
  const warnings: string[] = [];
  let publish: PublishResult | null = null;
  try {
    const publisher = createPublisher(config);
    if (publisher) {
      ctx.progress({ stage: 'publish', status: 'start', message: `Publishing with ${publisher.id}` });
      const { watch } = stored;
      const bundle: PublishBundle = {
        files: [
          { name: RUN_FILE.video, path: files.video },
          ...(files.poster ? [{ name: RUN_FILE.poster, path: files.poster }] : []),
          ...(files.captions ? [{ name: RUN_FILE.captions, path: files.captions }] : []),
        ],
        buildWatchPage: (urls) => buildWatchPage(watch, urls),
        contains: [...BUNDLE_CONTAINS],
        repoIsPrivate: stored.repoIsPrivate,
        meta: {
          title: watch.title,
          summary: watch.summary,
          language: stored.language,
          durationSec: watch.durationSec,
          chapters: watch.chapters,
          checklist: watch.checklist.map((item) => ({ title: item.title, severity: item.severity })),
          changeUrl: watch.changeUrl,
          repoLabel: watch.repoLabel,
          changeLabel: watch.changeLabel,
          headSha: stored.headSha,
          engineVersion: watch.engineVersion,
        },
      };
      publish = await publisher.publish(bundle, ctx);
      ctx.progress({ stage: 'publish', status: 'done', message: `Published to ${publish.location}` });
    }
  } catch (err) {
    return { publish: null, notify: null, warnings, failure: toMergeStoryError(err, 'PUBLISH_FAILED') };
  }

  let notify: GenerateResult['notify'] = null;
  const update = decidePullRequestUpdate(
    config,
    { source: stored.source, prUrl: stored.prUrl },
    publish?.provider ?? null,
  );
  if (update.kind === 'not-a-pull-request') {
    warnings.push('Skipped the PR update: this run was not made from a GitHub pull request.');
  } else if (update.kind === 'video-stays-local') {
    warnings.push(
      'Skipped the PR update: the video is only on this machine. Publish it first (for example --publish s3).',
    );
  } else if (update.kind === 'update' && publish) {
    // The address is shown, because a run folder can name any pull request.
    ctx.progress({
      stage: 'notify',
      status: 'start',
      message: `Updating the pull request ${update.prUrl}`,
    });
    notify = { commentUrl: null, descriptionUpdated: false };
    try {
      const ref = parsePullRequestUrl(update.prUrl, config.github.apiUrl);
      const commentData = buildCommentData(stored.watch, publish, stored.headSha);
      if (config.github.comment) {
        notify.commentUrl = (
          await upsertPullRequestComment(ref, buildPrComment(commentData), COMMENT_MARKER, ctx)
        ).url;
      }
      if (config.github.updateDescription) {
        await updatePullRequestDescription(ref, buildDescriptionSection(commentData), ctx);
        notify.descriptionUpdated = true;
      }
      ctx.progress({ stage: 'notify', status: 'done', message: 'Pull request updated' });
    } catch (err) {
      // The video is already up, so its link is kept and printed. Only the update is reported as failed.
      const message =
        `The pull request was not updated: ${describeProblem(toMergeStoryError(err, 'NOTIFY_FAILED'))} The video itself is published. ` +
        `To try the update again, run: ${publishCommand(ctx.runDir, config)} (this uploads the video again).`;
      warnings.push(message);
      ctx.progress({ stage: 'notify', status: 'warn', message });
    }
  }
  return { publish, notify, warnings, failure: null };
}

/**
 * Redact a result before it is stored, but keep the published links intact: they are what the
 * user asked for, and a presigned link with its signature removed no longer works.
 */
export function redactResultForDisk<T extends { publish: PublishResult | null }>(result: T): T {
  const redacted = globalRedactor.redactValue(result);
  return { ...redacted, publish: result.publish };
}

/** Write result.json (see writeRunJson). */
export async function saveResult(runDir: string, result: GenerateResult): Promise<void> {
  await writeRunJson(runFolder(runDir).result, redactResultForDisk(result));
}

function resolveRunDir(run: string, home: string | null): string {
  const asPath = isAbsolute(run) ? run : resolve(process.cwd(), run);
  if (existsSync(join(asPath, RUN_FILE.publishInput))) return asPath;
  if (RUN_ID_PATTERN.test(run)) {
    const dir = join(homeLayout(home).runs, run);
    if (existsSync(join(dir, RUN_FILE.publishInput))) return dir;
  }
  throw new MergeStoryError('SOURCE_NOT_FOUND', `No rendered run found for "${run}".`, {
    hint: 'Pass the run folder (runDir in the generate result) or its run id.',
  });
}

/**
 * The stored input of a run folder. Folders made before the watch data held the caption language and
 * the caption default are completed: the language is the narration language of the run, and the
 * page's own caption track starts off when the render plan says that the captions are drawn into
 * the video. When neither is stored, the page keeps its defaults.
 */
async function readStoredInput(runDir: string): Promise<StoredPublishInput> {
  const folder = runFolder(runDir);
  const stored = await readRunJson(folder.publishInput, PublishInputSchema, RUN_FILE.publishInput);
  const { watch } = stored;
  const completed = { ...watch, language: watch.language ?? stored.language };
  if (watch.captionsDefault === undefined) {
    const drawn = await readRunJson(folder.renderPlan, RenderPlanCaptionsSchema, RUN_FILE.renderPlan).catch(
      () => null,
    );
    if (drawn?.captions.enabled) completed.captionsDefault = false;
  }
  return { ...stored, watch: completed };
}

/** The result of the earlier run, or one rebuilt from publish-input.json when result.json is gone or unreadable. */
async function readPreviousResult(
  runDir: string,
  stored: StoredPublishInput,
  budgetUsd: number,
): Promise<GenerateResult> {
  const folder = runFolder(runDir);
  const previous = await readRunJson(folder.result, StoredResultSchema, RUN_FILE.result).catch(() => null);
  if (previous) return previous;
  const { watch } = stored;
  return {
    ok: true,
    runId: stored.runId,
    runDir,
    title: watch.title,
    summary: watch.summary,
    durationSec: watch.durationSec,
    chapters: watch.chapters,
    storyboardSource: watch.storyboardSource,
    files: resultFiles(runDir),
    publish: null,
    notify: null,
    grounding: { groundedClaims: watch.claims.length, fixes: [], warnings: [] },
    cost: { totalUsd: 0, budgetUsd, records: [] },
    egress: [],
    warnings: [
      `The earlier result of this run (${RUN_FILE.result}) was not found, so its cost and transfers are not listed.`,
    ],
  };
}

/** Whether a public link, or a public description, depends on the repository being public. */
export function dependsOnPublicRepository(config: RunContext['config']): boolean {
  const { publish } = config;
  return (
    (publish.provider === 's3' && publish.visibility === 'public') ||
    (publish.provider === 'youtube' && publish.youtube.privacyStatus !== 'private') ||
    (publish.provider === 'drive' && publish.visibility === 'public')
  );
}

/**
 * The privacy of the repository, for the checks that guard public links. A run file that says
 * "public" is only believed when GitHub says so now, because nothing proves who wrote the file.
 * Private stays private, and anything that cannot be confirmed counts as unknown.
 */
async function confirmedPrivacy(ctx: RunContext, stored: StoredPublishInput): Promise<boolean | null> {
  if (stored.repoIsPrivate !== false) return stored.repoIsPrivate;
  if (!dependsOnPublicRepository(ctx.config) || stored.source !== 'github' || !stored.prUrl) return null;
  try {
    const ref = parsePullRequestUrl(stored.prUrl, ctx.config.github.apiUrl);
    const client = await GitHubClient.create(ref, ctx, { stage: 'publish' });
    return (await client.getRepo()).isPrivate;
  } catch (err) {
    ctx.logger.debug('Could not confirm that the repository is public', {
      reason: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Publish a run that was rendered earlier (mergestory publish). Lets a person or an agent review
 * the local video first and upload or comment only after approval. No rendering happens here.
 */
export async function publishRun(
  options: PublishRunOptions,
  hooks: GenerateHooks = {},
): Promise<GenerateResult> {
  const config = resolveConfig({ overrides: options.config, configPath: options.configPath });
  const runDir = resolveRunDir(options.run, config.home);
  await assertNotWorkFolder(runDir, config.home);
  const folder = runFolder(runDir);
  const stored = await readStoredInput(runDir);
  const files = await runFilesIn(runDir);
  const previous = await readPreviousResult(runDir, stored, config.budgetUsd);
  const ctx = createRunContext({
    config,
    runId: stored.runId,
    runDir,
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(hooks.onProgress ? { onProgress: hooks.onProgress } : {}),
  });
  const trusted = { ...stored, repoIsPrivate: await confirmedPrivacy(ctx, stored) };
  const outcome = await publishAndNotify(ctx, trusted, files);

  const spent = ctx.cost.report();
  const merged = {
    cost: {
      ...spent,
      totalUsd: previous.cost.totalUsd + spent.totalUsd,
      records: [...previous.cost.records, ...spent.records],
    },
    egress: [...previous.egress, ...ctx.egress.list()],
  };
  const result: GenerateResult = {
    ...previous,
    // The folder may have been moved since the run was made.
    runDir,
    files: {
      ...previous.files,
      ...resultFiles(runDir),
      captions: files.captions ? folder.captions : previous.files.captions,
    },
    publish: outcome.publish ?? previous.publish,
    notify: outcome.notify ?? previous.notify,
    ...merged,
    warnings: [
      ...previous.warnings.filter((w) => !PUBLISH_WARNING_PREFIXES.some((prefix) => w.startsWith(prefix))),
      ...outcome.warnings,
    ],
  };
  // A failed upload still leaves its mark: what was sent before it failed is recorded.
  await saveResult(runDir, outcome.failure ? { ...previous, ...merged } : result);
  if (outcome.failure) throw outcome.failure;
  return result;
}
