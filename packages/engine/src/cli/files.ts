/** Safe reading of the files that flags point at: size caps, regular files only, no credential files. */
import { open } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { MergeStoryError } from '../core/errors.ts';
import { isSensitivePath } from '../core/secrets.ts';

/** Size limits for input files, in bytes. */
export const LIMITS = {
  /** --task-file and --notes-file */
  textBytes: 64 * 1024,
  /** --tests-file */
  testsBytes: 256 * 1024,
  /** --storyboard */
  storyboardBytes: 1024 * 1024,
  /** theme init --brand */
  brandBytes: 1024 * 1024,
} as const;

/** "64 KB", "1.5 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round((bytes / 1024) * 10) / 10} KB`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

function describeFsError(err: unknown, label: string, path: string): MergeStoryError {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') {
    return new MergeStoryError('USAGE', `${label}: file not found: ${path}`, {
      hint: 'Check the path. Relative paths are read from the current directory.',
    });
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new MergeStoryError('USAGE', `${label}: permission denied: ${path}`);
  }
  if (code === 'EISDIR') return new MergeStoryError('USAGE', `${label}: ${path} is a directory, not a file.`);
  return new MergeStoryError('USAGE', `${label}: cannot read ${path}: ${(err as Error).message}`, {
    cause: err,
  });
}

/** Refuse files that look like credentials: their content would end up in a video or at a provider. */
export function assertNotSensitive(absolutePath: string, label: string): void {
  if (!isSensitivePath(absolutePath.replace(/\\/g, '/'))) return;
  throw new MergeStoryError(
    'USAGE',
    `${label}: refusing to read ${basename(absolutePath)} because it looks like a credentials file.`,
    { hint: 'Copy the text you want to share into a plain file and pass that instead.' },
  );
}

/** How to read a file named by a flag. */
export interface ReadFileOptions {
  /** Flag name for error messages, for example "--task-file". */
  label: string;
  maxBytes: number;
  cwd: string;
}

/** Read a UTF-8 text file of at most `maxBytes`. Only regular files are read, never directories or devices. */
export async function readTextFile(path: string, options: ReadFileOptions): Promise<string> {
  const { label, maxBytes } = options;
  const absolute = resolve(options.cwd, path);
  assertNotSensitive(absolute, label);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(absolute, 'r');
  } catch (err) {
    throw describeFsError(err, label, path);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new MergeStoryError('USAGE', `${label}: ${path} is not a regular file.`);
    const tooLarge = (size: number): MergeStoryError =>
      new MergeStoryError(
        'USAGE',
        `${label}: ${path} is ${formatBytes(size)}, the limit is ${formatBytes(maxBytes)}.`,
        {
          hint: 'Use a shorter file with only the relevant part.',
        },
      );
    if (info.size > maxBytes) throw tooLarge(info.size);
    // Read one byte more than allowed, in case the file grew after the check.
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
    if (bytesRead > maxBytes) throw tooLarge(bytesRead);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) throw new MergeStoryError('USAGE', `${label}: ${path} is not a text file.`);
    const text = bytes.toString('utf8');
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch (err) {
    if (err instanceof MergeStoryError) throw err;
    throw describeFsError(err, label, path);
  } finally {
    await handle.close();
  }
}

/** Read and parse a JSON file. `onInvalid` picks the error code for malformed JSON. */
export async function readJsonFile(
  path: string,
  options: ReadFileOptions & { invalidCode?: 'USAGE' | 'STORYBOARD_INVALID' },
): Promise<unknown> {
  const text = await readTextFile(path, options);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new MergeStoryError(
      options.invalidCode ?? 'USAGE',
      `${options.label}: ${path} is not valid JSON: ${(err as Error).message}`,
      {
        cause: err,
      },
    );
  }
}
