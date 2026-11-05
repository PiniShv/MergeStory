/**
 * Checks caller-supplied context (task, notes, test results, screenshots) and assigns evidence ids.
 * This is the one input contract: the library, the command line and the HTTP API all end up here.
 */
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { MergeStoryError } from '../core/errors.ts';
import type { Storyboard } from '../core/storyboard-schema.ts';
import type { ContextInputs, TestEvidence } from '../core/types.ts';
import { detectImage, MAX_SCREENSHOT_BYTES } from '../visuals/image.ts';
import type { ContextOptions } from './types.ts';

/** Limits of the context. Longer lists and texts are cut or refused here, so every caller sees the same ones. */
export const MAX_TEXT = 64 * 1024;
export const MAX_SCREENSHOTS = 6;
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

export async function buildContextInputs(
  options: ContextOptions | undefined,
  cwd: string,
  warn: (message: string) => void = () => {},
): Promise<ContextInputs> {
  if ((options?.tests?.length ?? 0) > MAX_TESTS) warn(`Only the first ${MAX_TESTS} test results are used.`);
  if ((options?.screenshots?.length ?? 0) > MAX_SCREENSHOTS)
    warn(`Only the first ${MAX_SCREENSHOTS} screenshots are used.`);
  const tests = checkTestResults((options?.tests ?? []).slice(0, MAX_TESTS)).map((t, i) => ({
    id: `T${i + 1}`,
    command: t.command.slice(0, MAX_TEST_COMMAND),
    passed: t.passed,
    summary: t.summary.slice(0, MAX_TEST_SUMMARY),
    source: t.source,
  }));
  const screenshots = [];
  for (const [i, shot] of (options?.screenshots ?? []).slice(0, MAX_SCREENSHOTS).entries()) {
    screenshots.push({
      id: `SS${i + 1}`,
      path: await checkScreenshotFile(shot.path, cwd),
      caption: (shot.caption ?? '').slice(0, MAX_CAPTION),
      moment: shot.moment ?? 'other',
    });
  }
  return {
    task: normalizeContextText(options?.task, 'task description'),
    notes: normalizeContextText(options?.notes, 'implementation notes'),
    tests,
    screenshots,
  };
}

/** Ids of the screenshots that a storyboard shows. */
function shownScreenshots(storyboard: Storyboard): Set<string> {
  const shown = new Set<string>();
  for (const { visual } of storyboard.scenes) {
    if (visual.type === 'screenshot') shown.add(visual.screenshotId);
    if (visual.type === 'before-after') {
      for (const panel of [visual.before, visual.after]) {
        if (panel.kind === 'screenshot' && panel.screenshotId) shown.add(panel.screenshotId);
      }
    }
  }
  return shown;
}

/**
 * A warning when screenshots were supplied but the storyboard does not show them all, or null.
 * The offline storyboard never uses screenshots, which is worth saying because the person did
 * pass them on purpose.
 */
export function unusedScreenshotWarning(
  storyboard: Storyboard,
  inputs: ContextInputs,
  source: 'llm' | 'agent' | 'heuristic',
): string | null {
  const shown = shownScreenshots(storyboard);
  const unused = inputs.screenshots.filter((shot) => !shown.has(shot.id));
  if (unused.length === 0) return null;
  const names = unused.map((shot) => (shot.caption ? `${shot.id} ("${shot.caption}")` : shot.id)).join(', ');
  const reason =
    source === 'heuristic'
      ? ' The offline storyboard never uses screenshots: write the storyboard yourself (--storyboard) or use --llm to show them.'
      : '';
  return `${unused.length === 1 ? 'The screenshot' : 'The screenshots'} ${names} ${unused.length === 1 ? 'is' : 'are'} not shown in the video.${reason}`;
}
