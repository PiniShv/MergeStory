/**
 * Checks caller-supplied context (task, notes, test results, screenshots) and assigns evidence ids.
 * This is the one input contract: the library, the command line and the HTTP API all end up here.
 */
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { resolveFfmpeg } from '../core/binaries.ts';
import type { Config } from '../core/config.ts';
import { MergeStoryError } from '../core/errors.ts';
import { isRecord } from '../core/json.ts';
import { probeRecording, shownName } from '../core/media-probe.ts';
import { maskPrivate, type PrivateMaskOptions } from '../core/secrets.ts';
import type { Storyboard } from '../core/storyboard-schema.ts';
import type { ContextInputs, RecordingInput, TestEvidence } from '../core/types.ts';
import { detectImage, MAX_SCREENSHOT_BYTES } from '../visuals/image.ts';
import type { ContextOptions } from './types.ts';

/** Limits of the context. Longer lists and texts are cut or refused here, so every caller sees the same ones. */
export const MAX_TEXT = 64 * 1024;
/** Test results that reach the evidence. A longer list is cut, with a warning. */
export const MAX_TESTS = 10;
/** Most entries accepted in a list of test results at all. */
export const MAX_TEST_ENTRIES = 200;
const MAX_TEST_COMMAND = 300;
const MAX_TEST_SUMMARY = 1000;
const MAX_CAPTION = 200;

export const TEST_SOURCES = ['agent', 'ci', 'user'] as const;
const TEST_KEYS = ['command', 'passed', 'summary', 'source'];

/**
 * One test result the caller reports. Strict on purpose: a typo such as "pass" for "passed", or the
 * string "false" for false, must never turn into a made-up result. The messages complete the
 * sentence "entry 3 ...".
 */
export const TestResultSchema = z.strictObject(
  {
    command: z
      .string({ error: 'needs a "command" string.' })
      .refine((command) => command.trim() !== '', { error: 'needs a "command" string.' }),
    passed: z.boolean({ error: 'needs "passed" set to true or false.' }),
    summary: z.string({ error: 'needs a "summary" string.' }),
    source: z
      .enum(TEST_SOURCES, {
        error: (issue) => `has source "${String(issue.input)}". Use one of: ${TEST_SOURCES.join(', ')}.`,
      })
      .default('agent'),
  },
  {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? `has unknown field "${issue.keys[0]}". Allowed: ${TEST_KEYS.join(', ')}.`
        : 'is not an object.',
  },
);

/** Check a list of test results. `label` names the input in the error ("--tests-file", "tests"). */
export function checkTestResults(value: unknown, label = 'tests'): Omit<TestEvidence, 'id'>[] {
  const fail = (message: string): never => {
    throw new MergeStoryError('USAGE', `${label}: ${message}`, {
      hint: 'Expected a JSON array like [{"command": "npm test", "passed": true, "summary": "42 passed"}].',
    });
  };
  if (!Array.isArray(value)) return fail('expected a JSON array of test results.');
  if (value.length > MAX_TEST_ENTRIES) {
    return fail(`${value.length} entries is too many (at most ${MAX_TEST_ENTRIES}).`);
  }
  return value.map((entry, index) => {
    const parsed = TestResultSchema.safeParse(entry);
    if (parsed.success) return parsed.data;
    // An unknown field is reported before a missing one, as it is easier to act on.
    const issue = parsed.error.issues.find((i) => i.code === 'unrecognized_keys') ?? parsed.error.issues[0];
    return fail(`entry ${index + 1} ${issue?.message ?? 'is not valid.'}`);
  });
}

function normalizeContextText(value: string | null | undefined, what: string): string | null {
  if (value === null || value === undefined) return null;
  const text = value.replace(/\r\n/g, '\n').trim();
  if (!text) return null;
  if (text.length > MAX_TEXT) {
    throw new MergeStoryError(
      'USAGE',
      `The ${what} is too long (${text.length} characters, limit ${MAX_TEXT}).`,
      {
        hint: `Shorten the ${what}; a few paragraphs are enough.`,
      },
    );
  }
  return text;
}

