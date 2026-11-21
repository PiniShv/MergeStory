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
import { resolveLogId } from '../core/log-id.ts';
import { clockProblem, probeRecording, shownName } from '../core/media-probe.ts';
import { maskPrivate, type PrivateMaskOptions } from '../core/secrets.ts';
import type { Storyboard } from '../core/storyboard-schema.ts';
import { stripInvisible } from '../core/text.ts';
import {
  type ContextInputs,
  type HiddenRegion,
  type LogInput,
  REPRO_RESULTS,
  type RecordingInput,
  type ReproFile,
  type ReproInput,
  type TestEvidence,
} from '../core/types.ts';
import { longestRun, MAX_UNBROKEN_RUN } from '../jobs/input-rules.ts';
import { turnedReason } from '../visuals/hide-regions.ts';
import { detectImage, MAX_SCREENSHOT_BYTES } from '../visuals/image.ts';
import type { ContextOptions } from './types.ts';

/** Limits of the context. Longer lists and texts are cut or refused here, so every caller sees the same ones. */
export const MAX_TEXT = 64 * 1024;
/** Logs that reach the evidence, and the size of one. More logs are cut, with a warning. */
export const MAX_LOGS = 4;
export const MAX_LOG_BYTES = 256 * 1024;
/** Test results that reach the evidence. A longer list is cut, with a warning. */
export const MAX_TESTS = 10;
/** Most entries accepted in a list of test results at all. */
export const MAX_TEST_ENTRIES = 200;
const MAX_TEST_COMMAND = 300;
const MAX_TEST_SUMMARY = 1000;
const MAX_CAPTION = 200;

export const TEST_SOURCES = ['agent', 'ci', 'user'] as const;
const TEST_KEYS = ['command', 'passed', 'summary', 'source', 'log'];

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
    // Whether the id exists is checked where the logs are read (see buildContextInputs).
    log: z.string({ error: 'needs "log" to be a log id such as "L1.120-140".' }).nullable().default(null),
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

/** Limits of a reproduction file. */
export const MAX_REPRO_STEPS = 12;
export const MAX_REPRO_TITLE = 120;
export const MAX_REPRO_ENVIRONMENT = 200;
export const MAX_REPRO_STEP_TEXT = 200;
const REPRO_KEYS = ['title', 'environment', 'steps'];
const REPRO_STEP_KEYS = ['text', 'screenshot', 'recording', 'result'];
const REPRO_HINT =
  'Expected {"title": "...", "environment": "...", "steps": [{"text": "...", "screenshot": "SS1", "result": "bug"}]}. "environment", "screenshot", "recording" and "result" are optional. A step has a screenshot or a recording, not both. "result" is one of: expected, actual, bug, fixed.';

/**
 * Check a reproduction, strictly: a typo in a field name or a wrong type must never turn into a made-up
 * step. `label` names the input in the error ("--repro-file"). Whether a screenshot or recording id was
 * supplied is checked later, in buildContextInputs, where the ids are known.
 */
