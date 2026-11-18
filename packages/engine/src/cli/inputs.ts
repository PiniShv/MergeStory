/** Turns the context flags (task, notes, tests, screenshots) into pipeline input, reading files safely. */
import { lstat, readdir, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { MergeStoryError } from '../core/errors.ts';
import type { ScreenshotInput } from '../core/types.ts';
import type { ContextOptions } from '../pipeline/index.ts';
import { checkRepro, checkScreenshotFile, checkTestResults } from '../pipeline/inputs.ts';
import { assertNotSensitive, formatBytes, LIMITS, readJsonFile, readTextFile } from './files.ts';

/** Flags that supply context for the video. */
export interface ContextFlags {
  task?: string;
  taskFile?: string;
  notesFile?: string;
  testsFile?: string;
  reproFile?: string;
  /** How errors name the reproduction file. The agent commands set it to the name in the work folder. */
  reproLabel?: string;
  screenshot?: string[];
  recording?: string[];
  /** A folder of screenshots (`--screenshots-dir`). */
  screenshotsDir?: string;
  /** Screenshots and recordings that are already parsed. Only the agent commands set them, from their work folder. */
  screenshotFiles?: NonNullable<ContextOptions['screenshots']>;
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

/** What a folder of captures holds: the endings of its files and the words that its messages use. */
export interface CaptureKind {
  noun: string;
  endings: readonly string[];
  /** A file name for the example in the hint. */
  example: string;
}
export const SCREENSHOT_KIND: CaptureKind = {
  noun: 'screenshot',
  endings: ['.png', '.jpg', '.jpeg'],
  example: 'page.png',
};
export const RECORDING_KIND: CaptureKind = {
  noun: 'recording',
  // The two kinds of file that the probe reads: MP4 or QuickTime, and WebM or Matroska.
  endings: ['.mp4', '.m4v', '.mov', '.webm', '.mkv'],
  example: 'clip.mp4',
};
const CAPTIONS_FILE = 'captions.json';

/**
 * The captures in a folder: every file whose name ends as `kind` says (any letter case), sorted by
 * name, so every command numbers them the same way. A folder inside it is ignored. `captions.json`
 * may hold {"clip.mp4": {"caption": "...", "side": "before"}}. A caption goes in this file, not in a
 * flag, because it may contain a colon. The content of a file is checked later, with its input.
 * A link inside the folder is refused. A folder that is not there gives an empty list, and so does one
 * that cannot be read, unless `strict` is set (then it is a USAGE error). `nameLabel` is how the
 * message about a credentials-like picture name calls the folder; it defaults to the captions file.
 */
export async function readCaptureFolder(
  folder: string,
  kind: CaptureKind,
  options: { strict?: boolean; nameLabel?: string } = {},
): Promise<ScreenshotSpec[]> {
  const names = await readdir(folder).catch((err: unknown) => {
    if (options.strict) {
      throw new MergeStoryError(
        'USAGE',
        `${options.nameLabel ?? basename(folder)}: the folder could not be read.`,
        {
          hint: 'Check that you may read the folder.',
          cause: err,
        },
      );
    }
    return null;
  });
  if (names === null) return [];
  const noLinks = async (name: string): Promise<void> => {
    if ((await lstat(join(folder, name)).catch(() => null))?.isSymbolicLink()) {
      throw new MergeStoryError('USAGE', `${options.nameLabel ?? basename(folder)}: ${name} is a link.`, {
        hint: 'Put the real file in the folder. Links are not followed.',
      });
    }
  };
  const candidates = names
    .filter((name) => kind.endings.includes(extname(name).toLowerCase()))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const files: string[] = [];
  for (const name of candidates) {
    await noLinks(name);
    if ((await stat(join(folder, name)).catch(() => null))?.isFile()) files.push(name);
  }
  if (names.includes(CAPTIONS_FILE)) await noLinks(CAPTIONS_FILE);
  const label = `${basename(folder)}/${CAPTIONS_FILE}`;
  const bad = (message: string): MergeStoryError =>
    new MergeStoryError('USAGE', `${label}: ${message}`, {
      hint: `Use {"${kind.example}": {"caption": "What it shows", "side": "before"}}. "side" is before or after, or left out.`,
    });
  const captions = new Map<string, { caption: string | null; moment: 'before' | 'after' | 'other' }>();
  if (names.includes(CAPTIONS_FILE)) {
    const json = await readJsonFile(join(folder, CAPTIONS_FILE), {
      label,
      maxBytes: LIMITS.testsBytes,
      cwd: folder,
    });
    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
      throw bad(`expected a JSON object with one entry per ${kind.noun} file.`);
    }
    for (const [file, entry] of Object.entries(json)) {
      if (!files.includes(file))
        throw bad(
          `"${file}" is not a ${kind.noun} (${kind.endings.join(', ')}) in the ${basename(folder)} folder.`,
        );
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw bad(`the entry for "${file}" is not an object.`);
      }
      const { caption, side, ...rest } = entry as Record<string, unknown>;
      const unknown = Object.keys(rest)[0];
      if (unknown !== undefined)
        throw bad(`"${file}" has unknown field "${unknown}". Allowed: caption, side.`);
      if (caption !== undefined && typeof caption !== 'string') {
        throw bad(`the caption of "${file}" is not a string.`);
      }
      if (side !== undefined && side !== null && side !== 'before' && side !== 'after') {
        throw bad(`the side of "${file}" is not "before" or "after".`);
      }
      captions.set(file, {
        caption: caption?.trim() || null,
        moment: side ?? 'other',
      });
    }
  }
  return files.map((file) => {
    const path = join(folder, file);
    assertNotSensitive(path, options.nameLabel ?? label);
    const entry = captions.get(file);
    return {
      path,
      caption: entry?.caption ?? basename(file, extname(file)),
      moment: entry?.moment ?? 'other',
    };
  });
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
  if (flags.reproFile !== undefined) {
    const json = await readJsonFile(flags.reproFile, {
      label: flags.reproLabel ?? '--repro-file',
      maxBytes: LIMITS.reproBytes,
      cwd,
    });
    context.repro = checkRepro(json, flags.reproLabel ?? '--repro-file');
  }
  if (flags.screenshot && flags.screenshot.length > 0) {
    context.screenshots = await resolveFiles(flags.screenshot, cwd, '--screenshot', (path) =>
      checkScreenshotFile(path, cwd, '--screenshot'),
    );
  }
  if (flags.screenshotsDir !== undefined) {
    if (flags.screenshotsDir.trim() === '') {
      throw new MergeStoryError('USAGE', '--screenshots-dir: missing a folder path.', {
        hint: 'Use --screenshots-dir <folder>',
      });
    }
    const folder = resolve(cwd, flags.screenshotsDir);
    if (!(await stat(folder).catch(() => null))?.isDirectory()) {
      throw new MergeStoryError('USAGE', `--screenshots-dir: ${flags.screenshotsDir} is not a folder.`, {
        hint: 'Pass the path of an existing folder with PNG or JPEG files.',
      });
    }
    const found = await readCaptureFolder(folder, SCREENSHOT_KIND, {
      strict: true,
      nameLabel: '--screenshots-dir',
    });
    for (const shot of found) await checkScreenshotFile(shot.path, cwd, '--screenshots-dir');
    context.screenshots = [...(context.screenshots ?? []), ...found];
  }
  if (flags.screenshotFiles && flags.screenshotFiles.length > 0) {
    context.screenshots = [...(context.screenshots ?? []), ...flags.screenshotFiles];
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
