/** Turns the context flags (task, notes, tests, screenshots) into pipeline input, reading files safely. */
import { basename, extname, resolve } from 'node:path';
import { MergeStoryError } from '../core/errors.ts';
import type { ScreenshotInput } from '../core/types.ts';
import type { ContextOptions } from '../pipeline/index.ts';
import { checkScreenshotFile, checkTestResults } from '../pipeline/inputs.ts';
import { assertNotSensitive, formatBytes, LIMITS, readJsonFile, readTextFile } from './files.ts';

/** Flags that supply context for the video. */
export interface ContextFlags {
  task?: string;
  taskFile?: string;
  notesFile?: string;
  testsFile?: string;
  screenshot?: string[];
  recording?: string[];
  /** Recordings that are already parsed. Only the agent commands set it, from their work folder. */
  recordingFiles?: NonNullable<ContextOptions['recordings']>;
}

type ScreenshotSpec = Omit<ScreenshotInput, 'id'>;

const MOMENTS = ['before', 'after'] as const;

/**
 * Parse `<path>[:<caption>[:before|after]]`. The caption may contain colons, and a Windows drive
 * letter in the path is not mistaken for a separator.
 */
export function parseScreenshotSpec(spec: string): {
  path: string;
  caption: string | null;
  moment: ScreenshotSpec['moment'];
} {
  const drive = /^[A-Za-z]:[\\/]/.test(spec) ? 2 : 0;
  const colon = spec.indexOf(':', drive);
  if (colon === -1) return { path: spec, caption: null, moment: 'other' };
  const path = spec.slice(0, colon);
  let rest = spec.slice(colon + 1);
  let moment: ScreenshotSpec['moment'] = 'other';
  const lastColon = rest.lastIndexOf(':');
  const tail =
    lastColon === -1
      ? ''
      : rest
          .slice(lastColon + 1)
          .trim()
          .toLowerCase();
  if ((MOMENTS as readonly string[]).includes(tail)) {
    moment = tail as ScreenshotSpec['moment'];
    rest = rest.slice(0, lastColon);
  }
  const caption = rest.trim();
  return { path, caption: caption === '' ? null : caption, moment };
}

/**
 * Parse the specs of one file flag (`--screenshot`, `--recording`), refuse a credentials-like name,
 * and make each path absolute, so a background worker finds the file whatever its working directory is.
 * `check` is the content check of the input; a recording is checked later, in buildContextInputs.
 */
async function resolveFiles(
  specs: string[],
  cwd: string,
  flag: string,
  check: (path: string) => Promise<string>,
): Promise<ScreenshotSpec[]> {
  const out: ScreenshotSpec[] = [];
  for (const spec of specs) {
    const parsed = parseScreenshotSpec(spec);
    if (parsed.path === '') {
      throw new MergeStoryError('USAGE', `${flag}: missing a file path in "${spec}".`, {
        hint: `Use ${flag} <path>[:<caption>[:before|after]]`,
      });
    }
    assertNotSensitive(resolve(cwd, parsed.path), flag);
    const absolute = await check(parsed.path);
    out.push({
      path: absolute,
      caption: parsed.caption ?? basename(absolute, extname(absolute)),
      moment: parsed.moment,
    });
  }
  return out;
}

/** Read everything the context flags point at. Returns undefined when no context was given. */
export async function buildContext(flags: ContextFlags, cwd: string): Promise<ContextOptions | undefined> {
  if (flags.task !== undefined && flags.taskFile !== undefined) {
    throw new MergeStoryError('USAGE', 'Use either --task or --task-file, not both.');
  }
  const context: ContextOptions = {};
  if (flags.task !== undefined) {
    const bytes = Buffer.byteLength(flags.task);
    if (bytes > LIMITS.textBytes) {
      throw new MergeStoryError(
        'USAGE',
        `--task is ${formatBytes(bytes)}, the limit is ${formatBytes(LIMITS.textBytes)}.`,
        {
          hint: 'Use --task-file with a shorter text.',
        },
      );
    }
    context.task = flags.task;
  }
  if (flags.taskFile !== undefined) {
    context.task = await readTextFile(flags.taskFile, {
      label: '--task-file',
      maxBytes: LIMITS.textBytes,
      cwd,
    });
  }
  if (flags.notesFile !== undefined) {
    context.notes = await readTextFile(flags.notesFile, {
      label: '--notes-file',
      maxBytes: LIMITS.textBytes,
      cwd,
    });
  }
  if (flags.testsFile !== undefined) {
    const json = await readJsonFile(flags.testsFile, {
      label: '--tests-file',
      maxBytes: LIMITS.testsBytes,
      cwd,
    });
    context.tests = checkTestResults(json, '--tests-file');
  }
  if (flags.screenshot && flags.screenshot.length > 0) {
    context.screenshots = await resolveFiles(flags.screenshot, cwd, '--screenshot', (path) =>
      checkScreenshotFile(path, cwd, '--screenshot'),
    );
  }
  if (flags.recording && flags.recording.length > 0) {
    context.recordings = await resolveFiles(flags.recording, cwd, '--recording', async (path) =>
      resolve(cwd, path),
    );
  }
  if (flags.recordingFiles && flags.recordingFiles.length > 0) {
    context.recordings = [...(context.recordings ?? []), ...flags.recordingFiles];
  }
  return Object.keys(context).length > 0 ? context : undefined;
}