export function checkRepro(value: unknown, label = 'repro'): ReproFile {
  const fail = (message: string): never => {
    throw new MergeStoryError('USAGE', `${label}: ${message}`, { hint: REPRO_HINT });
  };
  const text = (field: unknown, what: string, max: number): string => {
    if (typeof field !== 'string' || field.trim() === '') return fail(`${what} needs a non-empty text.`);
    // Hidden and reordering characters are removed, as they are from storyboard text.
    const trimmed = stripInvisible(field).trim();
    if (trimmed === '') return fail(`${what} needs a non-empty text.`);
    if (trimmed.length > max) return fail(`${what} is ${trimmed.length} characters, the limit is ${max}.`);
    return trimmed;
  };
  if (!isRecord(value)) return fail('expected a JSON object.');
  const unknown = Object.keys(value).find((key) => !REPRO_KEYS.includes(key));
  if (unknown !== undefined) return fail(`unknown field "${unknown}". Allowed: ${REPRO_KEYS.join(', ')}.`);
  const file: ReproFile = { title: text(value.title, '"title"', MAX_REPRO_TITLE), steps: [] };
  if (value.environment !== undefined)
    file.environment = text(value.environment, '"environment"', MAX_REPRO_ENVIRONMENT);
  const steps = value.steps;
  if (!Array.isArray(steps) || steps.length === 0) return fail('"steps" needs a list of 1 to 12 steps.');
  if (steps.length > MAX_REPRO_STEPS)
    return fail(`${steps.length} steps is too many (at most ${MAX_REPRO_STEPS}).`);
  for (const [index, raw] of steps.entries()) {
    const at = `step ${index + 1}`;
    if (!isRecord(raw)) return fail(`${at} is not an object.`);
    const extra = Object.keys(raw).find((key) => !REPRO_STEP_KEYS.includes(key));
    if (extra !== undefined)
      return fail(`${at} has unknown field "${extra}". Allowed: ${REPRO_STEP_KEYS.join(', ')}.`);
    const step: ReproFile['steps'][number] = { text: text(raw.text, `${at} "text"`, MAX_REPRO_STEP_TEXT) };
    if (raw.screenshot !== undefined) step.screenshot = text(raw.screenshot, `${at} "screenshot"`, 20);
    if (raw.recording !== undefined) step.recording = text(raw.recording, `${at} "recording"`, 20);
    if (step.screenshot !== undefined && step.recording !== undefined)
      return fail(`${at} has both a screenshot and a recording. Use one thumbnail for each step.`);
    if (raw.result !== undefined) {
      const result = REPRO_RESULTS.find((name) => name === raw.result);
      if (result === undefined)
        return fail(`${at} has result "${String(raw.result)}". Use one of: ${REPRO_RESULTS.join(', ')}.`);
      step.result = result;
    }
    file.steps.push(step);
  }
  return file;
}

