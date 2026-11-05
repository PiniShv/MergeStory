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

/** Check each screenshot the way the video does (see checkScreenshotFile), and make its path absolute. */
async function resolveScreenshots(specs: string[], cwd: string): Promise<ScreenshotSpec[]> {
  const out: ScreenshotSpec[] = [];
  for (const spec of specs) {
    const parsed = parseScreenshotSpec(spec);
    if (parsed.path === '') {
      throw new MergeStoryError('USAGE', `--screenshot: missing a file path in "${spec}".`, {
        hint: 'Use --screenshot <path>[:<caption>[:before|after]]',
      });
    }
    assertNotSensitive(resolve(cwd, parsed.path), '--screenshot');
    // Absolute, so a background worker finds the file whatever its working directory is.
    const absolute = await checkScreenshotFile(parsed.path, cwd, '--screenshot');
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
    context.screenshots = await resolveScreenshots(flags.screenshot, cwd);
  }
  return Object.keys(context).length > 0 ? context : undefined;
}
