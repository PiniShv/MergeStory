/**
 * The run folder: where a run keeps its files, and how the two files that later steps read back
 * (publish-input.json and result.json) are written and checked. Every other module asks this one
 * for a path instead of spelling the name out.
 */
import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { WatchPageData } from '../publish/types.ts';
import { MergeStoryError } from './errors.ts';
import { randomToken } from './ids.ts';
import { isRecord } from './json.ts';
import type { GenerateResult } from './types.ts';

/** The fixed names inside a run folder. The files that publishing uploads are always these. */
export const RUN_FILE = {
  analysis: 'analysis.json',
  evidence: 'evidence.md',
  guide: 'AUTHORING.md',
  schema: 'storyboard.schema.json',
  storyboard: 'storyboard.json',
  grounding: 'grounding.json',
  renderPlan: 'render-plan.json',
  audio: 'audio.wav',
  captions: 'captions.vtt',
  captionsSrt: 'captions.srt',
  video: 'video.mp4',
  poster: 'poster.jpg',
  /** Everything needed to publish the run again later. */
  publishInput: 'publish-input.json',
  /** The result of the run, as printed. */
  result: 'result.json',
} as const;

/** Folders inside a run folder. */
export const RUN_DIR = { watch: 'watch', publish: 'publish' } as const;

/** The name of the watch page inside the watch and publish folders. */
export const WATCH_PAGE_FILE = 'index.html';

export type RunFolder = { [K in keyof typeof RUN_FILE]: string } & { watchDir: string; watchPage: string };

/** The paths of a run folder's files. */
export function runFolder(runDir: string): RunFolder {
  const paths = Object.fromEntries(
    Object.entries(RUN_FILE).map(([key, name]) => [key, join(runDir, name)]),
  ) as { [K in keyof typeof RUN_FILE]: string };
  const watchDir = join(runDir, RUN_DIR.watch);
  return { ...paths, watchDir, watchPage: join(watchDir, WATCH_PAGE_FILE) };
}

/** The `files` of a result for a run folder. `poster` is null when the run has no poster image. */
export function resultFiles(runDir: string): GenerateResult['files'] {
  const folder = runFolder(runDir);
  return {
    video: folder.video,
    poster: existsSync(folder.poster) ? folder.poster : null,
    captions: folder.captions,
    storyboard: folder.storyboard,
    watchPage: folder.watchPage,
  };
}

/** Write a JSON file in one step, so that a run that is stopped halfway never leaves half a file. */
export async function writeRunJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomToken(4)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function notARunFile(name: string, why: string): MergeStoryError {
  return new MergeStoryError('SOURCE_INVALID', `${name} is not a MergeStory run file (${why}).`, {
    hint: 'Pass a run folder that `mergestory generate` wrote.',
  });
}

/** Check a value that was read from a run file. `name` is the file name, for the error. */
export function parseRunJson<T>(value: unknown, schema: z.ZodType<T>, name: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw notARunFile(name, parsed.error.issues[0]?.message ?? 'unexpected content');
  return parsed.data;
}

/** Read a run file and check its shape. A missing file, bad JSON and a wrong shape are all SOURCE_INVALID. */
export async function readRunJson<T>(path: string, schema: z.ZodType<T>, name: string): Promise<T> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new MergeStoryError('SOURCE_INVALID', `${name} cannot be read.`, {
      hint: 'Pass a run folder that `mergestory generate` wrote.',
      cause: err,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw notARunFile(name, 'not valid JSON');
  }
  return parseRunJson(value, schema, name);
}

/** The data of the watch page, as far as publishing needs to trust it. */
function isWatchData(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.title === 'string' &&
    typeof value.summary === 'string' &&
    ['chapters', 'checklist', 'claims', 'uncertainties'].every((key) => Array.isArray(value[key]))
  );
}

/**
 * publish-input.json: what publishing needs to know about a run. The folder may come from
 * somewhere else, so the shape is checked and nothing in it is trusted to name files: the files
 * are always the fixed names inside the folder (see RUN_FILE). Fields that older versions wrote
 * and that are not listed here are ignored.
 */
export const PublishInputSchema = z.looseObject(
  {
    version: z.literal(1, { error: 'unknown version' }),
    runId: z.string({ error: 'no run id' }).min(1, 'no run id').max(200, 'no run id'),
    source: z.enum(['github', 'local'], { error: 'unknown source' }),
    prUrl: z.string({ error: 'bad pull request link' }).nullable(),
    repoIsPrivate: z.boolean({ error: 'bad repository privacy' }).nullable(),
    headSha: z.string({ error: 'no commit or language' }),
    /** Narration language (BCP 47). */
    language: z.string({ error: 'no commit or language' }),
    watch: z.custom<WatchPageData>(isWatchData, { error: 'no watch page data' }),
  },
  { error: () => 'unknown version' },
);

/** The content of publish-input.json. */
export type StoredPublishInput = z.infer<typeof PublishInputSchema>;

const ResultShape = z.looseObject({
  ok: z.literal(true),
  cost: z.looseObject({ records: z.array(z.unknown()) }),
  egress: z.array(z.unknown()),
  warnings: z.array(z.unknown()),
  files: z.looseObject({}),
});

/** result.json: the shape is checked, and the rest is trusted because this program wrote it. */
export const StoredResultSchema = z.custom<GenerateResult>((value) => ResultShape.safeParse(value).success);

/** The part of render-plan.json that publishing reads: whether the captions are drawn into the video. */
export const RenderPlanCaptionsSchema = z.looseObject({
  captions: z.looseObject({ enabled: z.boolean() }),
});