/** "5.2 MB", rounded up, for a size that is over the screenshot limit. */
function megabytes(bytes: number): string {
  return `${Math.ceil((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

/**
 * Check a screenshot the way the video does: PNG or JPEG by content (never by file name), at most
 * 4 MiB and 40 megapixels. A file that the video could not draw is refused here, at once, and not
 * after narration has been paid for. Returns the absolute path. `label` names the input in errors.
 */
export async function checkScreenshotFile(path: string, cwd: string, label = 'Screenshot'): Promise<string> {
  const absolute = resolve(cwd, path);
  const info = await stat(absolute).catch(() => null);
  if (!info) {
    throw new MergeStoryError('USAGE', `${label}: file not found: ${path}`, {
      hint: 'Pass an existing PNG or JPEG file.',
    });
  }
  if (!info.isFile()) throw new MergeStoryError('USAGE', `${label}: ${path} is not a regular file.`);
  const tooLarge = (size: number): MergeStoryError =>
    new MergeStoryError(
      'USAGE',
      `${label}: ${path} is ${megabytes(size)}, the limit is ${megabytes(MAX_SCREENSHOT_BYTES)}.`,
      { hint: 'Resize or compress the image first.' },
    );
  if (info.size > MAX_SCREENSHOT_BYTES) throw tooLarge(info.size);
  const bytes = await readFile(absolute).catch(() => null);
  if (bytes === null) throw new MergeStoryError('USAGE', `${label}: cannot read ${path}.`);
  // The file may have grown since it was measured.
  if (bytes.length > MAX_SCREENSHOT_BYTES) throw tooLarge(bytes.length);
  if (!detectImage(bytes)) {
    throw new MergeStoryError(
      'USAGE',
      `${label}: ${path} is not a PNG or JPEG image (up to 40 megapixels).`,
      {
        hint: 'Convert it to PNG or JPEG first. Other formats, such as WebP and GIF, are not supported.',
      },
    );
  }
  return absolute;
}

/**
 * Check a screen recording by its content: a regular file, within the size limit, readable by
 * ffprobe as H.264, VP8 or VP9 video, and within the length limit. Refused at once, so no speech is
 * paid for a clip that cannot be drawn. `path` is made absolute.
 */
async function checkRecording(
  ffprobe: string,
  path: string,
  cwd: string,
  limits: Config['inputs'],
): Promise<Omit<RecordingInput, 'id' | 'caption' | 'moment'>> {
  const absolute = resolve(cwd, path);
  const name = shownName(absolute);
  const refuse = (reason: string, hint?: string): MergeStoryError =>
    new MergeStoryError('USAGE', `Recording ${name} cannot be used: ${reason}.`, hint ? { hint } : {});
  const info = await stat(absolute).catch(() => null);
  if (!info) throw refuse('the file was not found', 'Pass an existing MP4 or WebM file.');
  if (!info.isFile()) throw refuse('it is not a regular file');
  if (info.size > limits.maxRecordingMb * 1024 * 1024) {
    throw refuse(
      `it is ${megabytes(info.size)}, the limit is ${limits.maxRecordingMb} MB`,
      'Cut or compress the recording first.',
    );
  }
  const probed = await probeRecording(ffprobe, absolute);
  if (probed.durationSec > limits.maxRecordingSeconds) {
    throw refuse(
      `it is ${Math.ceil(probed.durationSec)} s long, the limit is ${limits.maxRecordingSeconds} s`,
      'Cut the recording to the part that matters.',
    );
  }
  return { path: absolute, ...probed };
}

export async function buildContextInputs(
  options: ContextOptions | undefined,
  cwd: string,
  config: Pick<Config, 'inputs' | 'render'>,
  warn: (message: string) => void = () => {},
): Promise<ContextInputs> {
  if ((options?.tests?.length ?? 0) > MAX_TESTS) warn(`Only the first ${MAX_TESTS} test results are used.`);
  const maxScreenshots = config.inputs.maxScreenshots;
  if ((options?.screenshots?.length ?? 0) > maxScreenshots)
    warn(`Only the first ${maxScreenshots} screenshots are used.`);
  const maxRecordings = config.inputs.maxRecordings;
  if ((options?.recordings?.length ?? 0) > maxRecordings)
    warn(`Only the first ${maxRecordings} recordings are used.`);
  const tests = checkTestResults((options?.tests ?? []).slice(0, MAX_TESTS)).map((t, i) => ({
    id: `T${i + 1}`,
    command: t.command.slice(0, MAX_TEST_COMMAND),
    passed: t.passed,
    summary: t.summary.slice(0, MAX_TEST_SUMMARY),
    source: t.source,
  }));
  const screenshots = [];
  for (const [i, shot] of (options?.screenshots ?? []).slice(0, maxScreenshots).entries()) {
    screenshots.push({
      id: `SS${i + 1}`,
      path: await checkScreenshotFile(shot.path, cwd),
      caption: (shot.caption ?? '').slice(0, MAX_CAPTION),
      moment: shot.moment ?? 'other',
    });
  }
  const recordings: RecordingInput[] = [];
  const wanted = (options?.recordings ?? []).slice(0, maxRecordings);
  // FFmpeg is looked up only when a recording was supplied.
  const ffprobe = wanted.length > 0 ? (await resolveFfmpeg(config)).ffprobe : '';
  for (const [i, rec] of wanted.entries()) {
    const checked = await checkRecording(ffprobe, rec.path, cwd, config.inputs);
    recordings.push({
      id: `RC${i + 1}`,
      caption: (rec.caption ?? '').slice(0, MAX_CAPTION),
      moment: rec.moment ?? 'other',
      ...checked,
    });
  }
  return {
    task: normalizeContextText(options?.task, 'task description'),
    notes: normalizeContextText(options?.notes, 'implementation notes'),
    tests,
    screenshots,
    recordings,
  };
}

/** Ids of the screenshots and recordings that a storyboard shows. */
export function shownMedia(storyboard: Storyboard): { screenshots: Set<string>; recordings: Set<string> } {
  const screenshots = new Set<string>();
  const recordings = new Set<string>();
  for (const { visual } of storyboard.scenes) {
    if (visual.type === 'screenshot') screenshots.add(visual.screenshotId);
    if (visual.type === 'recording') recordings.add(visual.recordingId);
    if (visual.type === 'before-after') {
      for (const panel of [visual.before, visual.after]) {
        if (panel.kind === 'screenshot' && panel.screenshotId) screenshots.add(panel.screenshotId);
        if (panel.kind === 'recording' && panel.recordingId) recordings.add(panel.recordingId);
      }
    }
  }
  return { screenshots, recordings };
}

/**
 * Every evidence id that a storyboard cites or shows: the cited ids in the order of first use, then
 * the screenshots and recordings that are shown and not cited. After the checks, every id in it exists.
 */
export function evidenceUsed(storyboard: Storyboard): string[] {
  const ids = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
    } else if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (key !== 'evidence' || !Array.isArray(child)) walk(child);
        else for (const id of child) if (typeof id === 'string') ids.add(id);
      }
    }
  };
  walk(storyboard);
  const shown = shownMedia(storyboard);
  for (const id of [...shown.screenshots, ...shown.recordings]) ids.add(id);
  return [...ids];
}

/**
 * A warning when screenshots or recordings were supplied but the storyboard does not show them all,
 * or null. The offline storyboard never uses them, which is worth saying because the person did
 * pass them on purpose.
 */
export function unusedScreenshotWarning(
  storyboard: Storyboard,
  inputs: ContextInputs,
  source: 'llm' | 'agent' | 'heuristic',
  privacy: PrivateMaskOptions,
): string | null {
  const shown = shownMedia(storyboard);
  const sentence = (
    items: readonly { id: string; caption: string }[],
    one: string,
    many: string,
    plural: string,
  ): string | null => {
    if (items.length === 0) return null;
    // The warning goes into logs and into the result, so a caption is masked here as it is on screen.
    const names = items
      .map((item) => (item.caption ? `${item.id} ("${maskPrivate(item.caption, privacy)}")` : item.id))
      .join(', ');
    const reason =
      source === 'heuristic'
        ? ` The offline storyboard never uses ${plural}: write the storyboard yourself (--storyboard) or use --llm to show them.`
        : '';
    return `${items.length === 1 ? one : many} ${names} ${items.length === 1 ? 'is' : 'are'} not shown in the video.${reason}`;
  };
  const parts = [
    sentence(
      inputs.screenshots.filter((shot) => !shown.screenshots.has(shot.id)),
      'The screenshot',
      'The screenshots',
      'screenshots',
    ),
    sentence(
      inputs.recordings.filter((rec) => !shown.recordings.has(rec.id)),
      'The recording',
      'The recordings',
      'recordings',
    ),
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(' ');
}