/** The reproduction with its captures made known: each step names a screenshot or recording that was supplied to this command. */
function reproInput(
  options: ReproFile,
  screenshots: readonly { id: string }[],
  recordings: readonly { id: string }[],
): ReproInput {
  const file = checkRepro(options);
  const supplied = (kind: string, id: string | undefined, known: readonly { id: string }[], at: string) => {
    if (id === undefined) return null;
    if (known.some((item) => item.id === id)) return id;
    const have = known.map((item) => item.id).join(', ');
    const how =
      kind === 'screenshot'
        ? '--screenshot or --screenshots-dir; for the agent commands, put the file in the screenshots/ folder of the work folder'
        : '--recording; for the agent commands, put the file in the recordings/ folder of the work folder';
    throw new MergeStoryError(
      'USAGE',
      `The reproduction ${at} uses ${kind} ${id}, which was not supplied to this command${have ? ` (supplied: ${have})` : ''}.`,
      {
        hint: `Pass the ${kind} to this command first (${how}), or take the capture off the step.`,
      },
    );
  };
  return {
    title: file.title,
    environment: file.environment ?? null,
    steps: file.steps.map((step, index) => ({
      text: step.text,
      screenshotId: supplied('screenshot', step.screenshot, screenshots, `step ${index + 1}`),
      recordingId: supplied('recording', step.recording, recordings, `step ${index + 1}`),
      result: step.result ?? null,
    })),
  };
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

/** Most regions to hide for one screenshot or recording. */
export const MAX_HIDDEN_REGIONS = 20;
const REGION_KEYS = ['x', 'y', 'w', 'h', 'from', 'to'];
const REDACT_HINT =
  'Use {"SS1": [{"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.05}], "RC1": [{"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.05, "from": 12, "to": 15}]}. ' +
  'x, y, w and h are fractions (0 to 1) of the whole picture. A region of a recording is hidden for the whole clip, ' +
  'or only from "from" to "to": seconds from the start of the clip, as a player shows them.';

/**
 * Check the regions that the caller wants hidden. Strict, and it fails closed: nothing that is wrong
 * is skipped, because a skipped region would show what the caller wanted hidden. Returns the regions
 * by evidence id as given, not yet cut to the picture (see cutRegion).
 */
export function checkRedactions(value: unknown): Map<string, HiddenRegion[]> {
  const fail = (message: string): never => {
    throw new MergeStoryError('USAGE', `Hidden regions: ${message}`, { hint: REDACT_HINT });
  };
  const shown = (text: string): string => maskPrivate(text.slice(0, 40), { maskEmails: true });
  if (!isRecord(value)) return fail('expected a JSON object with a list of regions for each id.');
  const out = new Map<string, HiddenRegion[]>();
  for (const [id, list] of Object.entries(value)) {
    if (!/^(SS|RC)[1-9]\d*$/.test(id)) {
      return fail(`"${shown(id)}" is not the id of a screenshot or a recording (SS1, RC1, ...).`);
    }
    if (!Array.isArray(list)) return fail(`${id} needs a list of regions.`);
    if (list.length > MAX_HIDDEN_REGIONS) {
      return fail(`${id} has ${list.length} regions, the most is ${MAX_HIDDEN_REGIONS}.`);
    }
    out.set(
      id,
      list.map((entry: unknown, index) => {
        const at = `${id}, region ${index + 1}`;
        if (!isRecord(entry)) return fail(`${at} is not an object.`);
        const unknown = Object.keys(entry).find((key) => !REGION_KEYS.includes(key));
        if (unknown !== undefined) {
          return fail(`${at} has unknown field "${shown(unknown)}". Allowed: ${REGION_KEYS.join(', ')}.`);
        }
        const number = (key: string): number => {
          const field = entry[key];
          return typeof field === 'number' && Number.isFinite(field)
            ? field
            : fail(`${at} needs "${key}" as a number.`);
        };
        const region = { x: number('x'), y: number('y'), w: number('w'), h: number('h') };
        if (!(region.w > 0 && region.h > 0)) return fail(`${at} needs "w" and "h" above 0.`);
        const timed = Object.keys(entry).filter((key) => key === 'from' || key === 'to');
        if (timed.length === 0) return region;
        if (id.startsWith('SS')) {
          return fail(`${at} has "${timed[0]}", but a screenshot has no time. Leave out "from" and "to".`);
        }
        if (timed.length === 1) {
          return fail(`${at} has "${timed[0]}" without "${timed[0] === 'from' ? 'to' : 'from'}": give both.`);
        }
        const from = number('from');
        const to = number('to');
        if (!(from >= 0 && to > from)) return fail(`${at} needs "from" at 0 or later and "to" after "from".`);
        return { ...region, from, to };
      }),
    );
  }
  return out;
}

/**
 * Cut a region to the picture. Throws USAGE when nothing of it is left, because a region that hides
 * nothing is a mistake that must not pass.
 */
function cutRegion(region: HiddenRegion, at: string): HiddenRegion {
  // The part of [start, start + length] that lies inside 0 to 1. A region that already does is kept exactly.
  const inside = (start: number, length: number): [number, number] =>
    start >= 0 ? [start, Math.min(length, 1 - start)] : [0, Math.min(start + length, 1)];
  const [x, w] = inside(region.x, region.w);
  const [y, h] = inside(region.y, region.h);
  if (!(w > 0 && h > 0)) {
    throw new MergeStoryError('USAGE', `Hidden regions: ${at} has no part inside the picture.`, {
      hint: REDACT_HINT,
    });
  }
  return { ...region, x, y, w, h };
}

/**
 * Refuse the regions for a part of a clip that the video could not keep exactly: a part that starts after
 * the clip ends, or a clip whose pictures a player and the cut frames would show at different times
 * (clockProblem). Nothing is shifted or guessed: such a region would leave the hidden part showing.
 */
async function checkTimedRegions(
  ffprobe: string,
  id: string,
  recording: { path: string; durationSec: number },
  regions: readonly HiddenRegion[],
): Promise<void> {
  const timed = regions.filter((region) => region.from !== undefined);
  if (timed.length === 0) return;
  for (const [i, region] of regions.entries()) {
    if (region.from !== undefined && region.from >= recording.durationSec) {
      throw new MergeStoryError(
        'USAGE',
        `Hidden regions: ${id}, region ${i + 1} starts at ${region.from} s, but the clip is ${recording.durationSec.toFixed(3)} s long.`,
        { hint: REDACT_HINT },
      );
    }
  }
  const problem = await clockProblem(ffprobe, recording.path, recording.durationSec);
  if (problem !== null) {
    throw new MergeStoryError(
      'USAGE',
      `Hidden regions: ${id} (${shownName(recording.path)}) cannot hide a region for a part of the clip: ${problem}, so a player and the video would not show its pictures at the same times.`,
      { hint: 'Leave out "from" and "to" to hide the region for the whole clip.' },
    );
  }
}

/** "5.2 MB", rounded up, for a size that is over the screenshot limit. */
function megabytes(bytes: number): string {
  return `${Math.ceil((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

/**
 * Check a screenshot the way the video does: PNG or JPEG by content (never by file name), at most
 * 4 MiB and 40 megapixels. A file that the video could not draw is refused here, at once, and not
 * after narration has been paid for. Returns the absolute path. `label` names the input in errors.
 * With `hidden` (the screenshot has regions to hide), a picture that is stored turned is refused too.
 */
export async function checkScreenshotFile(
  path: string,
  cwd: string,
  label = 'Screenshot',
  hidden = false,
): Promise<string> {
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
  const image = detectImage(bytes);
  if (!image) {
    throw new MergeStoryError(
      'USAGE',
      `${label}: ${path} is not a PNG or JPEG image (up to 40 megapixels).`,
      {
        hint: 'Convert it to PNG or JPEG first. Other formats, such as WebP and GIF, are not supported.',
      },
    );
  }
  if (hidden && image.orientation !== undefined) {
    throw new MergeStoryError(
      'USAGE',
      `${label}: ${path} has hidden regions, but ${turnedReason(image.orientation)}.`,
    );
  }
  return absolute;
}

// The sequences that a terminal reads as colour, cursor or title commands.
const TERMINAL_CODES =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape character is what these match
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\x1b[()*+][0-~]|\x1b[=>]/g;

/**
 * Read a log: a regular file of at most MAX_LOG_BYTES (checked before it is read) that holds UTF-8
 * text. Line ends become "\n" and terminal colour codes are removed. A line with a very long unbroken
 * run is refused, as it is in the task and the notes: scanning it for secrets would take too long.
 */
async function readLog(path: string, cwd: string): Promise<string[]> {
  const absolute = resolve(cwd, path);
  const name = shownName(absolute);
  const refuse = (reason: string, hint?: string): MergeStoryError =>
    new MergeStoryError('USAGE', `Log ${name} cannot be used: ${reason}.`, hint ? { hint } : {});
  const info = await stat(absolute).catch(() => null);
  if (!info) throw refuse('the file was not found', 'Pass an existing text file.');
  if (!info.isFile()) throw refuse('it is not a regular file');
  const tooLarge = (size: number): MergeStoryError =>
    refuse(
      `it is ${Math.ceil(size / 1024)} KB, the limit is ${MAX_LOG_BYTES / 1024} KB`,
      'Keep only the part of the log that matters.',
    );
  if (info.size > MAX_LOG_BYTES) throw tooLarge(info.size);
  const bytes = await readFile(absolute).catch(() => null);
  if (bytes === null) throw refuse('it cannot be read');
  // The file may have grown since it was measured.
  if (bytes.length > MAX_LOG_BYTES) throw tooLarge(bytes.length);
  let text: string;
  try {
    if (bytes.includes(0)) throw new Error('NUL byte');
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw refuse('it is not a text file', 'A log must be UTF-8 text.');
  }
  const lines = text
    .replace(TERMINAL_CODES, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => stripInvisible(line, 'tab-newline'));
  if (lines[lines.length - 1] === '') lines.pop();
  if (lines.every((line) => line.trim() === '')) throw refuse('it is empty');
  const long = lines.findIndex((line) => longestRun(line) > MAX_UNBROKEN_RUN);
  if (long !== -1) {
    throw refuse(
      `line ${long + 1} has an unbroken string of more than ${MAX_UNBROKEN_RUN} characters`,
      'Remove it or keep only the relevant part. Very long strings are refused because scanning them for secrets takes too long.',
    );
  }
  return lines;
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
    warn(
      `Only the first ${maxScreenshots} screenshots are used.` +
        (maxScreenshots < 12 ? ' Raise inputs.maxScreenshots (at most 12) to use more.' : ''),
    );
  const maxRecordings = config.inputs.maxRecordings;
  if ((options?.recordings?.length ?? 0) > maxRecordings)
    warn(`Only the first ${maxRecordings} recordings are used.`);
  // Checked first: a mistake in what to hide stops the run before anything else is read.
  const redactions =
    options?.redact === undefined ? new Map<string, HiddenRegion[]>() : checkRedactions(options.redact);
  const hiddenFor = (id: string): { hidden?: HiddenRegion[] } => {
    const regions = (redactions.get(id) ?? []).map((region, i) =>
      cutRegion(region, `${id}, region ${i + 1}`),
    );
    return regions.length > 0 ? { hidden: regions } : {};
  };
  if ((options?.logs?.length ?? 0) > MAX_LOGS) warn(`Only the first ${MAX_LOGS} logs are used.`);
  const logs: LogInput[] = [];
  for (const [i, log] of (options?.logs ?? []).slice(0, MAX_LOGS).entries()) {
    const lines = await readLog(log.path, cwd);
    logs.push({
      id: `L${i + 1}`,
      path: resolve(cwd, log.path),
      caption: (log.caption ?? '').slice(0, MAX_CAPTION),
      lines,
    });
  }
  const lineCounts = new Map(logs.map((log) => [log.id, log.lines.length]));
  const tests = checkTestResults((options?.tests ?? []).slice(0, MAX_TESTS)).map((t, i) => {
    if (t.log !== null && !resolveLogId(t.log, lineCounts)) {
      const rangeOfKnownLog = lineCounts.has(/^(L[1-9]\d*)\./.exec(t.log)?.[1] ?? '');
      throw new MergeStoryError(
        'USAGE',
        `Test result ${i + 1} points at the log "${t.log.slice(0, 40)}", which is not ${rangeOfKnownLog ? 'a valid range of a log' : 'a log'} of this command.`,
        {
          hint: `Pass the file with --log, or for the agent commands put it in logs/ of the work folder. ${logs.length > 0 ? `The logs are: ${logs.map((log) => `${log.id} (${log.lines.length} lines)`).join(', ')}.` : 'No log was passed.'} A range is "L1.120-140", inside the log, at most 200 lines.`,
        },
      );
    }
    return {
      id: `T${i + 1}`,
      command: t.command.slice(0, MAX_TEST_COMMAND),
      passed: t.passed,
      summary: t.summary.slice(0, MAX_TEST_SUMMARY),
      source: t.source,
      log: t.log,
    };
  });
  const screenshots = [];
  for (const [i, shot] of (options?.screenshots ?? []).slice(0, maxScreenshots).entries()) {
    screenshots.push({
      id: `SS${i + 1}`,
      path: await checkScreenshotFile(shot.path, cwd, undefined, redactions.has(`SS${i + 1}`)),
      caption: (shot.caption ?? '').slice(0, MAX_CAPTION),
      moment: shot.moment ?? 'other',
      ...hiddenFor(`SS${i + 1}`),
    });
  }
  const recordings: RecordingInput[] = [];
  const wanted = (options?.recordings ?? []).slice(0, maxRecordings);
  // FFmpeg is looked up only when a recording was supplied.
  const ffprobe = wanted.length > 0 ? (await resolveFfmpeg(config)).ffprobe : '';
  for (const [i, rec] of wanted.entries()) {
    const id = `RC${i + 1}`;
    const checked = await checkRecording(ffprobe, rec.path, cwd, config.inputs);
    const hidden = hiddenFor(id);
    await checkTimedRegions(ffprobe, id, checked, hidden.hidden ?? []);
    recordings.push({
      id,
      caption: (rec.caption ?? '').slice(0, MAX_CAPTION),
      moment: rec.moment ?? 'other',
      ...checked,
      ...hidden,
    });
  }
  const supplied = [...screenshots, ...recordings].map((item) => item.id);
  for (const id of redactions.keys()) {
    if (!supplied.includes(id)) {
      throw new MergeStoryError(
        'USAGE',
        `Hidden regions: ${id} is not a screenshot or recording of this run.`,
        {
          hint: `This run has: ${supplied.join(', ') || 'no screenshots or recordings'}. Only the first ${maxScreenshots} screenshots and the first ${maxRecordings} recordings are used.`,
        },
      );
    }
  }
  return {
    task: normalizeContextText(options?.task, 'task description'),
    notes: normalizeContextText(options?.notes, 'implementation notes'),
    tests,
    screenshots,
    recordings,
    repro: options?.repro ? reproInput(options.repro, screenshots, recordings) : null,
    logs,
  };
}

/** Ids of the screenshots, recordings and logs that a storyboard shows. */
export function shownMedia(
  storyboard: Storyboard,
  repro: ReproInput | null = null,
): { screenshots: Set<string>; recordings: Set<string>; logs: Set<string> } {
  const screenshots = new Set<string>();
  const recordings = new Set<string>();
  const logs = new Set<string>();
  for (const { visual } of storyboard.scenes) {
    if (visual.type === 'repro') {
      for (const { step } of visual.steps) {
        const shown = repro?.steps[step - 1];
        if (shown?.screenshotId) screenshots.add(shown.screenshotId);
        if (shown?.recordingId) recordings.add(shown.recordingId);
      }
    }
    if (visual.type === 'screenshot') screenshots.add(visual.screenshotId);
    if (visual.type === 'recording') recordings.add(visual.recordingId);
    if (visual.type === 'log') logs.add(visual.logId);
    if (visual.type === 'before-after') {
      for (const panel of [visual.before, visual.after]) {
        if (panel.kind === 'screenshot' && panel.screenshotId) screenshots.add(panel.screenshotId);
        if (panel.kind === 'recording' && panel.recordingId) recordings.add(panel.recordingId);
      }
    }
  }
  return { screenshots, recordings, logs };
}

/**
 * Every evidence id that a storyboard cites or shows: the cited ids in the order of first use, then
 * the screenshots, recordings and logs that are shown and not cited. After the checks, every id in it exists.
 */
export function evidenceUsed(storyboard: Storyboard, repro: ReproInput | null = null): string[] {
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
  const shown = shownMedia(storyboard, repro);
  for (const id of [...shown.screenshots, ...shown.recordings, ...shown.logs]) ids.add(id);
  return [...ids];
}

/**
 * A warning when screenshots, recordings or logs were supplied but the storyboard does not show them all,
 * or null. The offline storyboard never uses them, which is worth saying because the person did
 * pass them on purpose.
 */
export function unusedScreenshotWarning(
  storyboard: Storyboard,
  inputs: ContextInputs,
  source: 'llm' | 'agent' | 'heuristic',
  privacy: PrivateMaskOptions,
): string | null {
  const shown = shownMedia(storyboard, inputs.repro);
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
      source !== 'heuristic'
        ? ''
        : inputs.repro
          ? ` The offline storyboard shows only the ${plural} that a step of the reproduction names: write the storyboard yourself (--storyboard) or use --llm to show the others.`
          : ` The offline storyboard never uses ${plural}: write the storyboard yourself (--storyboard) or use --llm to show them.`;
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
    sentence(
      inputs.logs.filter((log) => !shown.logs.has(log.id)),
      'The log',
      'The logs',
      'logs',
    ),
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(' ');
}
